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

  it('a busca por "Sistema" traz tambem o que foi feito sem usuario', async () => {
    await listarHistorico({ busca: 'sist', limite: 300 })

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { descricao: { contains: 'sist', mode: 'insensitive' } },
            { usuario: { nome: { contains: 'sist', mode: 'insensitive' } } },
            { idUsuario: null },
          ],
        },
      }),
    )
  })
})

describe('quem fez', () => {
  it('mostra "Sistema" quando o registro nao tem usuario', async () => {
    const registro = {
      id: 1,
      dtHora: new Date('2026-11-06T12:00:00.000Z'),
      entidade: 'solicitacao',
      idEntidade: 4,
      acao: 'recusa',
      descricao: 'Solicitacao #4 recusada',
      dados: null,
    }
    findMany.mockResolvedValue([
      { ...registro, usuario: null },
      { ...registro, id: 2, usuario: { nome: 'Ana' } },
    ])

    const { historico } = await listarHistorico({ limite: 300 })

    expect(historico.map((r) => r.usuario)).toEqual(['Sistema', 'Ana'])
  })
})
