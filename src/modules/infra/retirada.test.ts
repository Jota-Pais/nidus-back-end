import { beforeEach, describe, expect, it, vi } from 'vitest'
import { retiradaDoPedido } from './retirada.service.ts'

// A retirada le onde os reservados do pedido estao de fato: nenhuma conta, so os animais

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const banco = vi.hoisted(() => ({
  pedido: { id: 3 } as { id: number } | null,
  linhas: [] as unknown[],
  ondeAnimais: null as unknown,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    pedido: { findUnique: async () => banco.pedido },
    animal: {
      groupBy: async ({ where }: { where: unknown }) => {
        banco.ondeAnimais = where
        return banco.linhas
      },
    },
    caixa: {
      findMany: async () => [
        { id: 1, codigo: 'F1A', tipo: 'casal', estante: { numeroVisivel: 'E1' } },
        { id: 2, codigo: 'F2B', tipo: 'estoque', estante: { numeroVisivel: 'E1' } },
      ],
    },
    parto: {
      findMany: async () => [
        { id: 4, ordem: 1, dtPartoReal: d('2026-09-01'), casal: { identificacao: 'AB' } },
        { id: 5, ordem: 2, dtPartoReal: d('2026-09-01'), casal: { identificacao: 'CD' } },
        { id: 6, ordem: 3, dtPartoReal: d('2026-10-01'), casal: { identificacao: 'AB' } },
      ],
    },
  },
}))

const linha = (idCaixa: number, idParto: number, sexo: string, qtd: number) => ({ idCaixa, idParto, sexo, _count: { _all: qtd } })

beforeEach(() => {
  banco.pedido = { id: 3 }
  banco.linhas = []
})

describe('retirada do pedido', () => {
  it('os vivos reservados por caixa, sexo e nascimento, na ordem da estante, com os partos de origem', async () => {
    banco.linhas = [linha(2, 4, 'F', 2), linha(2, 5, 'F', 1), linha(1, 6, 'M', 3), linha(2, 6, 'F', 1)]

    expect(await retiradaDoPedido(3)).toEqual({
      retirada: [
        { tipo: 'casal', codigo: 'F1A', numeroVisivel: 'E1', sexo: 'M', dtNascimento: '2026-10-01', qtd: 3, partos: [{ ordem: 3, casal: 'AB' }] },
        {
          tipo: 'estoque',
          codigo: 'F2B',
          numeroVisivel: 'E1',
          sexo: 'F',
          dtNascimento: '2026-09-01',
          qtd: 3,
          partos: [
            { ordem: 1, casal: 'AB' },
            { ordem: 2, casal: 'CD' },
          ],
        },
        { tipo: 'estoque', codigo: 'F2B', numeroVisivel: 'E1', sexo: 'F', dtNascimento: '2026-10-01', qtd: 1, partos: [{ ordem: 3, casal: 'AB' }] },
      ],
    })
    expect(banco.ondeAnimais).toEqual({ idPedido: 3, situacao: 'vivo' })
  })

  it('sem reservado vivo, a retirada fica vazia', async () => {
    expect(await retiradaDoPedido(3)).toEqual({ retirada: [] })
  })

  it('pedido que nao existe', async () => {
    banco.pedido = null

    await expect(retiradaDoPedido(3)).rejects.toEqual(expect.objectContaining({ status: 404 }))
  })
})
