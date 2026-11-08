import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cicloFicha,
  encerrarCasal,
  formarCasal,
  registrarAcasalamento,
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
  caixa: { id: 1, idEspecie: 1, estado: 'R', tipo: 'C' } as Record<string, unknown>,
  /** os partos da caixa do casal, para saber se ainda tem ninhada nela */
  partosDaCaixa: [] as Record<string, unknown>[],
  criados: [] as Record<string, unknown>[],
  liberou: [] as number[],
}))

vi.mock('../infra/liberacaoDaCaixa.ts', () => ({
  liberarCaixaVazia: async (_tx: unknown, idCaixa: number) => {
    banco.liberou.push(idCaixa)
    return true
  },
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    linhagem: { findUnique: async () => banco.linhagem },
    caixa: { findUnique: async () => banco.caixa },
    grupoGeneticoPar: { findFirst: async () => ({ id: 1 }) },
    parto: {
      findUnique: async () => banco.parto && { lotes: [], ...banco.parto },
      findMany: async () => banco.partosDaCaixa,
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
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.criados.push(data)
            return { id: 2, ...data }
          },
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

/** Uma ninhada que ainda esta na caixa do casal, sem nada no estoque. Mamando ate o desmame */
const ninhadaNaCaixa = (parcial: Record<string, unknown> = {}) => ({
  id: 9,
  ordem: 5,
  dtPartoReal: d('2026-10-01'),
  nascidoM: 3,
  nascidoF: 2,
  eutanasiadoM: null,
  eutanasiadoF: null,
  desmamadoM: null,
  desmamadoF: null,
  compromissos: [],
  lotes: [],
  casal: { identificacao: 'AB', idLinhagem: 2 },
  ...parcial,
})

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
  banco.caixa = { id: 1, idEspecie: 1, estado: 'R', tipo: 'C' }
  banco.partosDaCaixa = []
  banco.criados = []
  banco.liberou = []
})

describe('nascimento', () => {
  const pendente = { ...partoNascido, dtPartoReal: null, nascidoM: null, nascidoF: null }
  const agora = new Date('2026-10-30T15:00:00.000Z')

  it('o parto seguinte espera os desmamados de antes sairem da caixa para o estoque', async () => {
    banco.parto = { ...pendente, id: 2, ordem: 2, dtPartoPrevisto: d('2026-10-24'), compromissos: [] }
    banco.partosDaCaixa = [ninhadaNaCaixa({ ordem: 1, desmamadoM: 3, desmamadoF: 2 })]

    await expect(
      registrarNascimento(2, { dtPartoReal: '2026-10-24', nascidoM: 5, nascidoF: 5 }, 1),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'CAIXA_COM_ANIMAIS',
        message: expect.stringContaining('Passe para o estoque antes de registrar este parto'),
      }),
    )
    expect(banco.gravou).toBe(false)
  })

  it('com a ninhada de antes ainda mamando, pede o desmame dela primeiro', async () => {
    banco.parto = { ...pendente, id: 2, ordem: 2, dtPartoPrevisto: d('2026-10-24'), compromissos: [] }
    banco.partosDaCaixa = [ninhadaNaCaixa({ ordem: 1 })]

    await expect(
      registrarNascimento(2, { dtPartoReal: '2026-10-24', nascidoM: 5, nascidoF: 5 }, 1),
    ).rejects.toEqual(
      expect.objectContaining({ codigo: 'CAIXA_COM_ANIMAIS', message: expect.stringContaining('ainda mama') }),
    )
  })

  it('com os desmamados de antes ja no estoque, o parto seguinte registra', async () => {
    banco.parto = { ...pendente, id: 2, ordem: 2, dtPartoPrevisto: d('2026-10-24'), compromissos: [] }
    banco.partosDaCaixa = [
      ninhadaNaCaixa({
        ordem: 1,
        desmamadoM: 3,
        desmamadoF: 2,
        lotes: [
          { id: 1, idCaixa: 7, qtd: 3, caixa: { sexo: 'M' } },
          { id: 2, idCaixa: 8, qtd: 2, caixa: { sexo: 'F' } },
        ],
      }),
    ]

    await registrarNascimento(2, { dtPartoReal: '2026-10-24', nascidoM: 5, nascidoF: 5 }, 1)

    expect(banco.partoAtualizado).toMatchObject({ dtPartoReal: d('2026-10-24') })
  })

  it('casal encerrado nao recebe parto', async () => {
    banco.parto = { ...pendente, casal: { ativo: false } }

    await expect(
      registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 5, nascidoF: 5 }, 1),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.gravou).toBe(false)
  })

  it('o parto nao pode ser antes do acasalamento', async () => {
    banco.parto = { ...pendente, dtPartoPrevisto: d('2026-09-24'), compromissos: [] }

    await expect(
      registrarNascimento(1, { dtPartoReal: '2026-08-31', nascidoM: 5, nascidoF: 5 }, 1),
    ).rejects.toEqual(
      expect.objectContaining({
        extras: { campos: { dtPartoReal: 'Nao pode ser antes do acasalamento (01/09/2026).' } },
      }),
    )
    expect(banco.gravou).toBe(false)
  })

  // no mesmo dia do acasalamento pode: quem passa os dados antigos para o sistema junta tudo
  it.each(['2026-09-01', '2026-10-29', '2026-10-31'])(
    'o parto aceita do dia do acasalamento em diante, sem minimo de dias (%s)',
    async (dtPartoReal) => {
      banco.parto = { ...pendente, dtPartoPrevisto: d('2026-09-24'), compromissos: [] }

      await registrarNascimento(1, { dtPartoReal, nascidoM: 5, nascidoF: 5 }, 1)

      expect(banco.partoAtualizado).toMatchObject({ dtPartoReal: d(dtPartoReal) })
    },
  )

  it('o parto nao abre o parto seguinte sozinho', async () => {
    banco.parto = { ...pendente, dtPartoPrevisto: d('2026-09-24'), compromissos: [] }

    await registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 5, nascidoF: 5 }, 1)

    expect(banco.criados).toEqual([])
  })

  it('o 5o parto encerra o casal e libera a caixa se ela ficou vazia', async () => {
    banco.parto = {
      ...pendente,
      ordem: 5,
      dtPartoPrevisto: d('2026-09-24'),
      casal: { ativo: true, idCaixa: 7 },
      compromissos: [],
    }

    await registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 0, nascidoF: 0 }, 1)

    expect(banco.criados).toEqual([])
    expect(banco.liberou).toEqual([7])
  })

  it('o desmame previsto passa a contar do parto real', async () => {
    // previsto 24/09, desmame previsto 16/10; nasceu 20/10, depois do desmame que se esperava
    banco.parto = {
      ...pendente,
      dtPartoPrevisto: d('2026-09-24'),
      dtDesmamePrevisto: d('2026-10-16'),
      compromissos: [],
    }

    await registrarNascimento(1, { dtPartoReal: '2026-10-20', nascidoM: 5, nascidoF: 5 }, 1)

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

  it('nao pode ser antes do parto; no mesmo dia pode', async () => {
    banco.parto = { ...partoNascido, dtPartoPrevisto: d('2026-09-24'), compromissos: [] }

    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-23', eutanasiadoM: 1, eutanasiadoF: 1 }, 1),
    ).rejects.toEqual(nosCampos('dtSelecao'))
    expect(banco.gravou).toBe(false)

    await registrarSelecao(1, { dtSelecao: '2026-09-24', eutanasiadoM: 1, eutanasiadoF: 1 }, 1)
    expect(banco.partoAtualizado).toMatchObject({ dtSelecao: d('2026-09-24') })
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

  it('nao pode ser antes do parto', async () => {
    banco.parto = { ...partoNascido, dtPartoPrevisto: d('2026-09-24'), compromissos: [] }

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-09-20', desmamadoM: 4, desmamadoF: 4 }, 1),
    ).rejects.toEqual(
      expect.objectContaining({
        extras: { campos: { dtDesmameReal: 'Nao pode ser antes do parto (24/09/2026).' } },
      }),
    )
    expect(banco.gravou).toBe(false)
  })

  it('nao pode ser antes da eutanasia', async () => {
    banco.parto = { ...partoNascido, dtSelecao: d('2026-09-30'), eutanasiadoM: 1, eutanasiadoF: 1 }

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-09-29', desmamadoM: 4, desmamadoF: 4 }, 1),
    ).rejects.toEqual(nosCampos('dtDesmameReal'))
  })

  it('no mesmo dia do parto pode', async () => {
    banco.parto = { ...partoNascido, dtPartoPrevisto: d('2026-09-24'), compromissos: [] }

    await registrarDesmame(1, { dtDesmameReal: '2026-09-24', desmamadoM: 4, desmamadoF: 4 }, 1)

    expect(banco.partoAtualizado).toMatchObject({ dtDesmameReal: d('2026-09-24') })
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

  it('caixa de estoque nao recebe casal', async () => {
    banco.linhagem = { id: 2, nome: 'Wistar', idEspecie: 1, ativa: true }
    banco.caixa = { id: 1, idEspecie: 1, estado: 'E', tipo: 'E' }

    await expect(
      formarCasal(
        { idCaixa: 1, idLinhagem: 2, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: '2026-11-06' },
        1,
      ),
    ).rejects.toEqual(expect.objectContaining({ status: 409, codigo: 'CAIXA_DE_ESTOQUE' }))
    expect(banco.gravou).toBe(false)
  })

  it('caixa com desmamados do casal anterior nao recebe casal novo: eles vao para o estoque antes', async () => {
    banco.linhagem = { id: 2, nome: 'Wistar', idEspecie: 1, ativa: true }
    banco.caixa = { id: 1, idEspecie: 1, estado: 'R', tipo: 'C' }
    banco.partosDaCaixa = [ninhadaNaCaixa({ desmamadoM: 3, desmamadoF: 2 })]

    await expect(
      formarCasal(
        { idCaixa: 1, idLinhagem: 2, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: '2026-11-06' },
        1,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'CAIXA_COM_ANIMAIS',
        message: expect.stringContaining('3 M e 2 F desmamados do 5o parto do casal AB'),
      }),
    )
    expect(banco.gravou).toBe(false)
  })
})

describe('encerramento', () => {
  // formado em 01/09, o 2o parto acasalou em 25/09 e ainda nao nasceu
  const casalAtivo = {
    id: 1,
    idCaixa: 7,
    ativo: true,
    identificacao: 'AB',
    grupoMacho: 'A',
    grupoFemea: 'B',
    dtFormacao: d('2026-09-01'),
    dtEncerramento: null,
    linhagem: { nome: 'Wistar' },
    partos: [{ ordem: 2, dtAcasalamento: d('2026-09-25'), dtPartoReal: null }],
  }

  it('encerra no dia do ultimo acasalamento ou depois e libera a caixa se ela ficou vazia', async () => {
    banco.casal = casalAtivo

    await encerrarCasal(1, { dtEncerramento: '2026-09-25', motivo: 'teste' }, 1)

    expect(banco.gravou).toBe(true)
    expect(banco.liberou).toEqual([7])
  })

  it('nao encerra antes do ultimo acasalamento nem antes da formacao', async () => {
    banco.casal = casalAtivo

    await expect(encerrarCasal(1, { dtEncerramento: '2026-09-24', motivo: 'teste' }, 1)).rejects.toEqual(
      expect.objectContaining({
        extras: {
          campos: { dtEncerramento: 'Nao pode ser antes do acasalamento do 2o parto (25/09/2026).' },
        },
      }),
    )

    banco.casal = { ...casalAtivo, partos: [] }
    await expect(encerrarCasal(1, { dtEncerramento: '2026-08-30', motivo: 'teste' }, 1)).rejects.toEqual(
      nosCampos('dtEncerramento'),
    )
    expect(banco.gravou).toBe(false)
  })
})

describe('acasalamento', () => {
  const casal = (partos: Record<string, unknown>[], ativo = true) => ({
    id: 1,
    ativo,
    identificacao: 'AB',
    partos,
  })

  it('abre o parto seguinte com a data que o tecnico digitar', async () => {
    banco.casal = casal([{ ordem: 1, dtPartoReal: d('2026-09-24') }])
    banco.parto = { ...partoNascido, ordem: 2, dtPartoPrevisto: d('2026-10-28'), compromissos: [] }

    await registrarAcasalamento(1, { dtAcasalamento: '2026-09-25' }, 1)

    expect(banco.criados).toEqual([
      expect.objectContaining({ idCasal: 1, ordem: 2, dtAcasalamento: d('2026-09-25') }),
    ])
  })

  it('no dia do parto anterior pode, antes dele nao', async () => {
    banco.casal = casal([{ ordem: 1, dtPartoReal: d('2026-09-24') }])
    banco.parto = { ...partoNascido, ordem: 2, dtPartoPrevisto: d('2026-10-17'), compromissos: [] }

    await expect(registrarAcasalamento(1, { dtAcasalamento: '2026-09-23' }, 1)).rejects.toEqual(
      expect.objectContaining({
        extras: { campos: { dtAcasalamento: 'Nao pode ser antes do 1o parto (24/09/2026).' } },
      }),
    )
    expect(banco.criados).toEqual([])

    await registrarAcasalamento(1, { dtAcasalamento: '2026-09-24' }, 1)
    expect(banco.criados).toEqual([expect.objectContaining({ ordem: 2, dtAcasalamento: d('2026-09-24') })])
  })

  it('so depois de registrar o parto anterior', async () => {
    banco.casal = casal([{ ordem: 1, dtPartoReal: null }])

    await expect(registrarAcasalamento(1, { dtAcasalamento: '2026-09-25' }, 1)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
    expect(banco.criados).toEqual([])
  })

  it('nao passa do 5o parto nem vale para casal encerrado', async () => {
    banco.casal = casal([{ ordem: 5, dtPartoReal: d('2026-09-24') }])
    await expect(registrarAcasalamento(1, { dtAcasalamento: '2026-09-25' }, 1)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )

    banco.casal = casal([{ ordem: 1, dtPartoReal: d('2026-09-24') }], false)
    await expect(registrarAcasalamento(1, { dtAcasalamento: '2026-09-25' }, 1)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
    expect(banco.criados).toEqual([])
  })
})
