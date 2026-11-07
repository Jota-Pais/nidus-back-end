import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cicloFicha,
  encerrarCasal,
  formarCasal,
  registrarDesmame,
  registrarNascimento,
  registrarSelecao,
} from './reproducao.service.ts'

const banco = vi.hoisted(() => ({
  parto: null as Record<string, unknown> | null,
  casal: null as Record<string, unknown> | null,
  gravou: false,
  partoAtualizado: null as Record<string, unknown> | null,
  linhagem: null as Record<string, unknown> | null,
  caixa: { id: 1, idEspecie: 1, estado: 'R' },
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    linhagem: { findUnique: async () => banco.linhagem },
    caixa: { findUnique: async () => banco.caixa },
    grupoGeneticoPar: { findFirst: async () => ({ id: 1 }) },
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
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      banco.gravou = true
      return fn({
        parto: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            banco.partoAtualizado = data
          },
          create: async () => undefined,
        },
        casal: { update: async () => undefined },
        historico: { create: async () => undefined },
      })
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
  desmamadoM: null,
  desmamadoF: null,
  casal: { ativo: true },
}

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

/** a recusa de VALIDACAO com a mensagem exatamente nestes campos do formulario */
const nosCampos = (...campos: string[]) =>
  expect.objectContaining({
    status: 400,
    extras: { campos: Object.fromEntries(campos.map((campo) => [campo, expect.any(String)])) },
  })

beforeEach(() => {
  banco.gravou = false
  banco.casal = null
  banco.partoAtualizado = null
  banco.caixa = { id: 1, idEspecie: 1, estado: 'R' }
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

  it('o desmame previsto passa a contar do parto real', async () => {
    // previsto 24/09, desmame previsto 16/10; nasceu 20/10, depois do desmame que se esperava
    banco.parto = {
      ...pendente,
      dtPartoPrevisto: d('2026-09-24'),
      dtDesmamePrevisto: d('2026-10-16'),
      compromissos: [],
    }

    await registrarNascimento(1, { dtPartoReal: '2026-10-20', nascidoM: 5, nascidoF: 5 }, 1, agora)

    expect(banco.partoAtualizado).toMatchObject({ dtDesmamePrevisto: d('2026-11-11') })
  })
})

describe('ficha do parto', () => {
  it('o desmame previsto de parto ja nascido sai do parto real, e nao do previsto', async () => {
    // parto gravado antes da correcao: desmame previsto ainda contado do previsto
    banco.parto = {
      ...partoNascido,
      dtPartoPrevisto: d('2026-09-24'),
      dtPartoReal: d('2026-10-20'),
      dtDesmamePrevisto: d('2026-10-16'),
      dtDesmameReal: null,
      desmamadoM: null,
      desmamadoF: null,
      compromissos: [],
    }

    expect((await cicloFicha(1)).dtDesmamePrevisto).toBe('2026-11-11')
  })

  it('sem reserva passando do que a ninhada tem, nao ha falta', async () => {
    banco.parto = {
      ...partoNascido,
      dtPartoPrevisto: d('2026-09-24'),
      compromissos: [{ qtdM: 5, qtdF: 5, remessa: { idSolicitacao: 12 } }],
    }

    expect((await cicloFicha(1)).falta).toBeNull()
  })

  it('o desmame previsto de parto que ainda nao nasceu sai do parto previsto', async () => {
    banco.parto = {
      ...partoNascido,
      dtPartoPrevisto: d('2026-09-24'),
      dtPartoReal: null,
      nascidoM: null,
      nascidoF: null,
      dtDesmamePrevisto: d('2026-10-16'),
      dtDesmameReal: null,
      desmamadoM: null,
      desmamadoF: null,
      compromissos: [],
    }

    expect((await cicloFicha(1)).dtDesmamePrevisto).toBe('2026-10-16')
  })
})

describe('selecao', () => {
  it('depois do desmame e recusada', async () => {
    banco.parto = { ...partoNascido, dtDesmameReal: d('2026-10-16') }

    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-25', eutanasiadoM: 1, eutanasiadoF: 1 }, 1),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('eutanasia acima do nascido aponta o campo do sexo que passou', async () => {
    banco.parto = partoNascido

    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-24', eutanasiadoM: 1, eutanasiadoF: 6 }, 1),
    ).rejects.toEqual(nosCampos('eutanasiadoF'))
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

  it('acima do nascido menos a selecao aponta o campo do sexo que passou', async () => {
    banco.parto = { ...partoNascido, eutanasiadoM: 1, eutanasiadoF: 1 }

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 5, desmamadoF: 4 }, 1),
    ).rejects.toEqual(nosCampos('desmamadoM'))
    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 5, desmamadoF: 5 }, 1),
    ).rejects.toEqual(nosCampos('desmamadoM', 'desmamadoF'))
  })

  it('antes do parto e recusado', async () => {
    banco.parto = partoNascido

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-09-20', desmamadoM: 4, desmamadoF: 4 }, 1),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('com menos animais do que o reservado grava, e a resposta diz quanto falta e de quais pedidos', async () => {
    // 4 machos reservados para o pedido #12 e 1 para o #15; so 2 machos desmamaram
    banco.parto = {
      ...partoNascido,
      dtPartoPrevisto: d('2026-09-24'),
      compromissos: [
        { qtdM: 4, qtdF: 0, remessa: { idSolicitacao: 12 } },
        { qtdM: 1, qtdF: 0, remessa: { idSolicitacao: 15 } },
      ],
    }

    await registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 2, desmamadoF: 5 }, 1)

    // grava o que aconteceu de verdade
    expect(banco.partoAtualizado).toMatchObject({ desmamadoM: 2, desmamadoF: 5 })

    // e a ficha do parto, a mesma que a rota devolve, diz o que falta
    banco.parto = { ...banco.parto, desmamadoM: 2, desmamadoF: 5, dtDesmameReal: d('2026-10-16') }
    expect((await cicloFicha(1)).falta).toEqual({
      m: 3,
      f: 0,
      pedidos: [
        { idSolicitacao: 12, m: 4, f: 0 },
        { idSolicitacao: 15, m: 1, f: 0 },
      ],
    })
  })

  it('segundo desmame do mesmo parto e recusado', async () => {
    banco.parto = { ...partoNascido, dtDesmameReal: d('2026-10-16') }

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-17', desmamadoM: 4, desmamadoF: 4 }, 1),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.gravou).toBe(false)
  })
})

describe('formacao do casal', () => {
  it('linhagem inativa nao forma casal novo', async () => {
    banco.linhagem = { id: 2, nome: 'Wistar', idEspecie: 1, ativa: false }

    await expect(
      formarCasal(
        { idCaixa: 1, idLinhagem: 2, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: '2026-11-06' },
        1,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        codigo: 'VALIDACAO',
        extras: { campos: { idLinhagem: expect.stringContaining('inativa') } },
      }),
    )
    expect(banco.gravou).toBe(false)
  })

  it.each([
    ['E', 'Estoque'],
    ['T', 'Reserva'],
  ])('caixa em %s (%s) nao recebe casal novo: ela nao volta para Livres', async (estado, coluna) => {
    banco.linhagem = { id: 2, nome: 'Wistar', idEspecie: 1, ativa: true }
    banco.caixa = { id: 1, idEspecie: 1, estado }

    await expect(
      formarCasal(
        { idCaixa: 1, idLinhagem: 2, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: '2026-11-06' },
        1,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'TRANSICAO_INVALIDA',
        message: expect.stringContaining(coluna),
      }),
    )
    expect(banco.gravou).toBe(false)
  })
})

describe('encerramento', () => {
  it('antes da formacao do casal e recusado', async () => {
    banco.casal = { id: 1, ativo: true, dtFormacao: d('2026-09-01') }

    await expect(
      encerrarCasal(1, { dtEncerramento: '2026-08-30', motivo: 'teste' }, 1),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.gravou).toBe(false)
  })
})
