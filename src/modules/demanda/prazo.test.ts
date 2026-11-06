import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { listarSolicitacoes, MOTIVO_SEM_RESPOSTA, recusarSemResposta } from './demanda.service.ts'

const banco = vi.hoisted(() => ({
  vencidas: [] as { id: number; idUsuarioSolicitante: number }[],
  consultaDasVencidas: undefined as unknown,
  lista: [] as unknown[],
  decisoes: [] as unknown[],
  jaDecididas: [] as number[],
  historico: [] as Record<string, unknown>[],
  avisos: [] as { email: string; dataPedido: string; motivo: string | undefined }[],
}))

const pedido = (id: number) => ({
  id,
  idUsuarioSolicitante: 30 + id,
  status: 'EN',
  qtdM: 2,
  qtdF: 0,
  qtdQualquer: 0,
  idadeMinDias: 28,
  idadeMaxDias: 28,
  dtDesejada: new Date('2026-12-15T00:00:00.000Z'),
  dtCriacao: new Date('2026-11-01T02:00:00.000Z'),
  projeto: { numero: '23080.001234/2026-11' },
  linhagem: { nome: 'Wistar' },
  usuarioSolicitante: { email: `pessoa${id}@ufsc.br` },
})

vi.mock('../../shared/email.ts', () => ({
  avisarPedidoDecidido: async (email: string, pedido: { dataPedido: string }, motivo?: string) => {
    banco.avisos.push({ email, dataPedido: pedido.dataPedido, motivo })
  },
}))

vi.mock('../../shared/prisma.ts', () => {
  const tx = {
    solicitacao: {
      updateMany: async ({ where }: { where: { id: number } }) => ({
        count: banco.jaDecididas.includes(where.id) ? 0 : 1,
      }),
    },
    historico: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        banco.historico.push(data)
        return data
      },
    },
  }

  return {
    prisma: {
      solicitacao: {
        findMany: async (consulta: { select?: unknown }) => {
          if (consulta.select) {
            banco.consultaDasVencidas = consulta
            return banco.vencidas
          }
          return banco.lista
        },
        findUnique: async ({ where }: { where: { id: number } }) => pedido(where.id),
      },
      historico: { findMany: async () => banco.decisoes },
      $transaction: async (passos: (cliente: typeof tx) => Promise<unknown>) => passos(tx),
    },
  }
})

beforeEach(() => {
  banco.vencidas = []
  banco.lista = []
  banco.decisoes = []
  banco.jaDecididas = []
  banco.historico = []
  banco.avisos = []
})

const agora = new Date('2026-11-20T15:00:00.000Z')

describe('pedido sem resposta em 14 dias', () => {
  it('procura so os enviados criados ate 14 dias antes de agora', async () => {
    await recusarSemResposta(agora)

    expect(banco.consultaDasVencidas).toMatchObject({
      where: { status: 'EN', dtCriacao: { lte: new Date('2026-11-06T15:00:00.000Z') } },
    })
  })

  it('recusa, guarda o motivo no historico e avisa quem pediu por e-mail', async () => {
    banco.vencidas = [{ id: 1, idUsuarioSolicitante: 31 }]

    expect(await recusarSemResposta(agora)).toBe(1)

    expect(banco.historico).toEqual([
      expect.objectContaining({
        idUsuario: 31,
        idEntidade: 1,
        acao: 'recusa',
        dados: { motivo: MOTIVO_SEM_RESPOSTA },
      }),
    ])
    await vi.waitFor(() =>
      expect(banco.avisos).toEqual([
        { email: 'pessoa1@ufsc.br', dataPedido: '2026-10-31', motivo: MOTIVO_SEM_RESPOSTA },
      ]),
    )
  })

  it('pula o pedido que alguem decidiu no meio do caminho, sem e-mail', async () => {
    banco.vencidas = [
      { id: 1, idUsuarioSolicitante: 31 },
      { id: 2, idUsuarioSolicitante: 32 },
    ]
    banco.jaDecididas = [1]

    expect(await recusarSemResposta(agora)).toBe(1)
    await vi.waitFor(() => expect(banco.avisos.map((aviso) => aviso.email)).toEqual(['pessoa2@ufsc.br']))
  })
})

describe('datas na lista de solicitacoes', () => {
  const tecnica: UsuarioDaSessao = { id: 9, nome: 'Tecnica', email: 'tec@ufsc.br', perfil: 'tecnico' }
  const linha = (id: number, status: string) => ({
    ...pedido(id),
    status,
    nomePesquisador: 'Paula',
    regime: 'U',
    observacoes: null,
    dtCriacao: new Date('2026-11-01T02:00:00.000Z'),
    especie: { nome: 'Rato' },
    linhagem: { id: 3, nome: 'Wistar' },
  })

  it('traz o dia do pedido em Brasilia, o prazo do enviado e as datas de aceite e recusa', async () => {
    banco.lista = [linha(1, 'EN'), linha(2, 'AP'), linha(3, 'RE')]
    banco.decisoes = [
      { idEntidade: 2, acao: 'alocacao', dtHora: new Date('2026-11-03T13:00:00.000Z'), dados: {} },
      {
        idEntidade: 3,
        acao: 'recusa',
        dtHora: new Date('2026-11-04T13:00:00.000Z'),
        dados: { motivo: 'Sem Wistar' },
      },
    ]

    const { solicitacoes } = await listarSolicitacoes(tecnica)
    const datas = solicitacoes.map(({ dataSolicitacao, prazoResposta, dataAceite, dataRecusa }) => ({
      dataSolicitacao,
      prazoResposta,
      dataAceite,
      dataRecusa,
    }))

    expect(datas).toEqual([
      { dataSolicitacao: '2026-10-31', prazoResposta: '2026-11-14', dataAceite: null, dataRecusa: null },
      { dataSolicitacao: '2026-10-31', prazoResposta: null, dataAceite: '2026-11-03', dataRecusa: null },
      { dataSolicitacao: '2026-10-31', prazoResposta: null, dataAceite: null, dataRecusa: '2026-11-04' },
    ])
    expect(solicitacoes[2]?.motivoRecusa).toBe('Sem Wistar')
  })
})
