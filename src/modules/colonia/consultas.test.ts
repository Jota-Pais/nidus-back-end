import { describe, expect, it } from 'vitest'
import { faltasDosPedidos, ninhadasNaCaixa, vivosNasCaixas } from './consultas.ts'

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const linha = (campos: Record<string, unknown>, qtd: number) => ({ ...campos, _count: { _all: qtd } })

/** um parto lido para as contagens, com a caixa do casal de onde veio */
const parto = (id: number, ordem: number, nascimento: string, desmame: string | null, casal = 'AB') => ({
  id,
  ordem,
  idLinhagem: 3,
  dtPartoReal: d(nascimento),
  dtDesmameReal: desmame === null ? null : d(desmame),
  casal: { identificacao: casal, caixa: { id: 1, codigo: 'F1A', estante: { numeroVisivel: 'E1' } } },
})

/** a ninhada sem casal conhecido, do cadastro inicial: sem ordem e sem casal, desmamada na entrada */
const doCadastroInicial = (id: number, nascimento: string, desmame: string) => ({
  id,
  ordem: null,
  idLinhagem: 3,
  dtPartoReal: d(nascimento),
  dtDesmameReal: d(desmame),
  casal: null,
})

describe('vivos nas caixas', () => {
  const banco = {
    animal: {
      groupBy: async () => [
        linha({ idCaixa: 2, idParto: 4, sexo: 'M', idPedido: null }, 6),
        linha({ idCaixa: 2, idParto: 4, sexo: 'M', idPedido: 7 }, 3),
        linha({ idCaixa: 2, idParto: 6, sexo: 'M', idPedido: 7 }, 1),
        linha({ idCaixa: 2, idParto: 6, sexo: 'M', idPedido: 9 }, 2),
        linha({ idCaixa: 3, idParto: 6, sexo: 'F', idPedido: null }, 5),
      ],
    },
    parto: { findMany: async () => [parto(4, 1, '2026-09-01', '2026-09-23'), parto(6, 2, '2026-10-01', null, 'CD')] },
  }

  it('conta os vivos e os reservados por sexo, e os reservados de cada pedido na caixa', async () => {
    const caixa = (await vivosNasCaixas(banco as never, [2, 3, 5])).get(2)

    expect(caixa?.vivos).toEqual({ m: 12, f: 0 })
    expect(caixa?.reservados).toEqual({ m: 6, f: 0 })
    expect(caixa?.pedidos).toEqual([
      { idPedido: 7, m: 4, f: 0 },
      { idPedido: 9, m: 2, f: 0 },
    ])
  })

  it('separa os vivos por parto de origem, do nascimento mais antigo para o mais novo', async () => {
    const caixa = (await vivosNasCaixas(banco as never, [2, 3])).get(2)

    expect(caixa?.partos).toEqual([
      {
        idParto: 4,
        ordem: 1,
        casal: 'AB',
        idLinhagem: 3,
        dtNascimento: '2026-09-01',
        desmamado: true,
        caixaDoCasal: { idCaixa: 1, codigo: 'F1A', numeroVisivel: 'E1' },
        vivos: { m: 9, f: 0 },
        reservados: { m: 3, f: 0 },
      },
      expect.objectContaining({ idParto: 6, casal: 'CD', desmamado: false, vivos: { m: 3, f: 0 }, reservados: { m: 3, f: 0 } }),
    ])
  })

  it('um parto em duas caixas conta em cada uma so o que esta nela; caixa sem vivo fica zerada', async () => {
    const porCaixa = await vivosNasCaixas(banco as never, [2, 3, 5])

    expect(porCaixa.get(3)?.partos.map((p) => [p.idParto, p.vivos])).toEqual([[6, { m: 0, f: 5 }]])
    expect(porCaixa.get(5)).toEqual({ vivos: { m: 0, f: 0 }, reservados: { m: 0, f: 0 }, partos: [], pedidos: [] })
  })

  it('sem caixa, sem consulta', async () => {
    expect((await vivosNasCaixas({} as never, [])).size).toBe(0)
  })

  it('a ninhada do cadastro inicial vem sem ordem, sem casal e sem caixa do casal, com a linhagem do parto', async () => {
    const comEntrada = {
      animal: { groupBy: async () => [linha({ idCaixa: 8, idParto: 20, sexo: 'M', idPedido: null }, 6)] },
      parto: { findMany: async () => [doCadastroInicial(20, '2026-10-07', '2026-11-11')] },
    }

    expect((await vivosNasCaixas(comEntrada as never, [8])).get(8)?.partos).toEqual([
      {
        idParto: 20,
        ordem: null,
        casal: null,
        idLinhagem: 3,
        dtNascimento: '2026-10-07',
        desmamado: true,
        caixaDoCasal: null,
        vivos: { m: 6, f: 0 },
        reservados: { m: 0, f: 0 },
      },
    ])
    expect(await ninhadasNaCaixa(comEntrada as never, 8)).toEqual([
      { idParto: 20, ordem: null, casal: null, m: 6, f: 0, desmamado: true },
    ])
  })
})

describe('ninhadas na caixa', () => {
  it('os vivos por parto, com o casal e se ja desmamou', async () => {
    const banco = {
      animal: {
        groupBy: async () => [
          linha({ idCaixa: 1, idParto: 4, sexo: 'M', idPedido: null }, 5),
          linha({ idCaixa: 1, idParto: 4, sexo: 'F', idPedido: null }, 3),
        ],
      },
      parto: { findMany: async () => [parto(4, 2, '2026-10-01', '2026-10-23')] },
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
