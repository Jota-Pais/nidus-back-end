import { describe, expect, it, vi } from 'vitest'
import { buscarAtendimento } from './motor.service.ts'

// O banco aqui e de mentira: 'caixa.findMany' devolve as caixas que cada teste deixou em
// 'banco', cada uma com um casal e um parto ja desmamado. Nada e gravado

const ENTREGA = '2026-12-31'
const agora = new Date('2026-10-30T12:00:00.000Z')

/** a data de nascimento de quem chega com 'idade' dias na entrega */
const nascidoHa = (idade: number) => new Date(Date.parse(`${ENTREGA}T00:00:00.000Z`) - idade * 86_400_000)

/** caixa 'id' com um parto que chega a entrega com 'idade' dias e 4 machos e 4 femeas livres */
const caixa = (id: number, idade: number) => ({
  id,
  face: 1,
  linha: 1,
  coluna: id,
  estado: 'R',
  estante: { numeroVisivel: '1', colunas: 12 },
  casais: [
    {
      identificacao: 'AB',
      partos: [
        {
          id,
          ordem: 1,
          dtPartoPrevisto: nascidoHa(idade),
          dtPartoReal: nascidoHa(idade),
          dtDesmameReal: new Date(`${ENTREGA}T00:00:00.000Z`),
          nascidoM: 5,
          nascidoF: 5,
          eutanasiadoM: 1,
          eutanasiadoF: 1,
          desmamadoM: 4,
          desmamadoF: 4,
          compromissos: [],
        },
      ],
    },
  ],
})

const banco = vi.hoisted(() => ({ caixas: [] as unknown[] }))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    especie: { findMany: async () => [{ id: 1, nome: 'Rato' }] },
    caixa: { findMany: async () => banco.caixas },
  },
}))

const pedido = { especie: 'rato', machos: 0, femeas: 0, qualquer: 1, dataEntrega: ENTREGA }

describe('faixa de idade na busca', () => {
  it('a faixa 21 a 40 aceita de faixaAceita(21).min a faixaAceita(40).max, do mais velho para o mais novo', async () => {
    banco.caixas = [caixa(1, 19), caixa(2, 20), caixa(3, 30), caixa(4, 44), caixa(5, 45)]

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    expect(busca.faixa).toEqual({ min: 20, max: 44 })
    expect(busca.candidatas.map((c) => c.idadeNaEntrega)).toEqual([44, 30, 20])
  })

  it('a idade exata aceita o mesmo de antes, pela proximidade', async () => {
    banco.caixas = [caixa(1, 24), caixa(2, 31), caixa(3, 28), caixa(4, 32)]

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 28, idadeMax: 28 }, agora)

    expect(busca.faixa).toEqual({ min: 25, max: 31 })
    expect(busca.candidatas.map((c) => c.idadeNaEntrega)).toEqual([28, 31])
  })
})

describe('deficit e acasalamento novo', () => {
  it('o deficit traz o qualquer que nem a sobra cobriu, e os casais contam com ele', async () => {
    banco.caixas = [caixa(1, 30)]

    const busca = await buscarAtendimento(
      { ...pedido, machos: 4, femeas: 2, qualquer: 10, idadeMin: 21, idadeMax: 40 },
      agora,
    )

    expect(busca.candidatas.map((c) => c.alocar)).toEqual([{ m: 4, f: 4 }])
    expect(busca.deficit).toEqual({ m: 0, f: 0, qualquer: 8 })
    expect(busca.casaisAFormar).toBe(1)
  })

  it('a data minima do acasalamento novo e hoje + gestacao + idade minima', async () => {
    banco.caixas = []

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    // 30/10 + 23 + 21 dias. Com a idade maxima seria 01/01/2027, depois da entrega
    expect(busca.acasalamentoNovo).toEqual({ dataMinimaDeEntrega: '2026-12-13', viavel: true })
  })
})
