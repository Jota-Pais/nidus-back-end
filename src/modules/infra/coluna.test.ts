import { beforeEach, describe, expect, it, vi } from 'vitest'
import { moverCaixa } from './caixa.service.ts'

// O banco aqui e de mentira. 'compromissos' sao os ativos (sem cancelamento) dos partos da
// caixa, cada um com a data em que a remessa dele saiu, ou null se ainda nao saiu

type Compromisso = { dtRealizada: Date | null }

const banco = vi.hoisted(() => ({
  caixa: null as Record<string, unknown> | null,
  compromissos: [] as Compromisso[],
  gravado: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

const daRemessa = (where: { remessa?: { dtRealizada?: unknown } }) =>
  where.remessa?.dtRealizada === null
    ? banco.compromissos.filter((c) => c.dtRealizada === null)
    : banco.compromissos

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: { findUnique: async () => banco.caixa },
    compromisso: {
      count: async ({ where }: { where: { remessa?: { dtRealizada?: unknown } } }) => daRemessa(where).length,
      findMany: async ({ where }: { where: { remessa?: { dtRealizada?: unknown } } }) =>
        daRemessa(where).map((c) => ({ remessa: { dtRealizada: c.dtRealizada } })),
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

const entregue: Compromisso = { dtRealizada: new Date('2026-11-02T00:00:00.000Z') }
const pendente: Compromisso = { dtRealizada: null }
const recusa = (codigo: string) => expect.objectContaining({ status: 409, codigo })
const naColuna = (estado: string) => {
  banco.caixa = { id: 7, ativa: true, estado, codigo: 'F1A' }
}

beforeEach(() => {
  naColuna('P')
  banco.compromissos = []
  banco.gravado = null
  banco.historico = null
})

describe('mudanca de coluna com animal comprometido', () => {
  it('reserva ainda nao entregue pede confirmacao', async () => {
    banco.compromissos = [pendente]

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
    banco.compromissos = [entregue]

    await expect(moverCaixa(7, { estado: 'livres', confirmar: false }, 1)).resolves.toEqual({
      idCaixa: 7,
      estado: 'livres',
    })
    expect(banco.gravado).toEqual({ estado: 'R' })
  })
})

describe('fluxo do kanban (spec do cliente, secao 1.9)', () => {
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

  it('enviado e a ultima coluna: a caixa enviada nao sai dela', async () => {
    naColuna('X')
    banco.compromissos = [entregue]

    for (const estado of ['livres', 'pre_reserva', 'estoque', 'reserva'] as const) {
      await expect(moverCaixa(7, { estado, confirmar: true }, 1)).rejects.toEqual(recusa('TRANSICAO_INVALIDA'))
    }
    expect(banco.gravado).toBeNull()
  })

  it('caixa em livres ou pre-reserva nao vai direto para enviado', async () => {
    banco.compromissos = [entregue]

    for (const estado of ['R', 'P']) {
      naColuna(estado)
      await expect(moverCaixa(7, { estado: 'enviado', confirmar: true }, 1)).rejects.toEqual(
        recusa('TRANSICAO_INVALIDA'),
      )
    }
    expect(banco.gravado).toBeNull()
  })

  it('caixa sem animal alocado a solicitacao nao vai para enviado', async () => {
    for (const estado of ['E', 'T']) {
      naColuna(estado)
      await expect(moverCaixa(7, { estado: 'enviado', confirmar: true }, 1)).rejects.toEqual(
        recusa('TRANSICAO_INVALIDA'),
      )
    }
    expect(banco.gravado).toBeNull()
  })

  it('caixa sem animal alocado a solicitacao nao vai para reserva', async () => {
    for (const estado of ['R', 'P', 'E']) {
      naColuna(estado)
      await expect(moverCaixa(7, { estado: 'reserva', confirmar: true }, 1)).rejects.toEqual(
        recusa('TRANSICAO_INVALIDA'),
      )
    }
    expect(banco.gravado).toBeNull()
  })

  it('estoque com solicitacao vinculada vai para reserva', async () => {
    naColuna('E')
    banco.compromissos = [pendente]

    await expect(moverCaixa(7, { estado: 'reserva', confirmar: true }, 1)).resolves.toMatchObject({
      estado: 'reserva',
    })
  })

  it('reserva com a entrega registrada vai para enviado sem pedir confirmacao', async () => {
    naColuna('T')
    banco.compromissos = [entregue]

    await expect(moverCaixa(7, { estado: 'enviado', confirmar: false }, 3)).resolves.toEqual({
      idCaixa: 7,
      estado: 'enviado',
    })
    expect(banco.historico).toMatchObject({
      idUsuario: 3,
      acao: 'mudanca_de_coluna',
      dados: { antes: 'reserva', depois: 'enviado' },
    })
  })

  it('estoque ou reserva com animal ainda nao entregue so vai para enviado confirmando', async () => {
    banco.compromissos = [pendente]

    for (const estado of ['E', 'T']) {
      naColuna(estado)
      await expect(moverCaixa(7, { estado: 'enviado', confirmar: false }, 1)).rejects.toEqual(
        recusa('TRANSICAO_CONTRARIA_COMPROMISSO'),
      )
      await expect(moverCaixa(7, { estado: 'enviado', confirmar: true }, 1)).resolves.toMatchObject({
        estado: 'enviado',
      })
    }
  })
})
