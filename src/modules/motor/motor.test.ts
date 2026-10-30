import { describe, expect, it } from 'vitest'
import { casaisParaODeficit, faixaAceita, faixaDoPedido, ordenar, sugerirAlocacao } from './motor.ts'
import type { Candidata } from './motor.ts'

describe('faixa de idade aceita', () => {
  it('segue os exemplos da spec', () => {
    expect(faixaAceita(21)).toEqual({ min: 20, max: 22 })
    expect(faixaAceita(28)).toEqual({ min: 25, max: 31 })
    expect(faixaAceita(55)).toEqual({ min: 48, max: 62 })
    expect(faixaAceita(120)).toEqual({ min: 105, max: 135 })
  })

  it('a faixa do pedido tem a tolerancia nas pontas', () => {
    expect(faixaDoPedido({ min: 21, max: 40 })).toEqual({ min: 20, max: 44 })
    expect(faixaDoPedido({ min: 45, max: 100 })).toEqual({ min: 40, max: 115 })
  })

  it('abaixo de 21 dias a idade fica fora da tabela e usa a maior variacao', () => {
    // o caso 20..40 do combinado. So a busca do tecnico aceita idade abaixo de 21
    expect(faixaAceita(20)).toEqual({ min: 5, max: 35 })
    expect(faixaDoPedido({ min: 20, max: 40 })).toEqual({ min: 5, max: 44 })
  })

  it('a idade exata aceita o mesmo de antes', () => {
    expect(faixaDoPedido({ min: 28, max: 28 })).toEqual({ min: 25, max: 31 })
  })
})

const candidata = (id: number, origem: Candidata['origem'], idade: number, m: number, f: number): Candidata => ({
  idCaixa: id,
  idParto: id,
  origem,
  idadeNaEntrega: idade,
  disponivel: { m, f },
})

const exata = (idade: number) => ({ min: idade, max: idade })

describe('ordem das candidatas', () => {
  it('de fato antes de previsao, previsao antes de previsao de parto', () => {
    const ordem = ordenar(
      [candidata(1, 'previsao_parto', 28, 4, 4), candidata(2, 'previsao', 28, 4, 4), candidata(3, 'de_fato', 30, 4, 4)],
      exata(28),
    )
    expect(ordem.map((c) => c.idCaixa)).toEqual([3, 2, 1])
  })

  it('no mesmo grupo, a idade mais proxima da pedida vem primeiro', () => {
    const ordem = ordenar([candidata(1, 'de_fato', 31, 4, 4), candidata(2, 'de_fato', 28, 4, 4)], exata(28))
    expect(ordem.map((c) => c.idCaixa)).toEqual([2, 1])
  })

  it('com faixa, vai do mais velho para o mais novo, sem passar por cima da origem', () => {
    const ordem = ordenar(
      [
        candidata(1, 'de_fato', 22, 4, 4),
        candidata(2, 'previsao', 40, 4, 4),
        candidata(3, 'de_fato', 38, 4, 4),
        candidata(4, 'de_fato', 30, 4, 4),
        candidata(5, 'previsao', 25, 4, 4),
      ],
      { min: 20, max: 40 },
    )
    expect(ordem.map((c) => c.idCaixa)).toEqual([3, 4, 1, 2, 5])
  })

  it('com faixa, na mesma idade fica a que tem mais animais', () => {
    const ordem = ordenar([candidata(1, 'de_fato', 30, 1, 1), candidata(2, 'de_fato', 30, 4, 4)], { min: 21, max: 40 })
    expect(ordem.map((c) => c.idCaixa)).toEqual([2, 1])
  })
})

describe('sugestao de alocacao', () => {
  it('pega na ordem ate cobrir o pedido, sem passar do disponivel', () => {
    const { itens, deficit } = sugerirAlocacao(
      [candidata(1, 'de_fato', 28, 3, 5), candidata(2, 'previsao', 28, 4, 4), candidata(3, 'previsao', 28, 4, 4)],
      { m: 5, f: 5, qualquer: 0 },
    )

    expect(itens.map((i) => i.alocar)).toEqual([
      { m: 3, f: 5 },
      { m: 2, f: 0 },
      { m: 0, f: 0 },
    ])
    expect(itens.map((i) => i.sugerida)).toEqual([true, true, false])
    expect(deficit).toEqual({ m: 0, f: 0, qualquer: 0 })
  })

  it('o que o plantel nao cobre vira deficit', () => {
    const { deficit } = sugerirAlocacao([candidata(1, 'de_fato', 28, 2, 1)], { m: 10, f: 3, qualquer: 0 })
    expect(deficit).toEqual({ m: 8, f: 2, qualquer: 0 })
  })

  it('o qualquer sai da sobra, sem tirar animal de machos nem de femeas', () => {
    // a primeira caixa tem os 4 machos que o pedido quer: o qualquer nao pode pegar nenhum deles
    const { itens, deficit } = sugerirAlocacao(
      [candidata(1, 'de_fato', 28, 4, 0), candidata(2, 'de_fato', 28, 2, 1), candidata(3, 'previsao', 28, 0, 3)],
      { m: 4, f: 2, qualquer: 3 },
    )

    // as femeas pedidas saem da 2a e da 3a caixa; o qualquer, dos 2 machos que sobram na 2a e de
    // mais uma femea da 3a
    expect(itens.map((i) => i.alocar)).toEqual([
      { m: 4, f: 0 },
      { m: 2, f: 1 },
      { m: 0, f: 2 },
    ])
    expect(itens.map((i) => i.sugerida)).toEqual([true, true, true])
    expect(deficit).toEqual({ m: 0, f: 0, qualquer: 0 })
  })

  it('caixa que so serve ao qualquer entra como sugerida', () => {
    const { itens, deficit } = sugerirAlocacao(
      [candidata(1, 'de_fato', 28, 2, 0), candidata(2, 'de_fato', 28, 1, 1)],
      { m: 2, f: 0, qualquer: 5 },
    )

    expect(itens.map((i) => i.alocar)).toEqual([
      { m: 2, f: 0 },
      { m: 1, f: 1 },
    ])
    expect(itens.map((i) => i.sugerida)).toEqual([true, true])
    expect(deficit).toEqual({ m: 0, f: 0, qualquer: 3 })
  })
})

describe('casais para cobrir o deficit', () => {
  it('arredonda para cima pela expectativa de 4M/4F por casal', () => {
    expect(casaisParaODeficit({ m: 8, f: 2, qualquer: 0 })).toBe(2)
    expect(casaisParaODeficit({ m: 9, f: 0, qualquer: 0 })).toBe(3)
    expect(casaisParaODeficit({ m: 0, f: 0, qualquer: 0 })).toBe(0)
  })

  it('o qualquer conta no total, 8 por casal', () => {
    expect(casaisParaODeficit({ m: 0, f: 0, qualquer: 8 })).toBe(1)
    expect(casaisParaODeficit({ m: 0, f: 0, qualquer: 9 })).toBe(2)
    // 4 machos e 4 femeas ja enchem um casal: o qualquer pede o segundo
    expect(casaisParaODeficit({ m: 4, f: 4, qualquer: 1 })).toBe(2)
    // os machos ja pedem 3 casais, que sobram para o qualquer
    expect(casaisParaODeficit({ m: 12, f: 0, qualquer: 10 })).toBe(3)
  })
})
