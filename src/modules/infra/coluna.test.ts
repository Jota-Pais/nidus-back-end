import { beforeEach, describe, expect, it, vi } from 'vitest'
import { moverCaixa } from './caixa.service.ts'

// O banco aqui e de mentira. 'partos' sao os partos dos casais da caixa, cada um com os
// compromissos ativos e a data em que a remessa de cada um saiu (null enquanto nao saiu)

type Compromisso = { qtdM: number; qtdF: number; remessa: { idSolicitacao: number; dtRealizada: Date | null } }

const banco = vi.hoisted(() => ({
  caixa: null as Record<string, unknown> | null,
  partos: [] as { compromissos: Compromisso[] }[],
  gravado: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

const compromissos = () => banco.partos.flatMap((parto) => parto.compromissos)

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: { findUnique: async () => banco.caixa },
    parto: { findMany: async () => banco.partos },
    compromisso: {
      findMany: async () => compromissos().map((c) => ({ remessa: c.remessa })),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        caixa: {
          update: async ({ data }: { data: { estado: string } }) => {
            banco.gravado = data
            return { id: 7, estado: data.estado }
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

const saiu = new Date('2026-11-02T00:00:00.000Z')
const reservado = (qtdM: number, qtdF: number): Compromisso => ({ qtdM, qtdF, remessa: { idSolicitacao: 1, dtRealizada: null } })
const entregue = (qtdM: number, qtdF: number): Compromisso => ({ qtdM, qtdF, remessa: { idSolicitacao: 1, dtRealizada: saiu } })

const contagem = { eutanasiadoM: null, eutanasiadoF: null, desmamadoM: null, desmamadoF: null }
const nascido = (m: number, f: number, ...reservas: Compromisso[]) => ({
  dtPartoReal: new Date('2026-10-01T00:00:00.000Z'),
  nascidoM: m,
  nascidoF: f,
  ...contagem,
  compromissos: reservas,
})
const desmamado = (m: number, f: number, ...reservas: Compromisso[]) => ({
  ...nascido(m, f, ...reservas),
  desmamadoM: m,
  desmamadoF: f,
})

const recusa = (codigo: string) => expect.objectContaining({ status: 409, codigo })
const recusaComMensagem = (mensagem: string) =>
  expect.objectContaining({ status: 409, codigo: 'TRANSICAO_INVALIDA', message: expect.stringContaining(mensagem) })
const naColuna = (estado: string) => {
  banco.caixa = { id: 7, ativa: true, estado, codigo: 'F1A' }
}

beforeEach(() => {
  naColuna('P')
  banco.partos = []
  banco.gravado = null
  banco.historico = null
})

describe('mudanca de coluna com animal comprometido', () => {
  it('reserva ainda nao entregue pede confirmacao', async () => {
    banco.partos = [nascido(3, 3, reservado(1, 0))]

    await expect(moverCaixa(7, { estado: 'livres', confirmar: false }, 1)).rejects.toEqual(
      recusa('TRANSICAO_CONTRARIA_COMPROMISSO'),
    )
    expect(banco.gravado).toBeNull()

    await expect(moverCaixa(7, { estado: 'livres', confirmar: true }, 1)).resolves.toEqual({
      idCaixa: 7,
      estado: 'livres',
    })
  })

  it('reserva ja entregue nao prende mais a caixa: muda sem pedir confirmacao', async () => {
    banco.partos = [nascido(3, 3, entregue(1, 0))]

    await expect(moverCaixa(7, { estado: 'livres', confirmar: false }, 1)).resolves.toEqual({
      idCaixa: 7,
      estado: 'livres',
    })
    expect(banco.gravado).toEqual({ estado: 'R' })
  })
})

describe('fluxo do kanban da caixa de casal', () => {
  it('livres e pre-reserva alternam sem vinculo', async () => {
    naColuna('R')
    await expect(moverCaixa(7, { estado: 'pre_reserva', confirmar: false }, 1)).resolves.toMatchObject({
      estado: 'pre_reserva',
    })

    naColuna('P')
    await expect(moverCaixa(7, { estado: 'livres', confirmar: false }, 1)).resolves.toMatchObject({
      estado: 'livres',
    })
  })

  it('a caixa de casal nao vai para estoque, reserva nem enviado: os desmamados vao pela ficha', async () => {
    banco.partos = [desmamado(2, 2, reservado(2, 2))]

    for (const antes of ['R', 'P']) {
      naColuna(antes)
      for (const estado of ['estoque', 'reserva', 'enviado'] as const) {
        await expect(moverCaixa(7, { estado, confirmar: true }, 1)).rejects.toEqual(
          recusaComMensagem('Passar para o estoque'),
        )
      }
    }
    expect(banco.gravado).toBeNull()
  })

  it('a caixa de estoque nao se arrasta: a coluna dela sai do que esta reservado', async () => {
    banco.caixa = { id: 7, ativa: true, estado: 'E', codigo: 'F2C', tipo: 'E' }

    for (const estado of ['reserva', 'enviado', 'livres'] as const) {
      await expect(moverCaixa(7, { estado, confirmar: true }, 1)).rejects.toEqual(
        recusaComMensagem('muda de coluna sozinha'),
      )
    }
    expect(banco.gravado).toBeNull()
  })
})
