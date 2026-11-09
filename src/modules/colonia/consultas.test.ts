import { describe, expect, it } from 'vitest'
import { faltasDosPedidos, ninhadasNaCaixa, vivosPorCaixa } from './consultas.ts'

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const linha = (campos: Record<string, unknown>, qtd: number) => ({ ...campos, _count: { _all: qtd } })

describe('vivos por caixa', () => {
  it('conta os vivos e os reservados por sexo; caixa sem vivo fica zerada', async () => {
    const banco = {
      animal: {
        groupBy: async () => [
          linha({ idCaixa: 2, sexo: 'M', idPedido: null }, 6),
          linha({ idCaixa: 2, sexo: 'M', idPedido: 7 }, 4),
          linha({ idCaixa: 2, sexo: 'F', idPedido: 7 }, 1),
        ],
      },
    }

    const porCaixa = await vivosPorCaixa(banco as never, [2, 5])

    expect(porCaixa.get(2)).toEqual({ vivos: { m: 10, f: 1 }, reservados: { m: 4, f: 1 } })
    expect(porCaixa.get(5)).toEqual({ vivos: { m: 0, f: 0 }, reservados: { m: 0, f: 0 } })
  })
})

describe('ninhadas na caixa', () => {
  it('os vivos por parto, com o casal e se ja desmamou', async () => {
    const banco = {
      animal: {
        groupBy: async () => [linha({ idParto: 4, sexo: 'M' }, 5), linha({ idParto: 4, sexo: 'F' }, 3)],
      },
      parto: {
        findMany: async () => [{ id: 4, ordem: 2, dtDesmameReal: d('2026-10-23'), casal: { identificacao: 'AB' } }],
      },
    }

    expect(await ninhadasNaCaixa(banco as never, 1)).toEqual([
      { idParto: 4, ordem: 2, casal: 'AB', m: 5, f: 3, desmamado: true },
    ])
  })

  it('caixa sem vivo nao tem ninhada', async () => {
    const banco = { animal: { groupBy: async () => [] } }

    expect(await ninhadasNaCaixa(banco as never, 1)).toEqual([])
  })
})

describe('faltas dos pedidos', () => {
  const banco = {
    pedido: {
      findMany: async () => [
        { id: 9, status: 'reservado', qtdM: 2, qtdF: 2, qtdQualquer: 0 },
        { id: 3, status: 'reservado', qtdM: 1, qtdF: 0, qtdQualquer: 1 },
        { id: 5, status: 'entregue', qtdM: 3, qtdF: 0, qtdQualquer: 0 },
        { id: 6, status: 'reservado', qtdM: 1, qtdF: 0, qtdQualquer: 0 },
      ],
    },
    animal: {
      groupBy: async () => [
        linha({ idPedido: 9, sexo: 'M' }, 2),
        linha({ idPedido: 9, sexo: 'F' }, 1),
        linha({ idPedido: 3, sexo: 'M' }, 1),
        linha({ idPedido: 5, sexo: 'M' }, 2),
        linha({ idPedido: 6, sexo: 'M' }, 1),
      ],
    },
  }

  it('so o pedido reservado que ficou com menos do que pede, em ordem de pedido', async () => {
    expect(await faltasDosPedidos(banco as never, [9, 3, 5, 6])).toEqual([
      { idPedido: 3, m: 0, f: 0, qualquer: 1 },
      { idPedido: 9, m: 0, f: 1, qualquer: 0 },
    ])
  })

  it('sem pedido, sem consulta', async () => {
    expect(await faltasDosPedidos({} as never, [])).toEqual([])
  })
})
