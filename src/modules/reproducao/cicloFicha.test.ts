import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnimalDoParto } from '../colonia/consultas.ts'
import { cicloFicha, contarDoParto } from './cicloFicha.ts'

// A ficha do parto conta os animais do parto, onde estiverem. O banco aqui devolve o parto e os
// animais montados no teste

const banco = vi.hoisted(() => ({
  parto: null as Record<string, unknown> | null,
  animais: [] as unknown[],
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    parto: { findUnique: async () => banco.parto },
    animal: { findMany: async () => banco.animais },
  },
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const casal = { codigo: 'F1A', tipo: 'casal', estante: { numeroVisivel: 'E1' } }
const estoque = { codigo: 'F2C', tipo: 'estoque', estante: { numeroVisivel: 'E1' } }

let proximo = 1
const animal = (parcial: Partial<AnimalDoParto>): AnimalDoParto => ({
  id: proximo++,
  sexo: 'M',
  situacao: 'vivo',
  idCaixa: 1,
  idPedido: null,
  dtMovimento: null,
  dtSaida: null,
  caixa: casal,
  ...parcial,
})

/** 6 M e 5 F: 1 M e 1 F mortos na selecao, 1 F que nao chegou ao desmame, 1 M morto depois
 * do desmame no estoque, 2 M entregues, 1 F anulada (registro errado) e o resto vivo */
const ninhada = (): AnimalDoParto[] => [
  animal({ situacao: 'morto', dtSaida: d('2026-10-03') }),
  animal({ sexo: 'F', situacao: 'morto', dtSaida: d('2026-10-03') }),
  animal({ sexo: 'F', situacao: 'morto', dtSaida: d('2026-10-23') }),
  animal({ situacao: 'morto', dtSaida: d('2026-11-01'), idCaixa: 6, caixa: estoque }),
  animal({ situacao: 'entregue', dtSaida: d('2026-11-03'), idPedido: 2, idCaixa: 6, caixa: estoque }),
  animal({ situacao: 'entregue', dtSaida: d('2026-11-03'), idPedido: 2, idCaixa: 6, caixa: estoque }),
  animal({ sexo: 'F', situacao: 'anulado' }),
  animal({ idCaixa: 6, caixa: estoque, idPedido: 3 }),
  animal({ idCaixa: 6, caixa: estoque }),
  animal({ sexo: 'F' }),
  animal({ sexo: 'F', idPedido: 3 }),
]

beforeEach(() => {
  proximo = 1
})

describe('contagens do parto contadas nos animais', () => {
  it('nascidos sao todos menos o anulado; baixas antes do desmame contam ate o dia do desmame', () => {
    const contagem = contarDoParto(d('2026-10-23'), ninhada())

    expect(contagem.nascidos).toEqual({ m: 6, f: 4 })
    expect(contagem.baixasAntesDoDesmame).toEqual({ m: 1, f: 2 })
    expect(contagem.desmamados).toEqual({ m: 5, f: 2 })
    expect(contagem.vivos).toEqual({ m: 2, f: 2 })
    expect(contagem.entregues).toEqual({ m: 2, f: 0 })
  })

  it('onde estao os vivos e quantos reservados ha em cada caixa e por pedido', () => {
    const contagem = contarDoParto(d('2026-10-23'), ninhada())

    expect(contagem.onde).toEqual([
      { idCaixa: 1, codigo: 'F1A', numeroVisivel: 'E1', tipo: 'casal', m: 0, f: 2, reservados: 1 },
      { idCaixa: 6, codigo: 'F2C', numeroVisivel: 'E1', tipo: 'estoque', m: 2, f: 0, reservados: 1 },
    ])
    expect(contagem.reservados).toEqual([{ idPedido: 3, m: 1, f: 1 }])
  })

  it('antes do desmame, toda morte e baixa antes do desmame, e nao ha desmamados', () => {
    const contagem = contarDoParto(null, ninhada())

    expect(contagem.baixasAntesDoDesmame).toEqual({ m: 2, f: 2 })
    expect(contagem.desmamados).toBeNull()
  })
})

describe('cicloFicha', () => {
  it('as datas previstas saem da cadeia temporal, e a contagem dos animais', async () => {
    banco.parto = {
      id: 9,
      ordem: 2,
      dtAcasalamento: d('2026-09-08'),
      dtPartoReal: d('2026-10-01'),
      dtDesmameReal: d('2026-10-23'),
      dtSemNinhada: null,
      motivoSemNinhada: null,
    }
    banco.animais = ninhada()

    const ciclo = await cicloFicha(9)

    expect(ciclo).toMatchObject({
      id: 9,
      ordem: 2,
      dtAcasalamento: '2026-09-08',
      dtPartoPrevisto: '2026-10-01',
      dtPartoReal: '2026-10-01',
      dtDesmamePrevisto: '2026-10-23',
      dtDesmameReal: '2026-10-23',
      dtSemNinhada: null,
      nascidoM: 6,
      nascidoF: 4,
      desmamadoM: 5,
      desmamadoF: 2,
      vivos: { m: 2, f: 2 },
      entregues: { m: 2, f: 0 },
    })
  })

  it('o parto que nao nasceu nao tem nascido nem desmamado', async () => {
    banco.parto = {
      id: 10,
      ordem: 3,
      dtAcasalamento: d('2026-10-07'),
      dtPartoReal: null,
      dtDesmameReal: null,
      dtSemNinhada: d('2026-11-05'),
      motivoSemNinhada: 'casal separado sem prenhez',
    }
    banco.animais = []

    const ciclo = await cicloFicha(10)

    expect(ciclo).toMatchObject({
      nascidoM: null,
      nascidoF: null,
      desmamadoM: null,
      desmamadoF: null,
      dtPartoPrevisto: '2026-10-30',
      dtSemNinhada: '2026-11-05',
      motivoSemNinhada: 'casal separado sem prenhez',
      onde: [],
    })
  })

  it('parto inexistente e 404', async () => {
    banco.parto = null

    await expect(cicloFicha(99)).rejects.toEqual(expect.objectContaining({ status: 404 }))
  })
})
