import { describe, expect, it, vi } from 'vitest'
import { DATA_PROXIMA_DEMAIS, avaliarViabilidade, resumirBusca } from './viabilidade.service.ts'

// O banco aqui e de mentira, como em 'motor.service.test.ts': a linhagem e de rato e
// 'caixa.findMany' devolve as caixas que cada teste deixou em 'banco'. Nada e gravado

// hoje e 30/10 em Brasilia. Com idade minima de 21 dias, o acasalamento novo entrega a partir
// de 30/10 + 23 + 21 = 13/12
const agora = new Date('2026-10-30T12:00:00.000Z')
const PERTO = '2026-11-10'
const DATA_MINIMA = '2026-12-13'

const dia = (data: string) => new Date(`${data}T00:00:00.000Z`)

/** caixa com um parto ja desmamado, nascido em 'nascimento', com 4 machos e 4 femeas livres */
const caixa = (id: number, nascimento: string) => ({
  id,
  face: 1,
  linha: 1,
  coluna: id,
  estado: 'R',
  estante: { numeroVisivel: '1', colunas: 12 },
  casais: [
    {
      identificacao: 'AB',
      ativo: true,
      partos: [
        {
          id,
          ordem: 1,
          dtPartoPrevisto: dia(nascimento),
          dtPartoReal: dia(nascimento),
          dtDesmameReal: dia('2026-11-02'),
          nascidoM: 5,
          nascidoF: 5,
          eutanasiadoM: 1,
          eutanasiadoF: 1,
          desmamadoM: 4,
          desmamadoF: 4,
          compromissos: [],
        },
      ],
    },
  ],
})

const banco = vi.hoisted(() => ({ caixas: [] as unknown[], linhagem: true }))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    linhagem: {
      findUnique: async () => (banco.linhagem ? { especie: { nome: 'Rato' } } : null),
    },
    especie: { findMany: async () => [{ id: 1, nome: 'Rato' }] },
    caixa: { findMany: async () => banco.caixas },
  },
}))

const pedido = {
  idLinhagem: 1,
  machos: 2,
  femeas: 0,
  qualquer: 0,
  idadeMin: 21,
  idadeMax: 40,
  dataEntrega: PERTO,
}

describe('resumirBusca', () => {
  it('sem deficit da, mesmo com a data curta demais para acasalamento novo', () => {
    const veredito = resumirBusca({
      deficit: { m: 0, f: 0, qualquer: 0 },
      acasalamentoNovo: { viavel: false },
    })

    expect(veredito).toEqual({ viavel: true, motivo: null })
  })

  it('com deficit, da se a data permite acasalamento novo', () => {
    const veredito = resumirBusca({
      deficit: { m: 3, f: 0, qualquer: 1 },
      acasalamentoNovo: { viavel: true },
    })

    expect(veredito).toEqual({ viavel: true, motivo: null })
  })

  it('com deficit e sem tempo para acasalamento novo, nao da e diz por que', () => {
    const veredito = resumirBusca({
      deficit: { m: 0, f: 0, qualquer: 1 },
      acasalamentoNovo: { viavel: false },
    })

    expect(veredito).toEqual({ viavel: false, motivo: DATA_PROXIMA_DEMAIS })
  })
})

describe('avaliarViabilidade', () => {
  it('da quando a colonia tem os animais na idade e na data pedidas', async () => {
    banco.caixas = [caixa(1, '2026-10-11')]

    expect(await avaliarViabilidade(pedido, agora)).toEqual({ viavel: true, motivo: null })
  })

  it('nao da quando a colonia nao cobre e a data e curta demais', async () => {
    banco.caixas = [caixa(1, '2026-10-11')]

    const veredito = await avaliarViabilidade({ ...pedido, machos: 10 }, agora)

    expect(veredito).toEqual({ viavel: false, motivo: DATA_PROXIMA_DEMAIS })
  })

  it('a resposta nao leva numero de estoque, so o veredito e o motivo', async () => {
    banco.caixas = [caixa(1, '2026-10-11')]

    const veredito = await avaliarViabilidade(pedido, agora)

    expect(Object.keys(veredito).sort()).toEqual(['motivo', 'viavel'])
  })

  it('sem colonia, a timeline reversa decide: hoje + 23 + idade minima', async () => {
    banco.caixas = []

    const naData = await avaliarViabilidade({ ...pedido, dataEntrega: DATA_MINIMA }, agora)
    const umDiaAntes = await avaliarViabilidade({ ...pedido, dataEntrega: '2026-12-12' }, agora)

    expect(naData.viavel).toBe(true)
    expect(umDiaAntes).toEqual({ viavel: false, motivo: DATA_PROXIMA_DEMAIS })
  })

  it('hoje e o dia de Brasilia: as 22h de 30/10 a data minima ainda e 13/12', async () => {
    banco.caixas = []
    const noiteEmBrasilia = new Date('2026-10-31T01:00:00.000Z')

    const veredito = await avaliarViabilidade(
      { ...pedido, dataEntrega: DATA_MINIMA },
      noiteEmBrasilia,
    )

    expect(veredito.viavel).toBe(true)
  })

  it('linhagem que nao existe e NAO_ENCONTRADO', async () => {
    banco.linhagem = false

    await expect(avaliarViabilidade(pedido, agora)).rejects.toMatchObject({
      status: 404,
      codigo: 'NAO_ENCONTRADO',
    })

    banco.linhagem = true
  })
})
