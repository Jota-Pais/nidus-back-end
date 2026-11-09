import { describe, expect, it } from 'vitest'
import { cabeNaReserva, faltaDaReserva, soltosNaAnulacao, temFalta } from './reserva.ts'
import type { SituacaoDoPedido } from './reserva.ts'

const pedido = { qtdM: 2, qtdF: 1, qtdQualquer: 2 }

describe('falta da reserva', () => {
  it('pedido coberto nao tem falta: machos e femeas acima do pedido cobrem o qualquer', () => {
    expect(faltaDaReserva(pedido, { m: 4, f: 1 })).toEqual({ m: 0, f: 0, qualquer: 0 })
    expect(faltaDaReserva(pedido, { m: 3, f: 2 })).toEqual({ m: 0, f: 0, qualquer: 0 })
  })

  it('a falta sai por sexo e no qualquer', () => {
    const falta = faltaDaReserva(pedido, { m: 1, f: 1 })

    expect(falta).toEqual({ m: 1, f: 0, qualquer: 2 })
    expect(temFalta(falta)).toBe(true)
  })

  it('macho a mais nao cobre femea que falta', () => {
    expect(faltaDaReserva(pedido, { m: 5, f: 0 })).toEqual({ m: 0, f: 1, qualquer: 0 })
  })
})

describe('teto da reserva, o mesmo do trigger do animal', () => {
  it('cabe ate qtd do sexo mais o qualquer, sem passar do total', () => {
    expect(cabeNaReserva(pedido, { m: 3, f: 1 }, 'M')).toBe(true)
    expect(cabeNaReserva(pedido, { m: 4, f: 0 }, 'M')).toBe(false)
    expect(cabeNaReserva(pedido, { m: 4, f: 0 }, 'F')).toBe(true)
    expect(cabeNaReserva(pedido, { m: 3, f: 2 }, 'F')).toBe(false)
  })
})

describe('reserva na anulacao da baixa', () => {
  const situacao = (status: string, tem: { m: number; f: number }): SituacaoDoPedido => ({
    status,
    pedido: { qtdM: 2, qtdF: 0, qtdQualquer: 0 },
    tem,
  })

  it('volta reservado o animal do pedido reservado que ainda o comporta', () => {
    const soltos = soltosNaAnulacao(
      [
        { id: 1, sexo: 'M', idPedido: 7 },
        { id: 2, sexo: 'M', idPedido: null },
      ],
      new Map([[7, situacao('reservado', { m: 1, f: 0 })]]),
    )

    expect(soltos).toEqual([])
  })

  it('volta livre o que passaria do pedido, contando os que ja voltaram na mesma anulacao', () => {
    const soltos = soltosNaAnulacao(
      [
        { id: 2, sexo: 'M', idPedido: 7 },
        { id: 1, sexo: 'M', idPedido: 7 },
      ],
      new Map([[7, situacao('reservado', { m: 1, f: 0 })]]),
    )

    expect(soltos).toEqual([2])
  })

  it('pedido aprovado, recusado ou entregue nao segura animal vivo: volta livre', () => {
    for (const status of ['aprovado', 'recusado', 'entregue']) {
      const soltos = soltosNaAnulacao(
        [{ id: 1, sexo: 'M', idPedido: 7 }],
        new Map([[7, situacao(status, { m: 0, f: 0 })]]),
      )

      expect(soltos, status).toEqual([1])
    }
  })
})
