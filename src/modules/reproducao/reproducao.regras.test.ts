import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encerrarCasal,
  registrarDesmame,
  registrarNascimento,
  registrarSelecao,
} from './reproducao.service.ts'

const banco = vi.hoisted(() => ({
  parto: null as Record<string, unknown> | null,
  casal: null as Record<string, unknown> | null,
  gravou: false,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    parto: {
      findUnique: async () => banco.parto,
      update: async () => {
        banco.gravou = true
      },
    },
    casal: {
      findUnique: async () => banco.casal,
      update: async () => {
        banco.gravou = true
      },
    },
    $transaction: async () => {
      banco.gravou = true
    },
  },
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const partoNascido = {
  id: 1,
  idCasal: 1,
  ordem: 1,
  dtAcasalamento: d('2026-09-01'),
  dtPartoReal: d('2026-09-24'),
  nascidoM: 5,
  nascidoF: 5,
  dtSelecao: null,
  eutanasiadoM: null,
  eutanasiadoF: null,
  dtDesmameReal: null,
  casal: { ativo: true },
}

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.gravou = false
  banco.casal = null
})

describe('nascimento', () => {
  const pendente = { ...partoNascido, dtPartoReal: null, nascidoM: null, nascidoF: null }
  const agora = new Date('2026-10-30T15:00:00.000Z')

  it('casal encerrado nao recebe parto', async () => {
    banco.parto = { ...pendente, casal: { ativo: false } }

    await expect(
      registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 5, nascidoF: 5 }, 1, agora),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.gravou).toBe(false)
  })

  it('parto antes do acasalamento e recusado', async () => {
    banco.parto = pendente

    await expect(
      registrarNascimento(1, { dtPartoReal: '2026-08-31', nascidoM: 5, nascidoF: 5 }, 1, agora),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('parto no futuro e recusado', async () => {
    banco.parto = pendente

    await expect(
      registrarNascimento(1, { dtPartoReal: '2026-10-31', nascidoM: 5, nascidoF: 5 }, 1, agora),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })
})

describe('selecao', () => {
  it('depois do desmame e recusada', async () => {
    banco.parto = { ...partoNascido, dtDesmameReal: d('2026-10-16') }

    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-25', eutanasiadoM: 1, eutanasiadoF: 1 }, 1),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('segunda selecao do mesmo parto e recusada', async () => {
    banco.parto = { ...partoNascido, dtSelecao: d('2026-09-25') }

    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-26', eutanasiadoM: 1, eutanasiadoF: 1 }, 1),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.gravou).toBe(false)
  })
})

describe('desmame', () => {
  it('nao passa do nascido menos a selecao', async () => {
    banco.parto = { ...partoNascido, eutanasiadoM: 1, eutanasiadoF: 1 }

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 5, desmamadoF: 4 }, 1),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.gravou).toBe(false)
  })

  it('antes do parto e recusado', async () => {
    banco.parto = partoNascido

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-09-20', desmamadoM: 4, desmamadoF: 4 }, 1),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('segundo desmame do mesmo parto e recusado', async () => {
    banco.parto = { ...partoNascido, dtDesmameReal: d('2026-10-16') }

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-17', desmamadoM: 4, desmamadoF: 4 }, 1),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.gravou).toBe(false)
  })
})

describe('encerramento', () => {
  it('antes da formacao do casal e recusado', async () => {
    banco.casal = { id: 1, ativo: true, dtFormacao: d('2026-09-01') }

    await expect(
      encerrarCasal(1, { dtEncerramento: '2026-08-30', motivo: 'teste' }),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.gravou).toBe(false)
  })
})
