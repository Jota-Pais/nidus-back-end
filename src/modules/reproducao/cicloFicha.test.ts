import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnimalDoParto } from '../colonia/consultas.ts'
import { baixasDoAleitamento, cicloFicha, contarDoParto } from './cicloFicha.ts'

// A ficha do parto conta os animais do parto, onde estiverem. O banco aqui devolve o parto e os
// animais montados no teste

type Onde = { tipo?: string | { in: string[] }; motivo?: string; idCaixaDestino?: unknown }

const banco = vi.hoisted(() => ({
  parto: null as Record<string, unknown> | null,
  animais: [] as unknown[],
  /** o que a trilha devolve para cada limite: a selecao, a saida, a chegada fora e o primeiro fato */
  trilha: {} as Record<string, { tipo: string; dtFato: Date } | null>,
  /** as baixas nao anuladas dos animais do parto, com a causa e os animais */
  baixas: [] as unknown[],
}))

/**
 * Uma baixa como a ficha le: os animais sao os do banco (do parto 9), e o que nao esta nele e de
 * outro parto
 */
function baixa(id: number, dtFato: string, causa: string, motivo: string, codigo: string, ids: number[]) {
  return {
    id,
    dtFato: d(dtFato),
    causa,
    motivo,
    caixaOrigem: { codigo },
    animais: ids.map((idAnimal) => {
      const animal = (banco.animais as AnimalDoParto[]).find((a) => a.id === idAnimal)
      return { idAnimal, animal: { sexo: animal?.sexo ?? 'M', idParto: animal === undefined ? 12 : 9 } }
    }),
  }
}

/** Qual limite a consulta da trilha procura, pelo filtro que ela manda */
function limiteDa(onde: Onde): string {
  if (onde.motivo !== undefined) return 'selecao'
  const tipos = typeof onde.tipo === 'object' ? onde.tipo.in.join(',') : String(onde.tipo)
  return { 'mudanca,entrega': 'saida', 'mudanca,correcao,anulacao': 'chegada', 'baixa,mudanca,entrega': 'fato' }[tipos] ?? tipos
}

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    parto: { findUnique: async () => banco.parto },
    animal: { findMany: async () => banco.animais },
    ocorrencia: {
      findFirst: async ({ where }: { where: Onde }) => banco.trilha[limiteDa(where)] ?? null,
      findMany: async () => banco.baixas,
    },
  },
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const casal = { codigo: 'F1A', tipo: 'casal', estante: { numeroVisivel: 'E1' } }
const estoque = { codigo: 'F2C', tipo: 'estoque', estante: { numeroVisivel: 'E1' } }

let proximo = 1
const animal = (parcial: Partial<AnimalDoParto>): AnimalDoParto => ({
  id: proximo++,
  sexo: 'M',
  situacao: 'vivo',
  idCaixa: 1,
  idPedido: null,
  dtMovimento: null,
  dtSaida: null,
  caixa: casal,
  ...parcial,
})

/** 6 M e 5 F: 1 M e 1 F mortos na selecao, 1 F que nao chegou ao desmame, 1 M morto depois
 * do desmame no estoque, 2 M entregues, 1 F anulada (registro errado) e o resto vivo */
const ninhada = (): AnimalDoParto[] => [
  animal({ situacao: 'morto', dtSaida: d('2026-10-03') }),
  animal({ sexo: 'F', situacao: 'morto', dtSaida: d('2026-10-03') }),
  animal({ sexo: 'F', situacao: 'morto', dtSaida: d('2026-10-23') }),
  animal({ situacao: 'morto', dtSaida: d('2026-11-01'), idCaixa: 6, caixa: estoque }),
  animal({ situacao: 'entregue', dtSaida: d('2026-11-03'), idPedido: 2, idCaixa: 6, caixa: estoque }),
  animal({ situacao: 'entregue', dtSaida: d('2026-11-03'), idPedido: 2, idCaixa: 6, caixa: estoque }),
  animal({ sexo: 'F', situacao: 'anulado' }),
  animal({ idCaixa: 6, caixa: estoque, idPedido: 3 }),
  animal({ idCaixa: 6, caixa: estoque }),
  animal({ sexo: 'F' }),
  animal({ sexo: 'F', idPedido: 3 }),
]

beforeEach(() => {
  proximo = 1
  banco.trilha = {}
  banco.baixas = []
})

describe('contagens do parto contadas nos animais', () => {
  it('nascidos sao todos menos o anulado; baixas antes do desmame contam ate o dia do desmame', () => {
    const contagem = contarDoParto(d('2026-10-23'), ninhada())

    expect(contagem.nascidos).toEqual({ m: 6, f: 4 })
    expect(contagem.baixasAntesDoDesmame).toEqual({ m: 1, f: 2 })
    expect(contagem.desmamados).toEqual({ m: 5, f: 2 })
    expect(contagem.vivos).toEqual({ m: 2, f: 2 })
    expect(contagem.entregues).toEqual({ m: 2, f: 0 })
  })

  it('onde estao os vivos e quantos reservados ha em cada caixa e por pedido', () => {
    const contagem = contarDoParto(d('2026-10-23'), ninhada())

    expect(contagem.onde).toEqual([
      { idCaixa: 1, codigo: 'F1A', numeroVisivel: 'E1', tipo: 'casal', m: 0, f: 2, reservados: 1, pedidos: [{ idPedido: 3, m: 0, f: 1 }] },
      { idCaixa: 6, codigo: 'F2C', numeroVisivel: 'E1', tipo: 'estoque', m: 2, f: 0, reservados: 1, pedidos: [{ idPedido: 3, m: 1, f: 0 }] },
    ])
    expect(contagem.reservados).toEqual([{ idPedido: 3, m: 1, f: 1 }])
  })

  it('antes do desmame, toda morte e baixa antes do desmame, e nao ha desmamados', () => {
    const contagem = contarDoParto(null, ninhada())

    expect(contagem.baixasAntesDoDesmame).toEqual({ m: 2, f: 2 })
    expect(contagem.desmamados).toBeNull()
  })
})

describe('as baixas do aleitamento separadas pela causa', () => {
  /** a selecao (1 M e 1 F, eutanasia), a que nao chegou ao desmame (morte) e o morto depois do desmame */
  const causas = () =>
    new Map<number, string | null>([
      [1, 'eutanasia'],
      [2, 'eutanasia'],
      [3, 'morte'],
      [4, 'morte'],
    ])

  it('ate o dia do desmame: a eutanasia e o ajuste de ninhada, a morte e a morte no aleitamento', () => {
    expect(baixasDoAleitamento(d('2026-10-23'), ninhada(), causas())).toEqual({
      ajusteDeNinhada: { m: 1, f: 1 },
      // a femea que nao chegou ao desmame, no proprio dia dele; o macho de 01/11 ja estava desmamado
      mortesNoAleitamento: { m: 0, f: 1 },
    })
  })

  it('sem desmame, toda baixa e do aleitamento', () => {
    expect(baixasDoAleitamento(null, ninhada(), causas())).toEqual({
      ajusteDeNinhada: { m: 1, f: 1 },
      mortesNoAleitamento: { m: 1, f: 1 },
    })
  })
})

describe('cicloFicha', () => {
  it('as datas previstas saem da cadeia temporal, e a contagem dos animais', async () => {
    banco.parto = {
      id: 9,
      ordem: 2,
      dtAcasalamento: d('2026-09-08'),
      dtPartoReal: d('2026-10-01'),
      dtDesmameReal: d('2026-10-23'),
      dtSemNinhada: null,
      motivoSemNinhada: null,
      casal: { idCaixa: 1 },
    }
    banco.animais = ninhada()
    banco.baixas = [
      baixa(31, '2026-10-03', 'eutanasia', 'eutanasia de selecao', 'F1A', [1, 2]),
      baixa(32, '2026-10-23', 'morte', 'nao chegou ao desmame', 'F1A', [3]),
      // a baixa na caixa de estoque levou tambem um macho de outra ninhada, do parto 12
      baixa(33, '2026-11-01', 'morte', 'morte', 'F2C', [4, 99]),
    ]

    const ciclo = await cicloFicha(9)

    expect(ciclo).toMatchObject({
      id: 9,
      baixasAntesDoDesmame: { m: 1, f: 2 },
      ajusteDeNinhada: { m: 1, f: 1 },
      mortesNoAleitamento: { m: 0, f: 1 },
      ordem: 2,
      dtAcasalamento: '2026-09-08',
      dtPartoPrevisto: '2026-10-01',
      dtPartoReal: '2026-10-01',
      dtDesmamePrevisto: '2026-10-23',
      dtDesmameReal: '2026-10-23',
      dtSemNinhada: null,
      nascidoM: 6,
      nascidoF: 4,
      desmamadoM: 5,
      desmamadoF: 2,
      vivos: { m: 2, f: 2 },
      entregues: { m: 2, f: 0 },
      // sem nada na trilha, nada limita as correcoes
      dtUltimaSelecao: null,
      dtPrimeiraSaida: null,
      dtPrimeiroFato: null,
    })
    // cada baixa com os animais deste parto; a do desmame e a com outra ninhada marcadas
    expect(ciclo.baixas).toEqual([
      { idOcorrencia: 31, dtFato: '2026-10-03', causa: 'eutanasia', codigo: 'F1A', m: 1, f: 1, doDesmame: false, comOutraNinhada: false },
      { idOcorrencia: 32, dtFato: '2026-10-23', causa: 'morte', codigo: 'F1A', m: 0, f: 1, doDesmame: true, comOutraNinhada: false },
      { idOcorrencia: 33, dtFato: '2026-11-01', causa: 'morte', codigo: 'F2C', m: 1, f: 0, doDesmame: false, comOutraNinhada: true },
    ])
  })

  it('os limites das correcoes saem da trilha: a ultima selecao, a primeira saida (mudanca, entrega ou chegada fora) e o primeiro fato', async () => {
    banco.parto = {
      id: 9,
      ordem: 1,
      dtAcasalamento: d('2026-09-08'),
      dtPartoReal: d('2026-10-01'),
      dtDesmameReal: d('2026-10-23'),
      dtSemNinhada: null,
      motivoSemNinhada: null,
      casal: { idCaixa: 1 },
    }
    banco.animais = ninhada()
    banco.trilha = {
      selecao: { tipo: 'baixa', dtFato: d('2026-10-03') },
      saida: { tipo: 'mudanca', dtFato: d('2026-10-30') },
      chegada: { tipo: 'correcao', dtFato: d('2026-10-25') },
      fato: { tipo: 'baixa', dtFato: d('2026-10-03') },
    }

    expect(await cicloFicha(9)).toMatchObject({
      dtUltimaSelecao: '2026-10-03',
      // a chegada fora veio antes da primeira mudanca: e ela que limita o desmame
      dtPrimeiraSaida: '2026-10-25',
      dtPrimeiroFato: '2026-10-03',
    })

    banco.trilha.chegada = null
    expect((await cicloFicha(9)).dtPrimeiraSaida).toBe('2026-10-30')
  })

  it('o parto que nao nasceu nao tem nascido nem desmamado', async () => {
    banco.parto = {
      id: 10,
      ordem: 3,
      dtAcasalamento: d('2026-10-07'),
      dtPartoReal: null,
      dtDesmameReal: null,
      dtSemNinhada: d('2026-11-05'),
      motivoSemNinhada: 'casal separado sem prenhez',
      casal: { idCaixa: 1 },
    }
    banco.animais = []
    // sem animal nao ha trilha: a ficha nem pergunta (o que viesse dela seria de outro parto)
    banco.trilha = { selecao: { tipo: 'baixa', dtFato: d('2026-10-03') }, fato: { tipo: 'baixa', dtFato: d('2026-10-03') } }

    const ciclo = await cicloFicha(10)

    expect(ciclo).toMatchObject({
      nascidoM: null,
      nascidoF: null,
      desmamadoM: null,
      desmamadoF: null,
      dtPartoPrevisto: '2026-10-30',
      dtSemNinhada: '2026-11-05',
      motivoSemNinhada: 'casal separado sem prenhez',
      onde: [],
      dtUltimaSelecao: null,
      dtPrimeiraSaida: null,
      dtPrimeiroFato: null,
    })
  })

  it('parto inexistente e 404', async () => {
    banco.parto = null

    await expect(cicloFicha(99)).rejects.toEqual(expect.objectContaining({ status: 404 }))
  })
})
