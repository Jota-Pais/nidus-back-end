import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alterarEstante, cadastrarEstante, listarEstantes, removerEstante } from './infra.service.ts'
import type { NovaEstante } from './infra.service.ts'

// Cadastro, edicao e remocao de estante, com o banco de mentira: o que importa e o que cada
// regra consulta e grava

type Linha = Record<string, unknown>
type Formato = { id: number; nome: string; faces: number; linhas: number; colunas: number; ativo: boolean }

const banco = vi.hoisted(() => ({
  salas: [] as { id: number; nome: string; ativa: boolean }[],
  formatos: [] as Formato[],
  estante: null as Linha | null,
  mesmoNumero: null as Linha | null,
  caixas: 0,
  /** as caixas ativas que a troca de formato acha fora do formato novo */
  fora: [] as { codigo: string }[],
  numeroConsultado: null as Linha | null,
  caixasConsultadas: null as Linha | null,
  foraConsultadas: null as Linha | null,
  /** o que a transacao fez, em ordem */
  passos: [] as string[],
  /** o SQL de cada trava, com os valores */
  travas: [] as { sql: string; valores: unknown[] }[],
  gravado: null as Linha | null,
  historico: [] as Linha[],
}))

vi.mock('../../shared/prisma.ts', () => {
  const nomeDaSala = (idSala: unknown) => ({
    nome: banco.salas.find((sala) => sala.id === idSala)?.nome ?? '?',
  })
  const doFormato = (idFormato: unknown) => {
    const formato = banco.formatos.find((umFormato) => umFormato.id === idFormato)
    return { nome: formato?.nome ?? '?', faces: formato?.faces ?? 0, linhas: formato?.linhas ?? 0, colunas: formato?.colunas ?? 0 }
  }
  const comSalaEFormato = (linha: Linha) => ({ ...linha, sala: nomeDaSala(linha.idSala), formato: doFormato(linha.idFormato) })

  return {
    prisma: {
      sala: {
        findFirst: async ({ where }: { where: { id: number } }) =>
          banco.salas.find((sala) => sala.id === where.id && sala.ativa) ?? null,
      },
      formato: {
        findFirst: async ({ where }: { where: { id: number } }) =>
          banco.formatos.find((formato) => formato.id === where.id && formato.ativo) ?? null,
      },
      estante: {
        // a mesma consulta serve a "estante ativa pelo id" e a "numero ja usado na sala"
        findFirst: async ({ where }: { where: Linha }) => {
          if ('numeroVisivel' in where) {
            banco.numeroConsultado = where
            return banco.mesmoNumero
          }
          return banco.estante
        },
        findMany: async () => (banco.estante === null ? [] : [banco.estante]),
      },
      caixa: {
        count: async ({ where }: { where: Linha }) => {
          banco.caixasConsultadas = where
          return banco.caixas
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: async (partes: TemplateStringsArray, ...valores: unknown[]) => {
            banco.passos.push('trava')
            banco.travas.push({ sql: partes.join('?').replace(/\s+/g, ' ').trim(), valores })
            return []
          },
          caixa: {
            findMany: async ({ where }: { where: Linha }) => {
              banco.passos.push('confere')
              banco.foraConsultadas = where
              return banco.fora
            },
          },
          estante: {
            create: async ({ data }: { data: Linha }) => {
              banco.passos.push('grava')
              banco.gravado = data
              return comSalaEFormato({ id: 9, ...data })
            },
            update: async ({ data }: { data: Linha }) => {
              banco.passos.push('grava')
              banco.gravado = data
              return comSalaEFormato({ ...banco.estante, ...data })
            },
          },
          historico: {
            create: async ({ data }: { data: Linha }) => {
              banco.historico.push(data)
              return {}
            },
          },
        }),
    },
  }
})

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

const nova: NovaEstante = { idSala: 2, idFormato: 2, numeroVisivel: 'E-05' }

beforeEach(() => {
  banco.salas = [
    { id: 1, nome: 'Sala 1', ativa: true },
    { id: 2, nome: 'Sala 2', ativa: true },
    { id: 3, nome: 'Sala velha', ativa: false },
  ]
  banco.formatos = [
    { id: 1, nome: 'ALESCO Modelo 1', faces: 2, linhas: 8, colunas: 8, ativo: true },
    { id: 2, nome: 'ALESCO Modelo 2', faces: 2, linhas: 5, colunas: 5, ativo: true },
    { id: 3, nome: 'TECNIPLAST Modelo 1', faces: 2, linhas: 8, colunas: 7, ativo: true },
    { id: 4, nome: 'Formato removido', faces: 1, linhas: 4, colunas: 4, ativo: false },
  ]
  banco.estante = {
    id: 4,
    idSala: 1,
    idFormato: 1,
    numeroVisivel: 'E-01',
    sala: { nome: 'Sala 1' },
    formato: { nome: 'ALESCO Modelo 1', faces: 2, linhas: 8, colunas: 8 },
  }
  banco.mesmoNumero = null
  banco.caixas = 0
  banco.fora = []
  banco.numeroConsultado = null
  banco.caixasConsultadas = null
  banco.foraConsultadas = null
  banco.passos = []
  banco.travas = []
  banco.gravado = null
  banco.historico = []
})

describe('lista de estantes', () => {
  it('cada estante traz o formato pelo nome, e as medidas sao as dele', async () => {
    await expect(listarEstantes()).resolves.toEqual({
      estantes: [
        {
          id: 4,
          idSala: 1,
          sala: 'Sala 1',
          idFormato: 1,
          formato: 'ALESCO Modelo 1',
          numeroVisivel: 'E-01',
          faces: 2,
          linhas: 8,
          colunas: 8,
        },
      ],
    })
  })
})

describe('cadastro de estante', () => {
  it('grava a sala, o formato e o numero, e devolve as medidas do formato', async () => {
    await expect(cadastrarEstante(nova, 1)).resolves.toEqual({
      id: 9,
      idSala: 2,
      sala: 'Sala 2',
      idFormato: 2,
      formato: 'ALESCO Modelo 2',
      numeroVisivel: 'E-05',
      faces: 2,
      linhas: 5,
      colunas: 5,
    })
    expect(banco.gravado).toEqual({ idSala: 2, idFormato: 2, numeroVisivel: 'E-05' })
    expect(banco.historico).toEqual([
      expect.objectContaining({
        entidade: 'estante',
        acao: 'cadastro',
        descricao: 'Estante E-05 cadastrada na Sala 2',
        dados: expect.objectContaining({ idFormato: 2, formato: 'ALESCO Modelo 2' }),
      }),
    ])
  })

  it('sala removida e campo invalido', async () => {
    await expect(cadastrarEstante({ ...nova, idSala: 3 }, 1)).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.gravado).toBeNull()
  })

  it.each([
    ['removido', 4],
    ['inexistente', 99],
  ])('formato %s e campo invalido, com a mensagem no idFormato', async (_caso, idFormato) => {
    await expect(cadastrarEstante({ ...nova, idFormato }, 1)).rejects.toEqual(
      expect.objectContaining({ status: 400, codigo: 'VALIDACAO', extras: { campos: { idFormato: 'Escolha um formato cadastrado.' } } }),
    )
    expect(banco.gravado).toBeNull()
  })

  it('numero ja usado na sala e recusado, com o nome da sala', async () => {
    banco.mesmoNumero = { id: 5 }

    await expect(cadastrarEstante(nova, 1)).rejects.toThrow('Já existe a estante E-05 na sala Sala 2.')
    expect(banco.numeroConsultado).toEqual({ idSala: 2, numeroVisivel: 'E-05', ativa: true })
  })
})

describe('edicao de estante', () => {
  it('muda numero e sala, e confere o numero na sala de destino sem contar a propria estante', async () => {
    await expect(alterarEstante(4, { numeroVisivel: 'E-09', idSala: 2 }, 1)).resolves.toMatchObject({
      numeroVisivel: 'E-09',
      idSala: 2,
      sala: 'Sala 2',
    })
    expect(banco.numeroConsultado).toEqual({ idSala: 2, numeroVisivel: 'E-09', ativa: true, id: { not: 4 } })
    expect(banco.historico[0]).toMatchObject({
      acao: 'alteracao',
      dados: {
        antes: { numeroVisivel: 'E-01', sala: 'Sala 1' },
        depois: { numeroVisivel: 'E-09', sala: 'Sala 2' },
      },
    })
  })

  it('sem trocar o formato, nao trava nem confere as caixas, e grava o mesmo formato', async () => {
    await alterarEstante(4, { numeroVisivel: 'E-07' }, 1)

    expect(banco.passos).toEqual(['grava'])
    expect(Object.keys(banco.gravado ?? {}).sort()).toEqual(['dtManutencao', 'idFormato', 'idSala', 'numeroVisivel'])
    expect(banco.gravado).toMatchObject({ numeroVisivel: 'E-07', idSala: 1, idFormato: 1 })
  })

  it('mandar o formato que a estante ja tem nao e troca', async () => {
    await alterarEstante(4, { idFormato: 1 }, 1)

    expect(banco.passos).toEqual(['grava'])
  })

  it('numero ja usado na sala de destino e recusado', async () => {
    banco.mesmoNumero = { id: 6 }

    await expect(alterarEstante(4, { idSala: 2 }, 1)).rejects.toEqual(recusa(409, 'ESTANTE_DUPLICADA'))
    expect(banco.gravado).toBeNull()
  })

  it('sala de destino removida e campo invalido', async () => {
    await expect(alterarEstante(4, { idSala: 3 }, 1)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('estante removida nao se edita', async () => {
    banco.estante = null

    await expect(alterarEstante(4, { numeroVisivel: 'E-09' }, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})

describe('troca do formato da estante', () => {
  it('trava as caixas ativas da estante, confere as que ficariam fora e so depois grava', async () => {
    await alterarEstante(4, { idFormato: 3 }, 1)

    expect(banco.passos).toEqual(['trava', 'confere', 'grava'])
    // em ordem de id, como toda operacao que mexe em mais de uma caixa
    expect(banco.travas).toEqual([
      { sql: 'SELECT "id" FROM "infra"."caixa" WHERE "id_estante" = ? AND "ativa" ORDER BY "id" FOR UPDATE', valores: [4] },
    ])
    // fora do formato novo: face, linha ou coluna alem das medidas dele (2 faces, 8 x 7)
    expect(banco.foraConsultadas).toEqual({
      idEstante: 4,
      ativa: true,
      OR: [{ face: { gt: 2 } }, { linha: { gt: 8 } }, { coluna: { gt: 7 } }],
    })
  })

  it('grava o formato novo, devolve as medidas dele e leva o formato de antes e o de depois ao historico', async () => {
    await expect(alterarEstante(4, { idFormato: 3 }, 1)).resolves.toMatchObject({
      idFormato: 3,
      formato: 'TECNIPLAST Modelo 1',
      faces: 2,
      linhas: 8,
      colunas: 7,
    })
    expect(banco.gravado).toMatchObject({ idFormato: 3 })
    expect(banco.historico[0]).toMatchObject({
      entidade: 'estante',
      acao: 'alteracao',
      dados: {
        antes: { idFormato: 1, formato: 'ALESCO Modelo 1' },
        depois: { idFormato: 3, formato: 'TECNIPLAST Modelo 1' },
      },
    })
  })

  it('uma caixa fora do formato novo: recusa no singular, sem gravar', async () => {
    banco.fora = [{ codigo: 'F8H' }]

    await expect(alterarEstante(4, { idFormato: 3 }, 1)).rejects.toEqual(recusa(409, 'CAIXAS_FORA_DO_FORMATO'))
    await expect(alterarEstante(4, { idFormato: 3 }, 1)).rejects.toThrow(
      'A caixa F8H fica fora do formato TECNIPLAST Modelo 1. Mude-a de lugar antes de trocar o formato.',
    )
    expect(banco.gravado).toBeNull()
    expect(banco.historico).toEqual([])
  })

  it('duas ou mais caixas fora: a lista em portugues, no plural', async () => {
    banco.fora = [{ codigo: 'F8H' }, { codigo: 'T8P' }]

    await expect(alterarEstante(4, { idFormato: 3 }, 1)).rejects.toThrow(
      'As caixas F8H e T8P ficam fora do formato TECNIPLAST Modelo 1. Mude-as de lugar antes de trocar o formato.',
    )

    banco.fora = [{ codigo: 'F8H' }, { codigo: 'F7H' }, { codigo: 'T8P' }]

    await expect(alterarEstante(4, { idFormato: 3 }, 1)).rejects.toThrow(
      'As caixas F8H, F7H e T8P ficam fora do formato TECNIPLAST Modelo 1. Mude-as de lugar antes de trocar o formato.',
    )
    expect(banco.gravado).toBeNull()
  })

  it('formato removido ou inexistente e campo invalido, antes de travar', async () => {
    await expect(alterarEstante(4, { idFormato: 4 }, 1)).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { idFormato: 'Escolha um formato cadastrado.' } } }),
    )
    await expect(alterarEstante(4, { idFormato: 99 }, 1)).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.passos).toEqual([])
  })
})

describe('remocao de estante', () => {
  it('conta como ocupada a posicao com caixa ativa, como a grade', async () => {
    await removerEstante(4, 1)

    expect(banco.caixasConsultadas).toEqual({ idEstante: 4, ativa: true })
  })

  it('estante com caixa nao sai', async () => {
    banco.caixas = 3

    await expect(removerEstante(4, 1)).rejects.toEqual(recusa(409, 'ESTANTE_OCUPADA'))
    await expect(removerEstante(4, 1)).rejects.toThrow('A estante E-01 ainda tem 3 caixas.')
    expect(banco.gravado).toBeNull()
  })

  it('estante vazia fica inativa, nao e apagada, e vai para o historico', async () => {
    await expect(removerEstante(4, 1)).resolves.toBeUndefined()

    expect(banco.gravado).toMatchObject({ ativa: false })
    expect(banco.historico[0]).toMatchObject({
      entidade: 'estante',
      idEntidade: 4,
      acao: 'remocao',
      descricao: 'Estante E-01 removida da Sala 1',
    })
  })

  it('estante ja removida da 404', async () => {
    banco.estante = null

    await expect(removerEstante(4, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
