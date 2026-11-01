import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mudarDePosicao } from './caixa.service.ts'

const banco = vi.hoisted(() => ({
  caixa: null as Record<string, unknown> | null,
  estante: null as Record<string, unknown> | null,
  ocupante: null as Record<string, unknown> | null,
  gravado: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: {
      findUnique: async () => banco.caixa,
      findFirst: async () => banco.ocupante,
    },
    estante: { findFirst: async () => banco.estante },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        caixa: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            banco.gravado = data
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

const destino = { idEstante: 2, face: 'traseira' as const, linha: 3, coluna: 2 }
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.caixa = { id: 7, ativa: true, codigo: 'F1A', idEstante: 1 }
  banco.estante = { id: 2, faces: 2, linhas: 5, colunas: 5, numeroVisivel: 'E-02' }
  banco.ocupante = null
  banco.gravado = null
  banco.historico = null
})

describe('mudar caixa de posicao', () => {
  it('posicao vazia: grava o endereco novo e o codigo da etiqueta', async () => {
    await expect(mudarDePosicao(7, destino, 1)).resolves.toEqual({ idCaixa: 7, idEstante: 2, codigo: 'T3G' })
    expect(banco.gravado).toEqual({ idEstante: 2, face: 2, linha: 3, coluna: 2, codigo: 'T3G' })
  })

  it('grava no historico quem moveu, de onde e para onde', async () => {
    await mudarDePosicao(7, destino, 3)

    expect(banco.historico).toMatchObject({
      idUsuario: 3,
      entidade: 'caixa',
      idEntidade: 7,
      acao: 'mudanca_de_posicao',
      dados: { antes: { idEstante: 1, codigo: 'F1A' }, depois: { idEstante: 2, codigo: 'T3G' } },
    })
  })

  it('posicao ocupada por outra caixa e recusada', async () => {
    banco.ocupante = { id: 9 }

    await expect(mudarDePosicao(7, destino, 1)).rejects.toEqual(recusa(409, 'POSICAO_OCUPADA'))
    expect(banco.gravado).toBeNull()
  })

  it('posicao fora da estante e recusada', async () => {
    await expect(mudarDePosicao(7, { ...destino, linha: 6 }, 1)).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.gravado).toBeNull()
  })

  it('estante inativa ou inexistente e recusada', async () => {
    banco.estante = null

    await expect(mudarDePosicao(7, destino, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })

  it('caixa inativa nao se move', async () => {
    banco.caixa = { id: 7, ativa: false }

    await expect(mudarDePosicao(7, destino, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
    expect(banco.gravado).toBeNull()
  })
})
