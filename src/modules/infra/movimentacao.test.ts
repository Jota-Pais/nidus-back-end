import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mudarDePosicao } from './caixa.service.ts'

// A mudanca de posicao com o banco de mentira: o codigo novo vem do trigger da posicao, que aqui
// e o 'update' devolvendo o codigo que o banco escreveria

const banco = vi.hoisted(() => ({
  caixa: null as Record<string, unknown> | null,
  estante: null as Record<string, unknown> | null,
  ocupante: null as Record<string, unknown> | null,
  gravado: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
  travas: [] as unknown[],
}))

const tx = {
  $queryRaw: async (...args: unknown[]) => {
    banco.travas.push(args)
    return []
  },
  caixa: {
    findUnique: async () => banco.caixa,
    findFirst: async () => banco.ocupante,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      banco.gravado = data
      return { codigo: 'T3G' }
    },
  },
  estante: { findFirst: async () => banco.estante },
  historico: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      banco.historico = data
    },
  },
}

vi.mock('../../shared/prisma.ts', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) },
}))

const destino = { idEstante: 2, face: 'traseira' as const, linha: 3, coluna: 2 }
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.caixa = { id: 7, ativa: true, codigo: 'F1A', idEstante: 1 }
  banco.estante = { id: 2, faces: 2, linhas: 5, colunas: 5, numeroVisivel: 'E-02' }
  banco.ocupante = null
  banco.gravado = null
  banco.historico = null
  banco.travas = []
})

describe('mudar caixa de posicao', () => {
  it('posicao vazia: grava o endereco novo, sem escrever o codigo, e devolve o que o trigger escreveu', async () => {
    await expect(mudarDePosicao(7, destino, 1)).resolves.toEqual({ idCaixa: 7, idEstante: 2, codigo: 'T3G' })
    expect(banco.gravado).toMatchObject({ idEstante: 2, face: 2, linha: 3, coluna: 2 })
    expect(banco.gravado).not.toHaveProperty('codigo')
  })

  it('trava a caixa antes de ler: duas mudancas da mesma caixa ficam em fila', async () => {
    await mudarDePosicao(7, destino, 1)

    expect(banco.travas).toHaveLength(1)
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

  it('a posicao onde ela ja esta e aceita', async () => {
    banco.ocupante = { id: 7 }

    await expect(mudarDePosicao(7, destino, 1)).resolves.toMatchObject({ idCaixa: 7 })
  })

  it('posicao ocupada por outra caixa e recusada', async () => {
    banco.ocupante = { id: 9 }

    await expect(mudarDePosicao(7, destino, 1)).rejects.toEqual(recusa(409, 'POSICAO_OCUPADA'))
    expect(banco.gravado).toBeNull()
  })

  it('posicao fora da estante e recusada no campo', async () => {
    await expect(mudarDePosicao(7, { ...destino, linha: 6 }, 1)).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { posicao: 'Esta posição não existe na estante.' } } }),
    )
    expect(banco.gravado).toBeNull()
  })

  it('estante inativa ou inexistente e recusada', async () => {
    banco.estante = null

    await expect(mudarDePosicao(7, destino, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })

  it('caixa liberada nao se move: a posicao dela ja pode ter outra caixa', async () => {
    banco.caixa = { id: 7, ativa: false, codigo: 'F1A' }

    await expect(mudarDePosicao(7, destino, 1)).rejects.toEqual(recusa(409, 'CAIXA_LIBERADA'))
    expect(banco.gravado).toBeNull()
  })

  it('caixa que nao existe', async () => {
    banco.caixa = null

    await expect(mudarDePosicao(7, destino, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
