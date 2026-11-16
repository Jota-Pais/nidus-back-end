import { describe, expect, it } from 'vitest'
import { baixaNoAleitamento, causaDe, classificarBaixa, contarBaixasDoAleitamento } from './causa.ts'
import type { MortoDaBaixa } from './causa.ts'

// A regra das baixas do aleitamento: a causa (morte ou eutanasia) e o dia da baixa diante do
// desmame do parto do animal

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const deCasal = (dtDesmameReal: string | null) => ({
  comCasal: true,
  dtDesmameReal: dtDesmameReal === null ? null : d(dtDesmameReal),
})

describe('a baixa no aleitamento', () => {
  it('do parto de casal: antes do desmame e no dia dele; depois, nao', () => {
    expect(baixaNoAleitamento(d('2026-10-20'), deCasal('2026-10-23'))).toBe(true)
    expect(baixaNoAleitamento(d('2026-10-23'), deCasal('2026-10-23'))).toBe(true)
    expect(baixaNoAleitamento(d('2026-10-24'), deCasal('2026-10-23'))).toBe(false)
  })

  it('sem desmame ainda, toda baixa e do aleitamento', () => {
    expect(baixaNoAleitamento(d('2026-12-01'), deCasal(null))).toBe(true)
  })

  it('a ninhada do cadastro inicial chegou desmamada: nunca e do aleitamento, nem no dia da entrada', () => {
    expect(baixaNoAleitamento(d('2026-11-10'), { comCasal: false, dtDesmameReal: d('2026-11-10') })).toBe(false)
  })
})

describe('a classe da baixa', () => {
  it('no aleitamento, a eutanasia e o ajuste de ninhada e a morte e a morte no aleitamento; depois, as comuns', () => {
    expect(classificarBaixa('eutanasia', true)).toBe('ajuste_de_ninhada')
    expect(classificarBaixa('morte', true)).toBe('morte_no_aleitamento')
    expect(classificarBaixa('eutanasia', false)).toBe('eutanasia')
    expect(classificarBaixa('morte', false)).toBe('morte')
  })

  it('a causa como o banco guarda: so eutanasia e eutanasia', () => {
    expect(causaDe('eutanasia')).toBe('eutanasia')
    expect(causaDe('morte')).toBe('morte')
    expect(causaDe(null)).toBe('morte')
  })

  it('a contagem por sexo deixa de fora o que e de depois do desmame e do cadastro inicial', () => {
    const morto = (campos: Partial<MortoDaBaixa>): MortoDaBaixa => ({
      sexo: 'M',
      dtSaida: d('2026-10-05'),
      causa: 'morte',
      parto: deCasal('2026-10-23'),
      ...campos,
    })

    expect(
      contarBaixasDoAleitamento([
        morto({ causa: 'eutanasia' }),
        morto({ causa: 'eutanasia', sexo: 'F' }),
        morto({ sexo: 'F', dtSaida: d('2026-10-23') }),
        morto({ dtSaida: d('2026-11-02') }),
        morto({ causa: 'eutanasia', dtSaida: d('2026-11-02') }),
        morto({ parto: { comCasal: false, dtDesmameReal: d('2026-11-10') } }),
      ]),
    ).toEqual({ ajusteDeNinhada: { m: 1, f: 1 }, mortesNoAleitamento: { m: 0, f: 1 } })
  })
})
