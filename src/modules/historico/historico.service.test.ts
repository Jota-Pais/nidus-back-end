import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listarHistorico } from './historico.service.ts'

const findMany = vi.hoisted(() => vi.fn())

vi.mock('../../shared/prisma.ts', () => ({
  prisma: { historico: { findMany } },
}))

beforeEach(() => {
  findMany.mockReset()
  findMany.mockResolvedValue([])
})

describe('filtro do historico', () => {
  it('filtra no banco por tipo, numero e texto, antes do limite', async () => {
    await listarHistorico({ entidade: 'caixa', idEntidade: 7, busca: 'Ana', limite: 300 })

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entidade: 'caixa',
          idEntidade: 7,
          OR: [
            { descricao: { contains: 'Ana', mode: 'insensitive' } },
            { usuario: { nome: { contains: 'Ana', mode: 'insensitive' } } },
          ],
        },
        take: 300,
      }),
    )
  })

  it('sem filtro traz as mais recentes de tudo', async () => {
    await listarHistorico({ limite: 300 })

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {}, take: 300 }))
  })
})
