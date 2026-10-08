import { describe, expect, it } from 'vitest'
import { casalNoCard, partoAtual, partoPrevisto } from './casalNoCard.ts'

const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const parto = (previsto: string, real: string | null = null) => ({
  dtPartoPrevisto: dia(previsto),
  dtPartoReal: real === null ? null : dia(real),
})

describe('parto atual - a bolinha colorida do card', () => {
  it('e 1 enquanto nenhum ou um parto foi confirmado', () => {
    expect(partoAtual([parto('2026-10-01')])).toBe(1)
    expect(partoAtual([parto('2026-10-01', '2026-10-02'), parto('2026-10-31')])).toBe(1)
  })

  it('avanca com cada parto confirmado a partir do segundo', () => {
    const partos = [
      parto('2026-06-01', '2026-06-01'),
      parto('2026-06-30', '2026-06-30'),
      parto('2026-07-29', '2026-07-30'),
      parto('2026-08-28'),
    ]
    expect(partoAtual(partos)).toBe(3)
  })
})

describe('parto previsto - o P:dd/mm do card', () => {
  it('e a previsao do primeiro parto sem data real', () => {
    expect(partoPrevisto([parto('2026-06-01', '2026-06-02'), parto('2026-07-01')])).toBe('2026-07-01')
  })

  it('e null quando todos ja foram confirmados', () => {
    expect(partoPrevisto([parto('2026-06-01', '2026-06-02')])).toBeNull()
  })
})

describe('casalNoCard', () => {
  it('nao mostra casal encerrado', () => {
    expect(casalNoCard({ identificacao: 'AB', ativo: false, partos: [] })).toBeNull()
    expect(casalNoCard(undefined)).toBeNull()
  })

  it('tira o espaco que o char(2) do banco deixa', () => {
    const casal = casalNoCard({ identificacao: 'AB ', ativo: true, partos: [parto('2026-10-20')] })
    expect(casal).toEqual({ identificacao: 'AB', partoAtual: 1, partoPrevisto: '2026-10-20' })
  })
})
