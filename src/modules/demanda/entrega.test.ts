import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registrarEntrega } from './demanda.service.ts'

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  concluidas: 1,
  remessas: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    solicitacao: { findUnique: async () => banco.solicitacao },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        solicitacao: { updateMany: async () => ({ count: banco.concluidas }) },
        remessa: {
          updateMany: async (consulta: Record<string, unknown>) => {
            banco.remessas = consulta
            return { count: 1 }
          },
        },
        historico: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.historico = data
          },
        },
      }),
  },
}))

const agora = new Date('2026-10-31T15:00:00.000Z')
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.solicitacao = { id: 7, status: 'AP', dtCriacao: new Date('2026-10-01T12:00:00.000Z') }
  banco.concluidas = 1
  banco.remessas = null
  banco.historico = null
})

describe('registro de entrega', () => {
  it('solicitacao alocada vira entregue e a remessa ganha a data', async () => {
    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).resolves.toEqual({
      idSolicitacao: 7,
      status: 'concluida',
      dtEntrega: '2026-10-30',
    })
    expect(banco.remessas).toEqual({
      where: { idSolicitacao: 7, dtRealizada: null },
      data: { dtRealizada: new Date('2026-10-30T00:00:00.000Z'), status: 'E' },
    })
    expect(banco.historico).toMatchObject({ idUsuario: 1, entidade: 'solicitacao', idEntidade: 7, acao: 'entrega' })
  })

  it('solicitacao sem caixas alocadas e recusada', async () => {
    banco.solicitacao = { ...banco.solicitacao, status: 'EN' }

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.remessas).toBeNull()
  })

  it('segunda entrega da mesma solicitacao e recusada', async () => {
    banco.solicitacao = { ...banco.solicitacao, status: 'CO' }

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('dois cliques ao mesmo tempo: o segundo nao grava', async () => {
    banco.concluidas = 0

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.remessas).toBeNull()
  })

  it('entrega no futuro e recusada', async () => {
    await expect(registrarEntrega(7, '2026-11-01', 1, agora)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('entrega antes do pedido e recusada', async () => {
    await expect(registrarEntrega(7, '2026-09-30', 1, agora)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('solicitacao inexistente e 404', async () => {
    banco.solicitacao = null

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
