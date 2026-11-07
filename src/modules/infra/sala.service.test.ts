import { beforeEach, describe, expect, it, vi } from 'vitest'
import { criarSala, listarSalas, removerSala, renomearSala } from './sala.service.ts'

type Linha = Record<string, unknown>

const banco = vi.hoisted(() => ({
  sala: null as Linha | null,
  mesmoNome: null as Linha | null,
  estantes: 0,
  nomeConsultado: null as Linha | null,
  estantesConsultadas: null as Linha | null,
  gravado: null as Linha | null,
  historico: [] as Linha[],
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    sala: {
      findMany: async () => [
        { id: 1, nome: 'Sala 1', _count: { estantes: 2 } },
        { id: 4, nome: 'Sala 4', _count: { estantes: 0 } },
      ],
      // a mesma consulta serve a "sala ativa pelo id" e a "nome ja usado"
      findFirst: async ({ where }: { where: Linha }) => {
        if ('nome' in where) {
          banco.nomeConsultado = where
          return banco.mesmoNome
        }
        return banco.sala
      },
    },
    estante: {
      count: async ({ where }: { where: Linha }) => {
        banco.estantesConsultadas = where
        return banco.estantes
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        sala: {
          create: async ({ data }: { data: Linha }) => {
            banco.gravado = data
            return { id: 5, ativa: true, ...data }
          },
          update: async ({ data }: { data: Linha }) => {
            banco.gravado = data
            return { ...banco.sala, ...data }
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
}))

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.sala = { id: 1, nome: 'Sala 1', ativa: true }
  banco.mesmoNome = null
  banco.estantes = 0
  banco.nomeConsultado = null
  banco.estantesConsultadas = null
  banco.gravado = null
  banco.historico = []
})

describe('lista de salas', () => {
  it('cada sala vem com quantas estantes ativas tem, e a sala sem estante tambem', async () => {
    await expect(listarSalas()).resolves.toEqual({
      salas: [
        { id: 1, nome: 'Sala 1', estantes: 2 },
        { id: 4, nome: 'Sala 4', estantes: 0 },
      ],
    })
  })
})

describe('cadastro de sala', () => {
  it('nome repetido entre as ativas e recusado, sem diferenciar maiuscula', async () => {
    banco.mesmoNome = { id: 1 }

    await expect(criarSala({ nome: 'sala 1' }, 1)).rejects.toEqual(recusa(409, 'SALA_DUPLICADA'))
    expect(banco.nomeConsultado).toEqual({ ativa: true, nome: { equals: 'sala 1', mode: 'insensitive' } })
  })

  it('sala nova vai para o historico', async () => {
    await expect(criarSala({ nome: 'Sala 4' }, 1)).resolves.toEqual({ id: 5, nome: 'Sala 4' })
    expect(banco.historico).toEqual([
      expect.objectContaining({ entidade: 'sala', idEntidade: 5, acao: 'cadastro', descricao: 'Sala 4 cadastrada' }),
    ])
  })
})

describe('renomear sala', () => {
  it('o nome de outra sala ativa e recusado, o da propria nao conta', async () => {
    banco.mesmoNome = { id: 2 }

    await expect(renomearSala(1, { nome: 'Sala 2' }, 1)).rejects.toEqual(recusa(409, 'SALA_DUPLICADA'))
    expect(banco.nomeConsultado).toMatchObject({ id: { not: 1 } })
  })

  it('grava o nome novo e o de antes no historico', async () => {
    await expect(renomearSala(1, { nome: 'Sala A' }, 1)).resolves.toEqual({ id: 1, nome: 'Sala A' })
    expect(banco.historico[0]).toMatchObject({
      acao: 'alteracao',
      descricao: 'Sala 1 renomeada para Sala A',
      dados: { antes: { nome: 'Sala 1' }, depois: { nome: 'Sala A' } },
    })
  })

  it('sala removida nao se renomeia', async () => {
    banco.sala = null

    await expect(renomearSala(1, { nome: 'Sala A' }, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})

describe('remover sala', () => {
  it('sala com estante ativa nao sai', async () => {
    banco.estantes = 2

    await expect(removerSala(1, 1)).rejects.toEqual(recusa(409, 'SALA_COM_ESTANTE'))
    await expect(removerSala(1, 1)).rejects.toThrow('Sala 1 ainda tem 2 estantes.')
    expect(banco.estantesConsultadas).toEqual({ idSala: 1, ativa: true })
    expect(banco.gravado).toBeNull()
  })

  it('sala sem estante fica inativa, nao e apagada, e vai para o historico', async () => {
    await expect(removerSala(1, 1)).resolves.toBeUndefined()

    expect(banco.gravado).toMatchObject({ ativa: false })
    expect(banco.historico[0]).toMatchObject({ entidade: 'sala', acao: 'remocao', descricao: 'Sala 1 removida' })
  })
})
