import { describe, expect, it, vi } from 'vitest'
import {
  colunaDoEstoque,
  naCaixaDoCasal,
  reservadoNaCaixaDoCasal,
  reservadosPorCaixa,
  reservasNosLugares,
} from './estoque.ts'
import type { PartoComLugares } from './estoque.ts'
import { sexoParaVirarEstoque } from './estoque.service.ts'

// so a conta: nada aqui abre o banco
vi.mock('../../shared/prisma.ts', () => ({ prisma: {} }))

const saiu = new Date('2026-11-02T00:00:00.000Z')

/** Reserva do pedido 'pedido'; entregue quando 'entregue' */
const reserva = (id: number, qtdM: number, qtdF: number, entregue = false, pedido = 1) => ({
  id,
  qtdM,
  qtdF,
  remessa: { idSolicitacao: pedido, dtRealizada: entregue ? saiu : null },
})

/** Machos (M) ou femeas (F) do parto numa caixa de estoque */
const lote = (id: number, idCaixa: number, sexo: 'M' | 'F', qtd: number) => ({ id, idCaixa, qtd, caixa: { sexo } })

const desmamado = (
  m: number,
  f: number,
  compromissos: PartoComLugares['compromissos'] = [],
  lotes: PartoComLugares['lotes'] = [],
): PartoComLugares => ({
  id: 10,
  nascidoM: m,
  nascidoF: f,
  eutanasiadoM: 0,
  eutanasiadoF: 0,
  desmamadoM: m,
  desmamadoF: f,
  compromissos,
  lotes,
})

describe('o que fica na caixa do casal', () => {
  it('e o desmamado menos o entregue menos o que foi para o estoque', () => {
    const parto = desmamado(5, 4, [reserva(1, 1, 0, true)], [lote(1, 7, 'M', 2), lote(2, 8, 'F', 4)])

    expect(naCaixaDoCasal(parto)).toEqual({ m: 2, f: 0 })
  })

  it('antes do desmame e a ninhada mamando', () => {
    const mamando = { ...desmamado(5, 4), desmamadoM: null, desmamadoF: null, eutanasiadoM: 1, eutanasiadoF: 0 }

    expect(naCaixaDoCasal(mamando)).toEqual({ m: 4, f: 4 })
  })
})

describe('em que caixa esta cada reserva', () => {
  it('primeiro o que sobrou na caixa do casal, depois as caixas de estoque na ordem em que receberam', () => {
    // 6 machos: 1 na caixa do casal, 2 na caixa 7, 3 na caixa 8
    const parto = desmamado(6, 0, [reserva(1, 4, 0)], [lote(1, 7, 'M', 2), lote(2, 8, 'M', 3)])

    expect(reservasNosLugares(parto, 'M').get(1)).toEqual([
      { idCaixa: null, qtd: 1 },
      { idCaixa: 7, qtd: 2 },
      { idCaixa: 8, qtd: 1 },
    ])
  })

  it('a reserva mais antiga fica com os primeiros lugares', () => {
    const parto = desmamado(4, 0, [reserva(1, 2, 0), reserva(2, 2, 0, false, 2)], [lote(1, 7, 'M', 4)])

    const lugares = reservasNosLugares(parto, 'M')

    expect(lugares.get(1)).toEqual([{ idCaixa: 7, qtd: 2 }])
    expect(lugares.get(2)).toEqual([{ idCaixa: 7, qtd: 2 }])
  })

  it('a reserva ja entregue nao ocupa lugar', () => {
    const parto = desmamado(4, 0, [reserva(1, 2, 0, true), reserva(2, 2, 0)], [lote(1, 7, 'M', 2)])

    const lugares = reservasNosLugares(parto, 'M')

    expect(lugares.has(1)).toBe(false)
    expect(lugares.get(2)).toEqual([{ idCaixa: 7, qtd: 2 }])
  })

  it('a reserva que passa do que existe fica com menos lugar: e a falta', () => {
    const parto = desmamado(2, 0, [reserva(1, 3, 0)], [lote(1, 7, 'M', 2)])

    expect(reservasNosLugares(parto, 'M').get(1)).toEqual([{ idCaixa: 7, qtd: 2 }])
  })

  it('cada sexo tem os lugares dele', () => {
    const parto = desmamado(2, 2, [reserva(1, 1, 2)], [lote(1, 7, 'M', 2), lote(2, 8, 'F', 2)])

    expect(reservasNosLugares(parto, 'M').get(1)).toEqual([{ idCaixa: 7, qtd: 1 }])
    expect(reservasNosLugares(parto, 'F').get(1)).toEqual([{ idCaixa: 8, qtd: 2 }])
  })
})

describe('a coluna da caixa de estoque', () => {
  it('soma o reservado de cada caixa, de todos os partos dela', () => {
    const doParto10 = desmamado(3, 0, [reserva(1, 3, 0)], [lote(1, 7, 'M', 3)])
    const doParto11 = { ...desmamado(2, 0, [reserva(2, 1, 0)], [lote(2, 7, 'M', 2)]), id: 11 }

    expect(reservadosPorCaixa([doParto10, doParto11]).get(7)).toBe(4)
  })

  it('Reserva quando todos os animais estao reservados; senao Estoque', () => {
    expect(colunaDoEstoque(5, 5)).toBe('T')
    expect(colunaDoEstoque(5, 4)).toBe('E')
    expect(colunaDoEstoque(0, 0)).toBe('E')
  })
})

describe('a reserva que prende a caixa do casal em Pre-reserva', () => {
  it('a de animais que ja estao numa caixa de estoque nao prende', () => {
    const parto = desmamado(3, 0, [reserva(1, 3, 0)], [lote(1, 7, 'M', 3)])

    expect(reservadoNaCaixaDoCasal([parto])).toBe(0)
  })

  it('a de animais ainda na caixa do casal prende', () => {
    const parto = desmamado(3, 0, [reserva(1, 3, 0)], [lote(1, 7, 'M', 1)])

    expect(reservadoNaCaixaDoCasal([parto])).toBe(2)
  })

  it('a de ninhada que ainda nao nasceu prende: ela vai nascer na caixa do casal', () => {
    const naoNasceu = {
      ...desmamado(0, 0, [reserva(1, 2, 2)]),
      nascidoM: null,
      nascidoF: null,
      desmamadoM: null,
      desmamadoF: null,
    }

    expect(reservadoNaCaixaDoCasal([naoNasceu])).toBe(4)
  })
})

describe('a caixa do casal encerrado que vira de estoque no lugar', () => {
  const desmamados = (m: number, f: number, idLinhagem = 1) => ({
    ordem: 5,
    casal: 'AB',
    m,
    f,
    desmamado: true,
    idLinhagem,
    idParto: 10,
  })

  it('vira com o sexo que sobrou nela', () => {
    expect(sexoParaVirarEstoque(false, [desmamados(0, 4)])).toBe('F')
    expect(sexoParaVirarEstoque(false, [desmamados(3, 0), { ...desmamados(2, 0), idParto: 11 }])).toBe('M')
  })

  it('nao vira com casal ativo, filhote mamando, machos e femeas juntos, linhagens diferentes ou vazia', () => {
    expect(sexoParaVirarEstoque(true, [desmamados(0, 4)])).toBeNull()
    expect(sexoParaVirarEstoque(false, [{ ...desmamados(0, 4), desmamado: false }])).toBeNull()
    expect(sexoParaVirarEstoque(false, [desmamados(2, 4)])).toBeNull()
    expect(sexoParaVirarEstoque(false, [desmamados(2, 0), { ...desmamados(1, 0, 2), idParto: 11 }])).toBeNull()
    expect(sexoParaVirarEstoque(false, [])).toBeNull()
  })
})
