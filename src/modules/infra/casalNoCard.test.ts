import { describe, expect, it } from 'vitest'
import { casalNoCard, ninhadas, partoAtual, partoPrevisto, selecaoDoCasalNoCard } from './casalNoCard.ts'

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
  compromissos: [] as { qtdM: number; qtdF: number; remessa: { dtRealizada: Date | null } }[],
  lotes: [] as { qtd: number; caixa: { sexo: string | null } }[],
})

const reserva = (qtdM: number, qtdF: number, entregue: string | null) => ({
  qtdM,
  qtdF,
  remessa: { dtRealizada: entregue === null ? null : dia(entregue) },
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
    expect(casalNoCard([{ identificacao: 'AB', ativo: false, partos: [] }], 'R')).toBeNull()
    expect(casalNoCard([{ identificacao: 'AB', ativo: false, partos: [parto('2026-10-01')] }], 'R')).toBeNull()
    expect(casalNoCard([], 'R')).toBeNull()
  })

  it('mostra a ninhada do 5o parto depois do encerramento automatico', () => {
    const partos = ['06-01', '06-30', '07-29', '08-28', '09-26'].map((d) => parto(`2026-${d}`, `2026-${d}`))
    const casal = casalNoCard([{ identificacao: 'AB', ativo: false, partos }], 'R', '2026-11-06')
    expect(casal).toMatchObject({ identificacao: 'AB', partoAtual: 5, partoPrevisto: null, encerrado: true })
  })

  it('casal encerrado com filhote mamando fica aguardando desmame; desmamado, nao', () => {
    const mamando = parto('2026-10-20', '2026-10-20', { m: 3, f: 2 })
    expect(
      casalNoCard([{ identificacao: 'AB', ativo: false, partos: [mamando] }], 'R', '2026-11-06'),
    ).toMatchObject({ encerrado: true, aguardandoDesmame: true })

    const desmamado = { ...mamando, desmamadoM: 3, desmamadoF: 2 }
    expect(
      casalNoCard([{ identificacao: 'AB', ativo: false, partos: [desmamado] }], 'E', '2026-11-06'),
    ).toMatchObject({ encerrado: true, aguardandoDesmame: false })

    expect(
      casalNoCard([{ identificacao: 'AB', ativo: true, partos: [mamando] }], 'R', '2026-11-06'),
    ).toMatchObject({ aguardandoDesmame: false })
  })

  it('casal encerrado com a caixa ja enviada some do card', () => {
    const partos = [parto('2026-06-01', '2026-06-01')]
    expect(casalNoCard([{ identificacao: 'AB', ativo: false, partos }], 'X')).toBeNull()
  })

  it('casal encerrado a mao nao mostra a previsao do parto que nao vai acontecer', () => {
    const partos = [parto('2026-06-01', '2026-06-01'), parto('2026-06-30')]
    expect(casalNoCard([{ identificacao: 'AB', ativo: false, partos }], 'E')?.partoPrevisto).toBeNull()
  })

  it('tira o espaco que o char(2) do banco deixa', () => {
    const casal = casalNoCard([{ identificacao: 'AB ', ativo: true, partos: [parto('2026-10-20')] }], 'R')
    expect(casal).toEqual({
      identificacao: 'AB',
      partoAtual: 1,
      partoPrevisto: '2026-10-20',
      encerrado: false,
      aguardandoDesmame: false,
      ninhadas: [],
    })
  })

  it('a consulta do card e da grade traz todos os casais da caixa, o ativo primeiro', () => {
    expect(selecaoDoCasalNoCard).not.toHaveProperty('take')
    expect(selecaoDoCasalNoCard.orderBy[0]).toEqual({ ativo: 'desc' })
  })

  it('casal novo na caixa nao esconde as ninhadas que o casal encerrado deixou nela', () => {
    // o primeiro da lista e o casal da caixa (o ativo); os outros vieram antes dele
    const novo = { identificacao: 'CD', ativo: true, partos: [parto('2026-11-20')] }
    const encerrado = {
      identificacao: 'AB',
      ativo: false,
      partos: [parto('2026-10-27', '2026-10-27', { m: 3, f: 4 }, 5)],
    }

    const casal = casalNoCard([novo, encerrado], 'R', '2026-11-06')

    expect(casal).toMatchObject({ identificacao: 'CD', partoAtual: 1, partoPrevisto: '2026-11-20' })
    expect(casal?.ninhadas).toEqual([{ casal: 'AB', parto: 5, m: 3, f: 4, idadeDias: 10 }])
  })

  it('casal novo encerrado sem ninhada ainda mostra a ninhada do casal de antes', () => {
    const novo = { identificacao: 'CD', ativo: false, partos: [parto('2026-11-20')] }
    const encerrado = { identificacao: 'AB', ativo: false, partos: [parto('2026-10-27', '2026-10-27', { m: 3, f: 4 }, 5)] }

    expect(casalNoCard([novo, encerrado], 'E', '2026-11-06')?.ninhadas).toHaveLength(1)
    expect(casalNoCard([novo, encerrado], 'X', '2026-11-06')).toBeNull()
  })
})

describe('ninhadas - os animais que existem na caixa', () => {
  it('so conta o que nasceu, cada ninhada com a idade dela', () => {
    const partos = [
      parto('2026-10-27', '2026-10-27', { m: 1, f: 0 }, 1),
      parto('2026-11-06', '2026-11-06', { m: 2, f: 0 }, 2),
      parto('2026-12-01', null, undefined, 3),
    ]

    expect(ninhadas({ identificacao: 'AB', partos }, '2026-11-06')).toEqual([
      { casal: 'AB', parto: 1, m: 1, f: 0, idadeDias: 10 },
      { casal: 'AB', parto: 2, m: 2, f: 0, idadeDias: 0 },
    ])
  })

  it('a ninhada desmamada conta o desmamado, e a selecionada o nascido menos a selecao', () => {
    const desmamado = { ...parto('2026-10-01', '2026-10-01', { m: 6, f: 5 }), desmamadoM: 4, desmamadoF: 4 }
    const selecionado = { ...parto('2026-10-20', '2026-10-20', { m: 6, f: 5 }, 2), eutanasiadoM: 1, eutanasiadoF: 2 }

    expect(ninhadas({ identificacao: 'AB', partos: [desmamado, selecionado] }, '2026-11-06')).toEqual([
      { casal: 'AB', parto: 1, m: 4, f: 4, idadeDias: 36 },
      { casal: 'AB', parto: 2, m: 5, f: 3, idadeDias: 17 },
    ])
  })

  it('o que ja foi entregue saiu da caixa; a reserva ainda nao entregue continua nela', () => {
    const entregaParcial = {
      ...parto('2026-10-01', '2026-10-01', { m: 5, f: 5 }),
      compromissos: [reserva(2, 1, '2026-11-03'), reserva(1, 1, null)],
    }

    expect(ninhadas({ identificacao: 'AB', partos: [entregaParcial] }, '2026-11-06')).toEqual([
      { casal: 'AB', parto: 1, m: 3, f: 4, idadeDias: 36 },
    ])
  })

  it('a ninhada toda entregue sai do card', () => {
    const toda = { ...parto('2026-10-01', '2026-10-01', { m: 2, f: 1 }), compromissos: [reserva(2, 1, '2026-11-03')] }
    const outra = parto('2026-10-30', '2026-10-30', { m: 3, f: 3 }, 2)

    expect(ninhadas({ identificacao: 'AB', partos: [toda, outra] }, '2026-11-06')).toEqual([
      { casal: 'AB', parto: 2, m: 3, f: 3, idadeDias: 7 },
    ])
  })
})

describe('ninhada que foi para o estoque', () => {
  const desmamada = (m: number, f: number) => ({
    ...parto('2026-10-01', '2026-10-01', { m, f }),
    desmamadoM: m,
    desmamadoF: f,
  })

  it('o que foi para uma caixa de estoque ja nao esta na caixa do casal', () => {
    const parte = { ...desmamada(5, 4), lotes: [{ qtd: 3, caixa: { sexo: 'M' } }] }

    expect(ninhadas({ identificacao: 'AB', partos: [parte] }, '2026-11-06')).toEqual([
      { casal: 'AB', parto: 1, m: 2, f: 4, idadeDias: 36 },
    ])
  })

  it('a ninhada que foi toda para o estoque sai do card do casal', () => {
    const toda = {
      ...desmamada(5, 4),
      lotes: [
        { qtd: 5, caixa: { sexo: 'M' } },
        { qtd: 4, caixa: { sexo: 'F' } },
      ],
    }

    expect(ninhadas({ identificacao: 'AB', partos: [toda] }, '2026-11-06')).toEqual([])
  })
})
