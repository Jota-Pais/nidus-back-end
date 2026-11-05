import type { RequestHandler } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { criarApp } from '../../app.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { alocarSolicitacao, criarSolicitacao, listarSolicitacoes } from './demanda.service.ts'
import type { NovaSolicitacao } from './demanda.service.ts'

// O banco aqui e de mentira: cada consulta devolve o que o teste deixou em 'banco', e o que
// seria gravado fica em 'banco.gravado'. Nada sai daqui

type Solicitacao = { id: number; status: string; remessas: unknown[] }
type Projeto = { id: number; numero: string; idUsuarioResponsavel: number; situacao: string; dtVigenciaFim: Date }
type Gravacao = { data: Record<string, unknown> }

const banco = vi.hoisted(() => ({
  solicitacao: null as Solicitacao | null,
  lista: [] as unknown[],
  consultaDaLista: undefined as unknown,
  projetos: [] as Projeto[],
  gravado: { solicitacao: [] as Record<string, unknown>[], remessa: [] as Record<string, unknown>[] },
}))

vi.mock('../../shared/prisma.ts', () => {
  const tx = {
    solicitacao: {
      create: async ({ data }: Gravacao) => {
        banco.gravado.solicitacao.push(data)
        return { id: 42, ...data }
      },
    },
    remessa: {
      create: async ({ data }: Gravacao) => {
        banco.gravado.remessa.push(data)
        return data
      },
    },
    historico: { create: async () => ({}) },
  }

  return {
    prisma: {
      solicitacao: {
        findUnique: async () => banco.solicitacao,
        findMany: async (consulta: unknown) => {
          banco.consultaDaLista = consulta
          return banco.lista
        },
      },
      projeto: {
        findUnique: async ({ where }: { where: { numero: string } }) =>
          banco.projetos.find((projeto) => projeto.numero === where.numero) ?? null,
      },
      linhagem: { findUnique: async () => ({ id: 3, idEspecie: 1, nome: 'Wistar', ativa: true }) },
      historico: { findMany: async () => [] },
      $transaction: async (passos: (cliente: typeof tx) => Promise<unknown>) => passos(tx),
    },
  }
})

const pesquisadora: UsuarioDaSessao = { id: 1, nome: 'Paula Lima', email: 'paula@ufsc.br', perfil: 'pesquisador' }
const tecnica: UsuarioDaSessao = { id: 2, nome: 'Ana Souza', email: 'tecnico@ufsc.br', perfil: 'tecnico' }
const itens = [{ idParto: 1, machos: 1, femeas: 0 }]

const agora = new Date('2026-10-30T12:00:00.000Z')
const PROTOCOLO = '23080.001234/2026-74'

const projetoDaPaula: Projeto = {
  id: 9,
  numero: PROTOCOLO,
  idUsuarioResponsavel: pesquisadora.id,
  situacao: 'V',
  dtVigenciaFim: new Date('2026-12-31T00:00:00.000Z'),
}

const pedido: NovaSolicitacao = {
  nomePesquisador: 'Paula Lima',
  protocoloCeua: PROTOCOLO,
  idLinhagem: 3,
  machos: 5,
  femeas: 0,
  qualquer: 10,
  idadeMin: 21,
  idadeMax: 40,
  dataEntrega: '2026-12-15',
  cronograma: 'unica',
  observacoes: 'Machos do mesmo parto.',
}

beforeEach(() => {
  banco.projetos = [projetoDaPaula]
  banco.gravado = { solicitacao: [], remessa: [] }
})

describe('protocolo CEUA do pedido', () => {
  it('protocolo que nao existe e 409 PROJETO_INVALIDO no campo protocoloCeua', async () => {
    const mensagem = 'Protocolo CEUA nao encontrado. Confira o numero ou fale com o bioterio.'
    const comoPesquisadora: RequestHandler = (req, _res, next) => {
      req.usuario = pesquisadora
      next()
    }

    const resposta = await request(criarApp({ autenticacao: comoPesquisadora }))
      .post('/api/solicitacoes')
      .send({ ...pedido, protocoloCeua: '23080.999999/2026-38', dataEntrega: '2099-01-01' })

    expect(resposta.status).toBe(409)
    expect(resposta.body.erro).toEqual({
      codigo: 'PROJETO_INVALIDO',
      mensagem,
      campos: { protocoloCeua: mensagem },
    })
    expect(banco.gravado.solicitacao).toEqual([])
  })

  it('projeto de outra pessoa e projeto vencido tambem caem no campo protocoloCeua', async () => {
    banco.projetos = [{ ...projetoDaPaula, idUsuarioResponsavel: 7 }]
    await expect(criarSolicitacao(pedido, pesquisadora, agora)).rejects.toMatchObject({
      status: 409,
      codigo: 'PROJETO_INVALIDO',
      extras: { campos: { protocoloCeua: 'Este projeto CEUA nao esta no seu nome.' } },
    })

    banco.projetos = [{ ...projetoDaPaula, dtVigenciaFim: new Date('2026-10-29T00:00:00.000Z') }]
    await expect(criarSolicitacao(pedido, pesquisadora, agora)).rejects.toMatchObject({
      status: 409,
      codigo: 'PROJETO_INVALIDO',
      extras: { campos: { protocoloCeua: `O projeto ${PROTOCOLO} nao esta vigente.` } },
    })
  })

  it('o tecnico pede com o projeto de outra pessoa', async () => {
    await expect(criarSolicitacao(pedido, tecnica, agora)).resolves.toEqual({ id: 42 })
  })
})

describe('pedido gravado', () => {
  it('grava o nome digitado, a faixa, o qualquer e as observacoes no projeto do protocolo', async () => {
    await expect(criarSolicitacao(pedido, pesquisadora, agora)).resolves.toEqual({ id: 42 })

    expect(banco.gravado.solicitacao).toEqual([
      expect.objectContaining({
        idProjeto: projetoDaPaula.id,
        idUsuarioSolicitante: pesquisadora.id,
        nomePesquisador: 'Paula Lima',
        qtdM: 5,
        qtdF: 0,
        qtdQualquer: 10,
        idadeMinDias: 21,
        idadeMaxDias: 40,
        regime: 'U',
        status: 'EN',
        observacoes: 'Machos do mesmo parto.',
      }),
    ])
    expect(banco.gravado.remessa).toEqual([
      expect.objectContaining({
        idSolicitacao: 42,
        sequencia: 1,
        qtdMPrevista: 5,
        qtdFPrevista: 0,
        qtdQualquerPrevista: 10,
      }),
    ])
  })

  it('pedido so de qualquer sexo nao grava a remessa com zero animais', async () => {
    // o banco recusa remessa com machos + femeas + qualquer = 0
    await criarSolicitacao({ ...pedido, machos: 0, femeas: 0, qualquer: 7 }, pesquisadora, agora)

    expect(banco.gravado.remessa).toEqual([
      expect.objectContaining({ qtdMPrevista: 0, qtdFPrevista: 0, qtdQualquerPrevista: 7 }),
    ])
  })
})

describe('lista de solicitacoes', () => {
  const linha = {
    id: 5,
    nomePesquisador: 'Paula Lima',
    qtdM: 5,
    qtdF: 0,
    qtdQualquer: 10,
    idadeMinDias: 21,
    idadeMaxDias: 40,
    dtDesejada: new Date('2026-12-15T00:00:00.000Z'),
    regime: 'U',
    status: 'EN',
    observacoes: 'Machos do mesmo parto.',
    projeto: { numero: PROTOCOLO },
    usuarioSolicitante: { email: 'paula@ufsc.br' },
    especie: { nome: 'Rato' },
    linhagem: { id: 3, nome: 'Wistar' },
  }

  it('cada item traz o pesquisador digitado, o e-mail da conta e as observacoes', async () => {
    banco.lista = [linha, { ...linha, id: 4, observacoes: null }]

    const { solicitacoes } = await listarSolicitacoes(tecnica)

    expect(solicitacoes[0]).toEqual({
      id: 5,
      protocoloCeua: PROTOCOLO,
      pesquisador: 'Paula Lima',
      email: 'paula@ufsc.br',
      especie: 'rato',
      idLinhagem: 3,
      linhagem: 'Wistar',
      machos: 5,
      femeas: 0,
      qualquer: 10,
      idadeMin: 21,
      idadeMax: 40,
      dataEntrega: '2026-12-15',
      cronograma: 'unica',
      observacoes: 'Machos do mesmo parto.',
      status: 'enviada',
      motivoRecusa: null,
    })
    expect(solicitacoes[1]?.observacoes).toBeNull()
  })

  it('o pesquisador so ve as proprias; o tecnico ve todas', async () => {
    banco.lista = []

    await listarSolicitacoes(pesquisadora)
    expect(banco.consultaDaLista).toMatchObject({ where: { idUsuarioSolicitante: pesquisadora.id } })

    // 'toMatchObject({ where: {} })' passaria com qualquer filtro: o where do tecnico tem de ser vazio
    await listarSolicitacoes(tecnica)
    expect((banco.consultaDaLista as { where: unknown }).where).toEqual({})
  })
})

describe('alocacao so de solicitacao enviada', () => {
  it.each(['AP', 'AT', 'CA'])('solicitacao com status %s nao recebe caixas', async (status) => {
    banco.solicitacao = { id: 7, status, remessas: [] }

    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toEqual(
      expect.objectContaining({ status: 409, codigo: 'SOLICITACAO_JA_ALOCADA' }),
    )
  })

  it('a aprovada diz que ja foi alocada; os outros status, que nao aguardam alocacao', async () => {
    banco.solicitacao = { id: 7, status: 'AP', remessas: [] }
    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toThrow(
      'A solicitacao #7 ja foi alocada.',
    )

    banco.solicitacao = { id: 7, status: 'AT', remessas: [] }
    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toThrow(
      'A solicitacao #7 nao esta aguardando alocacao.',
    )
  })

  it('a enviada passa da conferencia do status', async () => {
    // Sem remessa, para no 404 da remessa, que vem depois da conferencia - e antes de
    // qualquer parto ser lido
    banco.solicitacao = { id: 7, status: 'EN', remessas: [] }

    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toEqual(
      expect.objectContaining({ status: 404, codigo: 'NAO_ENCONTRADO' }),
    )
  })
})
