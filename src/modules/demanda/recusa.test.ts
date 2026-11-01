import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recusarSolicitacao } from './demanda.service.ts'

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  recusadas: 1,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    solicitacao: { findUnique: async () => banco.solicitacao },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        solicitacao: { updateMany: async () => ({ count: banco.recusadas }) },
        historico: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.historico = data
          },
        },
      }),
  },
}))

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.solicitacao = { id: 7, status: 'EN' }
  banco.recusadas = 1
  banco.historico = null
})

describe('recusa de solicitacao', () => {
  it('a enviada vira recusada e o motivo fica no historico', async () => {
    await expect(recusarSolicitacao(7, 'Sem animais da linhagem', 2)).resolves.toEqual({
      idSolicitacao: 7,
      status: 'recusada',
      motivo: 'Sem animais da linhagem',
    })
    expect(banco.historico).toMatchObject({
      idUsuario: 2,
      entidade: 'solicitacao',
      idEntidade: 7,
      acao: 'recusa',
      dados: { motivo: 'Sem animais da linhagem' },
    })
  })

  it('a ja alocada nao pode ser recusada', async () => {
    banco.solicitacao = { id: 7, status: 'AP' }

    await expect(recusarSolicitacao(7, 'teste', 2)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.historico).toBeNull()
  })

  it('recusa e alocacao ao mesmo tempo: quem chegar depois nao grava', async () => {
    banco.recusadas = 0

    await expect(recusarSolicitacao(7, 'teste', 2)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.historico).toBeNull()
  })

  it('solicitacao inexistente e 404', async () => {
    banco.solicitacao = null

    await expect(recusarSolicitacao(7, 'teste', 2)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
