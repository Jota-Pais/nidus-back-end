import { describe, expect, it } from 'vitest'
import { casaisParaODeficit, faixaAceita, ordenar, sugerirAlocacao } from './motor.ts'
import type { Candidata } from './motor.ts'

// a tabela da secao 1.6 da spec do cliente
const FAIXAS = [
  { idadeMinDias: 21, idadeMaxDias: 22, variacaoDias: 1 },
  { idadeMinDias: 23, idadeMaxDias: 25, variacaoDias: 2 },
  { idadeMinDias: 26, idadeMaxDias: 30, variacaoDias: 3 },
  { idadeMinDias: 31, idadeMaxDias: 40, variacaoDias: 4 },
  { idadeMinDias: 41, idadeMaxDias: 50, variacaoDias: 5 },
  { idadeMinDias: 51, idadeMaxDias: 60, variacaoDias: 7 },
  { idadeMinDias: 61, idadeMaxDias: 90, variacaoDias: 10 },
  { idadeMinDias: 91, idadeMaxDias: null, variacaoDias: 15 },
]

describe('faixa de idade aceita', () => {
  it('segue os exemplos da spec', () => {
    expect(faixaAceita(21, FAIXAS)).toEqual({ min: 20, max: 22 })
    expect(faixaAceita(28, FAIXAS)).toEqual({ min: 25, max: 31 })
    expect(faixaAceita(55, FAIXAS)).toEqual({ min: 48, max: 62 })
    expect(faixaAceita(120, FAIXAS)).toEqual({ min: 105, max: 135 })
  })
})

const candidata = (id: number, origem: Candidata['origem'], idade: number, m: number, f: number): Candidata => ({
  idCaixa: id,
  idParto: id,
  origem,
  idadeNaEntrega: idade,
  disponivel: { m, f },
})

describe('ordem das candidatas', () => {
  it('de fato antes de previsao, previsao antes de previsao de parto', () => {
    const ordem = ordenar(
      [candidata(1, 'previsao_parto', 28, 4, 4), candidata(2, 'previsao', 28, 4, 4), candidata(3, 'de_fato', 30, 4, 4)],
      28,
    )
    expect(ordem.map((c) => c.idCaixa)).toEqual([3, 2, 1])
  })

  it('no mesmo grupo, a idade mais proxima da pedida vem primeiro', () => {
    const ordem = ordenar([candidata(1, 'de_fato', 31, 4, 4), candidata(2, 'de_fato', 28, 4, 4)], 28)
    expect(ordem.map((c) => c.idCaixa)).toEqual([2, 1])
  })
})

describe('sugestao de alocacao', () => {
  it('pega na ordem ate cobrir o pedido, sem passar do disponivel', () => {
    const { itens, deficit } = sugerirAlocacao(
      [candidata(1, 'de_fato', 28, 3, 5), candidata(2, 'previsao', 28, 4, 4), candidata(3, 'previsao', 28, 4, 4)],
      { m: 5, f: 5 },
    )

    expect(itens.map((i) => i.alocar)).toEqual([
      { m: 3, f: 5 },
      { m: 2, f: 0 },
      { m: 0, f: 0 },
    ])
    expect(itens.map((i) => i.sugerida)).toEqual([true, true, false])
    expect(deficit).toEqual({ m: 0, f: 0 })
  })

  it('o que o plantel nao cobre vira deficit', () => {
    const { deficit } = sugerirAlocacao([candidata(1, 'de_fato', 28, 2, 1)], { m: 10, f: 3 })
    expect(deficit).toEqual({ m: 8, f: 2 })
  })
})

describe('casais para cobrir o deficit', () => {
  it('arredonda para cima pela expectativa de 4M/4F por casal', () => {
    expect(casaisParaODeficit({ m: 8, f: 2 }, { m: 4, f: 4 })).toBe(2)
    expect(casaisParaODeficit({ m: 9, f: 0 }, { m: 4, f: 4 })).toBe(3)
    expect(casaisParaODeficit({ m: 0, f: 0 }, { m: 4, f: 4 })).toBe(0)
  })
})
