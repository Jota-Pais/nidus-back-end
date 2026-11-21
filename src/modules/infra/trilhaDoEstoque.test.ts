import { beforeEach, describe, expect, it, vi } from 'vitest'
import { motivoLegivel, ondeDaTrilha, passagensDaCaixa, trilhaDaCaixa } from './trilhaDoEstoque.ts'
import type { OcorrenciaDaTrilha } from './trilhaDoEstoque.ts'

// A trilha lida nas ocorrencias: passagensDaCaixa e pura (as ocorrencias entram prontas), e o
// banco so aparece em trilhaDaCaixa, que faz uma leitura

const banco = vi.hoisted(() => ({ ocorrencias: [] as unknown[], chamadas: [] as unknown[] }))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    ocorrencia: {
      findMany: async (args: unknown) => {
        banco.chamadas.push(args)
        return banco.ocorrencias
      },
    },
  },
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const CAIXA = 7
const OUTRA = 8

const caixaDe = (id: number, codigo: string) => ({ id, codigo, estante: { numeroVisivel: 'E1' } })

type Animal = OcorrenciaDaTrilha['animais'][number]['animal']

/** Um animal; por padrao ja estava na trilha (nasceu ou entrou por uma ocorrencia) */
const animal = (parcial: Partial<Animal> = {}): { animal: Animal } => ({
  animal: {
    sexo: 'M',
    idCaixa: CAIXA,
    situacao: 'vivo',
    idParto: 10,
    parto: { ordem: 1, dtPartoReal: d('2026-09-24'), casal: { identificacao: 'AB ' } },
    ocorrencias: [{ idOcorrencia: 1 }],
    ...parcial,
  } as Animal,
})

const animais = (qtd: number, parcial: Partial<Animal> = {}) =>
  Array.from({ length: qtd }, () => animal(parcial))

let proximoId = 1
const ocorrencia = (parcial: Partial<OcorrenciaDaTrilha>): OcorrenciaDaTrilha => ({
  id: proximoId++,
  tipo: 'entrada',
  dtFato: d('2026-10-01'),
  causa: null,
  motivo: null,
  idCaixaOrigem: null,
  idCaixaDestino: null,
  idPedido: null,
  caixaOrigem: null,
  caixaDestino: null,
  animais: [],
  ...parcial,
})

beforeEach(() => {
  proximoId = 1
  banco.ocorrencias = []
  banco.chamadas = []
})

describe('passagensDaCaixa, um caso por tipo', () => {
  it('a entrada do cadastro inicial e chegada, com o parto sem ordem nem casal', () => {
    const passagens = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'entrada',
          idCaixaDestino: CAIXA,
          animais: animais(4, { parto: { ordem: null, dtPartoReal: d('2026-09-01'), casal: null } }),
        }),
      ],
      CAIXA,
    )

    expect(passagens).toEqual([
      {
        idOcorrencia: 1,
        dtFato: '2026-10-01',
        sentido: 'chegada',
        tipo: 'entrada',
        outraCaixa: null,
        idPedido: null,
        causa: null,
        motivo: null,
        m: 4,
        f: 0,
        origens: [{ idParto: 10, ordem: null, casal: null, dtNascimento: '2026-09-01', m: 4, f: 0 }],
      },
    ])
  })

  it('o nascimento na caixa de casal e chegada, com o casal sem espacos', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'nascimento',
          idCaixaDestino: CAIXA,
          animais: [...animais(2), ...animais(1, { sexo: 'F' })],
        }),
      ],
      CAIXA,
    )

    expect(passagem).toMatchObject({ tipo: 'nascimento', sentido: 'chegada', m: 2, f: 1 })
    expect(passagem?.origens).toEqual([
      { idParto: 10, ordem: 1, casal: 'AB', dtNascimento: '2026-09-24', m: 2, f: 1 },
    ])
  })

  it('a mudanca vinda de outra caixa e chegada, com a outra caixa', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'mudanca',
          idCaixaOrigem: OUTRA,
          idCaixaDestino: CAIXA,
          caixaOrigem: caixaDe(OUTRA, 'F1B'),
          caixaDestino: caixaDe(CAIXA, 'F1A'),
          animais: animais(3),
        }),
      ],
      CAIXA,
    )

    expect(passagem).toMatchObject({
      sentido: 'chegada',
      tipo: 'mudanca',
      outraCaixa: { id: OUTRA, codigo: 'F1B', numeroVisivel: 'E1' },
      m: 3,
    })
  })

  it('a mudanca para outra caixa e saida, com a caixa de destino', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'mudanca',
          idCaixaOrigem: CAIXA,
          idCaixaDestino: OUTRA,
          caixaOrigem: caixaDe(CAIXA, 'F1A'),
          caixaDestino: caixaDe(OUTRA, 'F1B'),
          animais: animais(2),
        }),
      ],
      CAIXA,
    )

    expect(passagem).toMatchObject({
      sentido: 'saida',
      outraCaixa: { id: OUTRA, codigo: 'F1B' },
      m: 2,
    })
  })

  it('a correcao so conta os animais a mais: sem ocorrencia de nascimento ou entrada e nao anulados', () => {
    const passagens = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'correcao',
          idCaixaDestino: CAIXA,
          motivo: 'contei errado',
          animais: [
            ...animais(2, { ocorrencias: [] }),
            animal({ ocorrencias: [{ idOcorrencia: 1 }] }),
            animal({ ocorrencias: [], situacao: 'anulado' }),
          ],
        }),
      ],
      CAIXA,
    )

    expect(passagens).toHaveLength(1)
    expect(passagens[0]).toMatchObject({
      tipo: 'correcao',
      sentido: 'chegada',
      m: 2,
      f: 0,
      motivo: 'contei errado',
    })
  })

  it('a correcao sem nenhum animal a mais nao e passagem', () => {
    expect(
      passagensDaCaixa(
        [ocorrencia({ tipo: 'correcao', idCaixaDestino: CAIXA, animais: animais(3) })],
        CAIXA,
      ),
    ).toEqual([])
  })

  it('a anulacao que devolveu animais para esta caixa e chegada', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'anulacao',
          idCaixaOrigem: OUTRA,
          idCaixaDestino: CAIXA,
          caixaOrigem: caixaDe(OUTRA, 'F1B'),
          motivo: 'lancada por engano',
          animais: animais(1),
        }),
      ],
      CAIXA,
    )

    expect(passagem).toMatchObject({
      tipo: 'anulacao',
      sentido: 'chegada',
      outraCaixa: { id: OUTRA },
      motivo: 'lancada por engano',
    })
  })

  it('a anulacao feita aqui que mandou os animais para outra caixa e saida', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'anulacao',
          idCaixaOrigem: CAIXA,
          idCaixaDestino: OUTRA,
          caixaDestino: caixaDe(OUTRA, 'F1B'),
          animais: animais(2),
        }),
      ],
      CAIXA,
    )

    expect(passagem).toMatchObject({
      tipo: 'anulacao',
      sentido: 'saida',
      outraCaixa: { id: OUTRA },
      m: 2,
    })
  })

  it('a anulacao que devolve para a propria caixa e ignorada', () => {
    expect(
      passagensDaCaixa(
        [
          ocorrencia({
            tipo: 'anulacao',
            idCaixaOrigem: CAIXA,
            idCaixaDestino: CAIXA,
            animais: animais(2),
          }),
        ],
        CAIXA,
      ),
    ).toEqual([])
  })

  it('a entrega e saida, so dos animais desta caixa, com o pedido', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'entrega',
          idPedido: 12,
          animais: [...animais(2), ...animais(3, { idCaixa: OUTRA })],
        }),
      ],
      CAIXA,
    )

    expect(passagem).toMatchObject({ tipo: 'entrega', sentido: 'saida', idPedido: 12, m: 2, f: 0 })
  })

  it('a baixa e saida, com a causa e o motivo legivel', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'baixa',
          idCaixaOrigem: CAIXA,
          causa: 'eutanasia',
          motivo: 'eutanasia de selecao',
          animais: animais(1),
        }),
      ],
      CAIXA,
    )

    expect(passagem).toMatchObject({
      tipo: 'baixa',
      sentido: 'saida',
      causa: 'eutanasia',
      motivo: 'eutanásia de seleção',
      idPedido: null,
    })
  })

  it('a causa desconhecida da baixa e morte', () => {
    const [passagem] = passagensDaCaixa(
      [ocorrencia({ tipo: 'baixa', idCaixaOrigem: CAIXA, causa: null, animais: animais(1) })],
      CAIXA,
    )

    expect(passagem).toMatchObject({ causa: 'morte', motivo: null })
  })
})

describe('passagensDaCaixa, as regras', () => {
  it('a mudanca com origem igual ao destino e descartada', () => {
    expect(
      passagensDaCaixa(
        [
          ocorrencia({
            tipo: 'mudanca',
            idCaixaOrigem: CAIXA,
            idCaixaDestino: CAIXA,
            animais: animais(2),
          }),
        ],
        CAIXA,
      ),
    ).toEqual([])
  })

  it('a ocorrencia sem nenhum animal e descartada', () => {
    expect(
      passagensDaCaixa([ocorrencia({ tipo: 'baixa', idCaixaOrigem: CAIXA, animais: [] })], CAIXA),
    ).toEqual([])
  })

  it('o motivo so aparece na baixa, na correcao e na anulacao', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'mudanca',
          idCaixaOrigem: OUTRA,
          idCaixaDestino: CAIXA,
          motivo: 'texto qualquer',
          animais: animais(1),
        }),
      ],
      CAIXA,
    )

    expect(passagem?.motivo).toBeNull()
  })

  it('vem do mais antigo ao mais novo, e no mesmo dia pela ordem do registro', () => {
    const passagens = passagensDaCaixa(
      [
        ocorrencia({ id: 30, tipo: 'baixa', idCaixaOrigem: CAIXA, dtFato: d('2026-10-05'), animais: animais(1) }),
        ocorrencia({ id: 22, tipo: 'baixa', idCaixaOrigem: CAIXA, dtFato: d('2026-10-03'), animais: animais(1) }),
        ocorrencia({ id: 21, tipo: 'entrada', idCaixaDestino: CAIXA, dtFato: d('2026-10-03'), animais: animais(1) }),
        ocorrencia({ id: 5, tipo: 'entrada', idCaixaDestino: CAIXA, dtFato: d('2026-10-01'), animais: animais(1) }),
      ],
      CAIXA,
    )

    expect(passagens.map((p) => p.idOcorrencia)).toEqual([5, 21, 22, 30])
  })

  it('as origens se agrupam por parto e vao pela data de nascimento', () => {
    const doParto = (idParto: number, nascimento: string, sexo: string, ordem = 1) =>
      animal({
        idParto,
        sexo,
        parto: { ordem, dtPartoReal: d(nascimento), casal: { identificacao: 'AB' } },
      })

    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'mudanca',
          idCaixaOrigem: OUTRA,
          idCaixaDestino: CAIXA,
          animais: [
            doParto(20, '2026-10-10', 'M', 2),
            doParto(10, '2026-09-24', 'M'),
            doParto(20, '2026-10-10', 'F', 2),
            doParto(10, '2026-09-24', 'M'),
          ],
        }),
      ],
      CAIXA,
    )

    expect(passagem?.origens).toEqual([
      { idParto: 10, ordem: 1, casal: 'AB', dtNascimento: '2026-09-24', m: 2, f: 0 },
      { idParto: 20, ordem: 2, casal: 'AB', dtNascimento: '2026-10-10', m: 1, f: 1 },
    ])
    expect(passagem).toMatchObject({ m: 3, f: 1 })
  })

  it('o parto sem data de nascimento tem dtNascimento nulo', () => {
    const [passagem] = passagensDaCaixa(
      [
        ocorrencia({
          tipo: 'entrada',
          idCaixaDestino: CAIXA,
          animais: animais(1, { parto: { ordem: null, dtPartoReal: null, casal: null } }),
        }),
      ],
      CAIXA,
    )

    expect(passagem?.origens[0]?.dtNascimento).toBeNull()
  })
})

describe('motivoLegivel', () => {
  it('traduz os motivos do sistema e deixa os do usuario como estao', () => {
    expect(motivoLegivel('eutanasia de selecao')).toBe('eutanásia de seleção')
    expect(motivoLegivel('nao chegou ao desmame')).toBe('não chegou ao desmame')
    expect(motivoLegivel('doente')).toBe('doente')
    expect(motivoLegivel(null)).toBeNull()
  })
})

describe('ondeDaTrilha', () => {
  it('le o que chega na caixa, o que sai dela, a baixa nao anulada e a entrega pelo animal', () => {
    expect(ondeDaTrilha(CAIXA)).toEqual({
      OR: [
        {
          tipo: { in: ['entrada', 'nascimento', 'mudanca', 'correcao', 'anulacao'] },
          idCaixaDestino: CAIXA,
        },
        { tipo: { in: ['mudanca', 'anulacao'] }, idCaixaOrigem: CAIXA },
        { tipo: 'baixa', idCaixaOrigem: CAIXA, anulacoes: { none: {} } },
        { tipo: 'entrega', animais: { some: { animal: { idCaixa: CAIXA } } } },
      ],
    })
  })
})

describe('trilhaDaCaixa', () => {
  it('faz uma leitura so, pela data e pelo id, e devolve as passagens', async () => {
    banco.ocorrencias = [
      ocorrencia({ tipo: 'entrada', idCaixaDestino: CAIXA, animais: animais(2) }),
      ocorrencia({ tipo: 'entrega', idPedido: 3, animais: animais(1) }),
    ]

    const trilha = await trilhaDaCaixa(CAIXA)

    expect(banco.chamadas).toHaveLength(1)
    expect(banco.chamadas[0]).toMatchObject({
      where: ondeDaTrilha(CAIXA),
      orderBy: [{ dtFato: 'asc' }, { id: 'asc' }],
    })
    expect(trilha.map((p) => [p.tipo, p.sentido, p.m])).toEqual([
      ['entrada', 'chegada', 2],
      ['entrega', 'saida', 1],
    ])
  })
})
