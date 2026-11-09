import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buscarAtendimento, janelaDeFormarCasais } from './motor.service.ts'

// O banco aqui e de mentira: os vivos livres que cada teste deixa em 'banco', cada parto numa
// caixa. Nada e gravado

const ENTREGA = '2026-12-31'
const agora = new Date('2026-10-30T12:00:00.000Z')

/** a data de nascimento de quem chega com 'idade' dias na entrega */
const nascidoHa = (idade: number) => new Date(Date.parse(`${ENTREGA}T00:00:00.000Z`) - idade * 86_400_000)

type Parto = { id: number; ordem: number; dtPartoReal: Date; dtDesmameReal: Date | null; casal: { identificacao: string } }

const banco = vi.hoisted(() => ({
  linhas: [] as unknown[],
  partos: [] as unknown[],
  onde: null as unknown,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    especie: { findMany: async () => [{ id: 1, nome: 'Rato' }] },
    animal: {
      groupBy: async ({ where }: { where: unknown }) => {
        banco.onde = where
        return banco.linhas
      },
    },
    caixa: {
      findMany: async ({ where }: { where: { id: { in: number[] } } }) =>
        where.id.in.map((id) => ({
          id,
          codigo: `F1${'ABCDEFGHIJ'[id - 1]}`,
          tipo: id > 5 ? 'estoque' : 'casal',
          estante: { numeroVisivel: '1' },
        })),
    },
    parto: { findMany: async () => banco.partos },
  },
}))

/** um parto que chega a entrega com 'idade' dias, com 'm' machos e 'f' femeas livres na caixa */
function livres(idCaixa: number, idParto: number, idade: number, m: number, f: number, { desmamado = true } = {}) {
  const parto: Parto = {
    id: idParto,
    ordem: 1,
    dtPartoReal: nascidoHa(idade),
    dtDesmameReal: desmamado ? new Date('2026-10-01T00:00:00.000Z') : null,
    casal: { identificacao: idParto % 2 === 0 ? 'CD' : 'AB' },
  }
  banco.partos.push(parto)
  if (m > 0) banco.linhas.push({ idCaixa, idParto, sexo: 'M', _count: { _all: m } })
  if (f > 0) banco.linhas.push({ idCaixa, idParto, sexo: 'F', _count: { _all: f } })
}

const pedido = { especie: 'rato', idLinhagem: 3, machos: 0, femeas: 0, qualquer: 1, dataEntrega: ENTREGA }

beforeEach(() => {
  banco.linhas = []
  banco.partos = []
  banco.onde = null
})

describe('o que a busca le', () => {
  it('so os vivos livres da linhagem, nas caixas da especie', async () => {
    await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    expect(banco.onde).toEqual({
      situacao: 'vivo',
      idPedido: null,
      caixa: { idEspecie: 1 },
      parto: { casal: { idLinhagem: 3 } },
    })
  })
})

describe('faixa de idade na busca', () => {
  it('a faixa 21 a 40 aceita de faixaAceita(21).min a faixaAceita(40).max, a pedida antes da tolerancia', async () => {
    ;[19, 20, 21, 30, 40, 44, 45].forEach((idade, i) => livres(i + 1, i + 1, idade, 4, 4))

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    expect(busca.faixa).toEqual({ min: 20, max: 44 })
    // de 21 a 40 do mais velho para o mais novo; depois 44 e 20, que so entram pela tolerancia
    expect(busca.candidatas.map((c) => c.idadeNaEntrega)).toEqual([40, 30, 21, 44, 20])
  })

  it('a idade exata aceita o mesmo de antes, pela proximidade', async () => {
    ;[24, 31, 28, 32].forEach((idade, i) => livres(i + 1, i + 1, idade, 4, 4))

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 28, idadeMax: 28 }, agora)

    expect(busca.faixa).toEqual({ min: 25, max: 31 })
    expect(busca.candidatas.map((c) => c.idadeNaEntrega)).toEqual([28, 31])
  })
})

describe('a candidata e um lugar: a caixa e a data de nascimento', () => {
  it('partos do mesmo dia na mesma caixa viram um lugar so, com os livres somados e os partos de origem', async () => {
    livres(6, 1, 30, 3, 0)
    livres(6, 2, 30, 2, 0)

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    expect(busca.candidatas).toEqual([
      expect.objectContaining({
        idCaixa: 6,
        codigo: 'F1F',
        numeroVisivel: '1',
        tipo: 'estoque',
        dtNascimento: '2026-12-01',
        idadeNaEntrega: 30,
        origem: 'de_fato',
        livres: { m: 5, f: 0 },
        partos: [
          { ordem: 1, casal: 'AB' },
          { ordem: 1, casal: 'CD' },
        ],
      }),
    ])
  })

  it('o mesmo parto em duas caixas sao dois lugares', async () => {
    livres(1, 1, 30, 0, 2)
    banco.linhas.push({ idCaixa: 6, idParto: 1, sexo: 'M', _count: { _all: 4 } })

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    expect(busca.candidatas.map((c) => [c.idCaixa, c.livres])).toEqual(
      expect.arrayContaining([
        [1, { m: 0, f: 2 }],
        [6, { m: 4, f: 0 }],
      ]),
    )
  })

  it('a ninhada que ainda mama entra como previsao, se desmamar ate a entrega; senao fica de fora', async () => {
    livres(1, 1, 30, 4, 4, { desmamado: false })
    livres(2, 3, 10, 4, 4, { desmamado: false })

    const busca = await buscarAtendimento({ ...pedido, idadeMin: 5, idadeMax: 40 }, agora)

    expect(busca.candidatas.map((c) => [c.idCaixa, c.origem])).toEqual([[1, 'previsao']])
  })
})

describe('deficit e acasalamento novo', () => {
  it('o deficit traz o qualquer que nem a sobra cobriu, e os casais contam com ele', async () => {
    livres(1, 1, 30, 4, 4)

    const busca = await buscarAtendimento(
      { ...pedido, machos: 4, femeas: 2, qualquer: 10, idadeMin: 21, idadeMax: 40 },
      agora,
    )

    expect(busca.candidatas.map((c) => c.alocar)).toEqual([{ m: 4, f: 4 }])
    expect(busca.deficit).toEqual({ m: 0, f: 0, qualquer: 8 })
    expect(busca.casaisAFormar).toBe(1)
    // 8 de qualquer sexo: 1 acasalamento com ninhadas de 5 de cada sexo, 2 com ninhadas de 3
    expect(busca.acasalamentoNovo.acasalamentos).toEqual({ min: 1, max: 2 })
  })

  it('a data minima do acasalamento novo e hoje + gestacao + idade minima', async () => {
    const busca = await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    // 30/10 + 23 + 21 dias. Com a idade maxima seria 01/01/2027, depois da entrega
    expect(busca.acasalamentoNovo).toMatchObject({ dataMinimaDeEntrega: '2026-12-13', viavel: true })
  })

  it('os casais novos se formam numa janela: nem os filhotes passam da faixa, nem chegam sem desmamar', async () => {
    const busca = await buscarAtendimento({ ...pedido, idadeMin: 21, idadeMax: 40 }, agora)

    // faixa 20 a 44 dias na entrega (31/12), mas desmamados so a partir de 22: formados de
    // 31/12 - 23 - 44 - 4 de cio ate 31/12 - 23 - 22
    expect(busca.acasalamentoNovo.formarCasais).toEqual({ de: '2026-10-21', ate: '2026-11-16' })
  })

  it('na idade exata, a janela e o cio antes do unico dia da gestacao exata', async () => {
    const busca = await buscarAtendimento(
      { ...pedido, idadeMin: 21, idadeMax: 21, dataEntrega: '2026-12-01' },
      agora,
    )

    // 21 dias aceita de 20 a 22, e desmamado so com 22: 01/12 - 23 - 22, ou ate 4 dias antes
    expect(busca.acasalamentoNovo.formarCasais).toEqual({ de: '2026-10-13', ate: '2026-10-17' })
  })
})

describe('janelaDeFormarCasais', () => {
  it('sem idade da faixa que chegue desmamada, nao ha janela', () => {
    expect(janelaDeFormarCasais({ min: 10, max: 20 }, '2026-12-31')).toBeNull()
  })
})
