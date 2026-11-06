import { describe, expect, it } from 'vitest'
import { casalNoCard, ninhadas, partoAtual, partoPrevisto } from './casalNoCard.ts'

const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const parto = (previsto: string, real: string | null = null, nascidos = { m: 0, f: 0 }, ordem = 1) => ({
  ordem,
  dtPartoPrevisto: dia(previsto),
  dtPartoReal: real === null ? null : dia(real),
  nascidoM: real === null ? null : nascidos.m,
  nascidoF: real === null ? null : nascidos.f,
  eutanasiadoM: null,
  eutanasiadoF: null,
  desmamadoM: null,
  desmamadoF: null,
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
  it('nao mostra casal encerrado sem ninhada', () => {
    expect(casalNoCard({ identificacao: 'AB', ativo: false, partos: [] }, 'R')).toBeNull()
    expect(casalNoCard({ identificacao: 'AB', ativo: false, partos: [parto('2026-10-01')] }, 'R')).toBeNull()
    expect(casalNoCard(undefined, 'R')).toBeNull()
  })

  it('mostra a ninhada do 5o parto depois do encerramento automatico', () => {
    const partos = ['06-01', '06-30', '07-29', '08-28', '09-26'].map((d) => parto(`2026-${d}`, `2026-${d}`))
    const casal = casalNoCard({ identificacao: 'AB', ativo: false, partos }, 'R', '2026-11-06')
    expect(casal).toMatchObject({ identificacao: 'AB', partoAtual: 5, partoPrevisto: null, encerrado: true })
  })

  it('casal encerrado com a caixa ja enviada some do card', () => {
    const partos = [parto('2026-06-01', '2026-06-01')]
    expect(casalNoCard({ identificacao: 'AB', ativo: false, partos }, 'X')).toBeNull()
  })

  it('casal encerrado a mao nao mostra a previsao do parto que nao vai acontecer', () => {
    const partos = [parto('2026-06-01', '2026-06-01'), parto('2026-06-30')]
    expect(casalNoCard({ identificacao: 'AB', ativo: false, partos }, 'E')?.partoPrevisto).toBeNull()
  })

  it('tira o espaco que o char(2) do banco deixa', () => {
    const casal = casalNoCard({ identificacao: 'AB ', ativo: true, partos: [parto('2026-10-20')] }, 'R')
    expect(casal).toEqual({
      identificacao: 'AB',
      partoAtual: 1,
      partoPrevisto: '2026-10-20',
      encerrado: false,
      ninhadas: [],
    })
  })
})

describe('ninhadas - os animais que existem na caixa', () => {
  it('so conta o que nasceu, cada ninhada com a idade dela', () => {
    const partos = [
      parto('2026-10-27', '2026-10-27', { m: 1, f: 0 }, 1),
      parto('2026-11-06', '2026-11-06', { m: 2, f: 0 }, 2),
      parto('2026-12-01', null, undefined, 3),
    ]

    expect(ninhadas(partos, '2026-11-06')).toEqual([
      { parto: 1, m: 1, f: 0, idadeDias: 10 },
      { parto: 2, m: 2, f: 0, idadeDias: 0 },
    ])
  })

  it('a ninhada desmamada conta o desmamado, e a selecionada o nascido menos a selecao', () => {
    const desmamado = { ...parto('2026-10-01', '2026-10-01', { m: 6, f: 5 }), desmamadoM: 4, desmamadoF: 4 }
    const selecionado = { ...parto('2026-10-20', '2026-10-20', { m: 6, f: 5 }, 2), eutanasiadoM: 1, eutanasiadoF: 2 }

    expect(ninhadas([desmamado, selecionado], '2026-11-06')).toEqual([
      { parto: 1, m: 4, f: 4, idadeDias: 36 },
      { parto: 2, m: 5, f: 3, idadeDias: 17 },
    ])
  })
})
