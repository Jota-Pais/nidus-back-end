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

  it('enviado e a ultima coluna: a caixa enviada nao sai dela', async () => {
    naColuna('X')
    banco.partos = [desmamado(2, 2, entregue(2, 2))]

    for (const estado of ['livres', 'pre_reserva', 'estoque', 'reserva'] as const) {
      await expect(moverCaixa(7, { estado, confirmar: true }, 1)).rejects.toEqual(recusa('TRANSICAO_INVALIDA'))
    }
    expect(banco.gravado).toBeNull()
  })

  it('estoque e reserva nao voltam para livres nem pre-reserva', async () => {
    banco.partos = [desmamado(2, 2, reservado(2, 2))]

    for (const antes of ['E', 'T']) {
      naColuna(antes)
      for (const estado of ['livres', 'pre_reserva'] as const) {
        await expect(moverCaixa(7, { estado, confirmar: true }, 1)).rejects.toEqual(recusa('TRANSICAO_INVALIDA'))
      }
    }
    expect(banco.gravado).toBeNull()
  })

  it('reserva nao volta para estoque', async () => {
    naColuna('T')
    banco.partos = [desmamado(2, 2, reservado(2, 2))]

    await expect(moverCaixa(7, { estado: 'estoque', confirmar: true }, 1)).rejects.toEqual(
      recusaComMensagem('de Reserva ela so vai para Enviado'),
    )
    expect(banco.gravado).toBeNull()
  })

  it('livres e pre-reserva nao vao direto para enviado, e livres nao vai direto para reserva', async () => {
    banco.partos = [desmamado(2, 2, reservado(2, 2))]

    for (const antes of ['R', 'P']) {
      naColuna(antes)
      await expect(moverCaixa(7, { estado: 'enviado', confirmar: true }, 1)).rejects.toEqual(
        recusa('TRANSICAO_INVALIDA'),
      )
    }

    naColuna('R')
    await expect(moverCaixa(7, { estado: 'reserva', confirmar: true }, 1)).rejects.toEqual(
      recusaComMensagem('de Livres ela so vai para Pre-reserva ou Estoque'),
    )
    expect(banco.gravado).toBeNull()
  })

  it('vai para estoque so depois do desmame, com animal desmamado na caixa', async () => {
    naColuna('R')
    banco.partos = [nascido(3, 3)]
    await expect(moverCaixa(7, { estado: 'estoque', confirmar: false }, 1)).rejects.toEqual(
      recusaComMensagem('so depois do desmame'),
    )

    naColuna('P')
    banco.partos = [desmamado(2, 2, entregue(2, 2)), nascido(3, 3, reservado(1, 0))]
    await expect(moverCaixa(7, { estado: 'estoque', confirmar: true }, 1)).rejects.toEqual(
      recusaComMensagem('so depois do desmame'),
    )
    expect(banco.gravado).toBeNull()

    naColuna('R')
    banco.partos = [desmamado(2, 2)]
    await expect(moverCaixa(7, { estado: 'estoque', confirmar: false }, 1)).resolves.toMatchObject({
      estado: 'estoque',
    })

    naColuna('P')
    banco.partos = [desmamado(2, 2, entregue(1, 0)), nascido(3, 3, reservado(1, 0))]
    await expect(moverCaixa(7, { estado: 'estoque', confirmar: true }, 1)).resolves.toMatchObject({
      estado: 'estoque',
    })
  })

  it('pre-reserva vai para reserva so com todos os animais comprometidos', async () => {
    naColuna('P')
    banco.partos = [desmamado(2, 2, reservado(1, 2))]
    await expect(moverCaixa(7, { estado: 'reserva', confirmar: true }, 1)).rejects.toEqual(
      recusaComMensagem('1 M e 0 F livres'),
    )
    expect(banco.gravado).toBeNull()

    banco.partos = [desmamado(2, 2, reservado(2, 2))]
    await expect(moverCaixa(7, { estado: 'reserva', confirmar: true }, 1)).resolves.toMatchObject({
      estado: 'reserva',
    })
  })

  it('caixa sem animal alocado a solicitacao nao vai para reserva nem para enviado', async () => {
    naColuna('P')
    await expect(moverCaixa(7, { estado: 'reserva', confirmar: true }, 1)).rejects.toEqual(
      recusa('TRANSICAO_INVALIDA'),
    )

    banco.partos = [desmamado(2, 2)]
    naColuna('E')
    for (const estado of ['reserva', 'enviado'] as const) {
      await expect(moverCaixa(7, { estado, confirmar: true }, 1)).rejects.toEqual(
        recusaComMensagem('nao tem animal alocado'),
      )
    }

    naColuna('T')
    await expect(moverCaixa(7, { estado: 'enviado', confirmar: true }, 1)).rejects.toEqual(
      recusaComMensagem('nao tem animal alocado'),
    )
    expect(banco.gravado).toBeNull()
  })

  it('estoque com solicitacao vinculada vai para reserva', async () => {
    naColuna('E')
    banco.partos = [desmamado(2, 2, reservado(1, 1))]

    await expect(moverCaixa(7, { estado: 'reserva', confirmar: true }, 1)).resolves.toMatchObject({
      estado: 'reserva',
    })
  })

  it('reserva com a entrega registrada vai para enviado sem pedir confirmacao', async () => {
    naColuna('T')
    banco.partos = [desmamado(2, 2, entregue(2, 2))]

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
    banco.partos = [desmamado(2, 2, reservado(1, 1))]

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
