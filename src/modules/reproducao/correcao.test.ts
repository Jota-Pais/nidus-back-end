import { beforeEach, describe, expect, it, vi } from 'vitest'
import { corrigirDesmame, corrigirNascimento, corrigirSelecao } from './correcao.service.ts'

const banco = vi.hoisted(() => ({
  parto: null as Record<string, unknown> | null,
  proximo: null as Record<string, unknown> | null,
  atualizados: [] as { where: { id: number }; data: Record<string, unknown> }[],
  casal: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    parto: {
      findUnique: async () => banco.parto,
      findFirst: async () => banco.proximo,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        parto: {
          update: async (consulta: { where: { id: number }; data: Record<string, unknown> }) => {
            banco.atualizados.push(consulta)
          },
        },
        casal: {
          update: async ({ data }: { data: Record<string, unknown> }) => {
            banco.casal = data
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

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const agora = new Date('2026-10-30T15:00:00.000Z')
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

const partoRegistrado = {
  id: 1,
  idCasal: 1,
  ordem: 1,
  dtAcasalamento: d('2026-09-01'),
  dtPartoPrevisto: d('2026-09-24'),
  dtDesmamePrevisto: d('2026-10-16'),
  dtPartoReal: d('2026-09-24'),
  nascidoM: 5,
  nascidoF: 5,
  dtSelecao: d('2026-09-25'),
  eutanasiadoM: 1,
  eutanasiadoF: 1,
  dtDesmameReal: d('2026-10-16'),
  desmamadoM: 4,
  desmamadoF: 4,
  compromissos: [] as { qtdM: number; qtdF: number }[],
  casal: { id: 1, dtEncerramento: null },
}

beforeEach(() => {
  banco.parto = { ...partoRegistrado }
  banco.proximo = null
  banco.atualizados = []
  banco.casal = null
  banco.historico = null
})

describe('correcao do parto', () => {
  it('parto ainda nao registrado nao se corrige', async () => {
    banco.parto = { ...partoRegistrado, dtPartoReal: null, nascidoM: null, nascidoF: null }

    await expect(
      corrigirNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 6, nascidoF: 5, motivo: 'x' }, 1, agora),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('nascido nao pode ficar abaixo do que ja foi selecionado e desmamado', async () => {
    await expect(
      corrigirNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 4, nascidoF: 5, motivo: 'x' }, 1, agora),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.atualizados).toEqual([])
  })

  it('mudar a data recalcula o parto seguinte que ainda nao aconteceu', async () => {
    banco.proximo = { id: 2, dtPartoReal: null }

    await corrigirNascimento(
      1,
      { dtPartoReal: '2026-09-23', nascidoM: 5, nascidoF: 5, motivo: 'data digitada errada' },
      3,
      agora,
    )

    expect(banco.atualizados.map((a) => a.where.id)).toEqual([1, 2])
    expect(banco.historico).toMatchObject({
      idUsuario: 3,
      acao: 'correcao_nascimento',
      dados: {
        motivo: 'data digitada errada',
        antes: { dtPartoReal: '2026-09-24' },
        depois: { dtPartoReal: '2026-09-23' },
      },
    })
  })

  it('com o parto seguinte ja registrado a data nao muda mais', async () => {
    banco.proximo = { id: 2, dtPartoReal: d('2026-10-20') }

    await expect(
      corrigirNascimento(1, { dtPartoReal: '2026-09-23', nascidoM: 5, nascidoF: 5, motivo: 'x' }, 1, agora),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('avisa quando os compromissos passam do que o parto tem depois da correcao', async () => {
    banco.parto = {
      ...partoRegistrado,
      dtSelecao: null,
      eutanasiadoM: null,
      eutanasiadoF: null,
      dtDesmameReal: null,
      desmamadoM: null,
      desmamadoF: null,
      compromissos: [{ qtdM: 5, qtdF: 0 }],
    }

    const resposta = await corrigirNascimento(
      1,
      { dtPartoReal: '2026-09-24', nascidoM: 3, nascidoF: 5, motivo: 'contagem errada' },
      1,
      agora,
    )

    expect(resposta.alerta).toContain('5 M')
  })
})

describe('correcao da selecao e do desmame', () => {
  it('selecao que deixaria menos animais do que os desmamados e recusada', async () => {
    await expect(
      corrigirSelecao(1, { dtSelecao: '2026-09-25', eutanasiadoM: 2, eutanasiadoF: 1, motivo: 'x' }, 1),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('selecao corrigida grava antes e depois', async () => {
    await corrigirSelecao(
      1,
      { dtSelecao: '2026-09-26', eutanasiadoM: 1, eutanasiadoF: 0, motivo: 'contagem errada' },
      2,
    )

    expect(banco.historico).toMatchObject({
      acao: 'correcao_selecao',
      dados: { antes: { eutanasiadoF: 1 }, depois: { eutanasiadoF: 0 } },
    })
  })

  it('desmame acima do nascido menos a selecao e recusado', async () => {
    await expect(
      corrigirDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 5, desmamadoF: 4, motivo: 'x' }, 1),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('desmame ainda nao registrado nao se corrige', async () => {
    banco.parto = { ...partoRegistrado, dtDesmameReal: null, desmamadoM: null, desmamadoF: null }

    await expect(
      corrigirDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 4, desmamadoF: 4, motivo: 'x' }, 1),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })
})
