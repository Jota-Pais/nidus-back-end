import { describe, expect, it } from 'vitest'
import type { VivosDoParto, VivosNaCaixa } from '../colonia/consultas.ts'
import { casalNoCard, estoqueNoCard, gruposPorNascimento, lerCards, partoAtual, partoDaFase, partoPrevisto } from './card.ts'

const hoje = '2026-11-08'
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

/** os vivos de um parto numa caixa, como vivosNasCaixas devolve */
const doParto = (idParto: number, ordem: number, dtNascimento: string, vivos: [number, number], reservados: [number, number] = [0, 0], desmamado = true): VivosDoParto => ({
  idParto,
  ordem,
  casal: 'AB',
  idLinhagem: 3,
  dtNascimento,
  desmamado,
  caixaDoCasal: { idCaixa: 1, codigo: 'F1A', numeroVisivel: 'E1' },
  vivos: { m: vivos[0], f: vivos[1] },
  reservados: { m: reservados[0], f: reservados[1] },
})

const naCaixa = (partos: VivosDoParto[]): VivosNaCaixa => ({
  vivos: partos.reduce((s, p) => ({ m: s.m + p.vivos.m, f: s.f + p.vivos.f }), { m: 0, f: 0 }),
  reservados: partos.reduce((s, p) => ({ m: s.m + p.reservados.m, f: s.f + p.reservados.f }), { m: 0, f: 0 }),
  partos,
  pedidos: [],
})

const parto = (ordem: number, acasalamento: string, nascimento: string | null = null, semNinhada: string | null = null) => ({
  ordem,
  dtAcasalamento: d(acasalamento),
  dtPartoReal: nascimento === null ? null : d(nascimento),
  dtSemNinhada: semNinhada === null ? null : d(semNinhada),
})

describe('parto em curso e previsao', () => {
  it('o parto atual e o ultimo aberto, de 1 a 5', () => {
    expect(partoAtual([])).toBe(1)
    expect(partoAtual([parto(1, '2026-08-01', '2026-08-24'), parto(2, '2026-08-30')])).toBe(2)
  })

  it('a previsao e a do parto pendente: acasalamento + gestacao', () => {
    expect(partoPrevisto([parto(1, '2026-08-01', '2026-08-24'), parto(2, '2026-10-20')])).toBe('2026-11-12')
  })

  it('sem parto pendente nao ha previsao: o nascido e o fechado sem ninhada nao contam', () => {
    expect(partoPrevisto([parto(1, '2026-08-01', '2026-08-24')])).toBeNull()
    expect(partoPrevisto([parto(1, '2026-08-01', '2026-08-24'), parto(2, '2026-09-01', null, '2026-10-01')])).toBeNull()
  })
})

describe('o casal no card', () => {
  const casal = { identificacao: 'AB', ativo: true, partos: [parto(1, '2026-08-01', '2026-08-24'), parto(2, '2026-10-20')] }

  it('as ninhadas sao os vivos da caixa por parto, com a idade de hoje e se ainda mamam', () => {
    const card = casalNoCard(casal, naCaixa([doParto(4, 1, '2026-10-25', [5, 4], [2, 0], false)]), hoje)

    expect(card).toEqual({
      identificacao: 'AB',
      partoAtual: 2,
      partoDaFase: 1,
      partoPrevisto: '2026-11-12',
      encerrado: false,
      aguardandoDesmame: false,
      ninhadas: [{ casal: 'AB', parto: 1, m: 5, f: 4, idadeDias: 14, mamando: true }],
      reservado: 2,
    })
  })

  it('a ninhada que um casal anterior deixou na caixa aparece com o casal dela', () => {
    const anterior = { ...doParto(9, 5, '2026-09-01', [3, 0]), casal: 'CD' }
    const card = casalNoCard(casal, naCaixa([anterior]), hoje)

    expect(card?.ninhadas).toEqual([{ casal: 'CD', parto: 5, m: 3, f: 0, idadeDias: 68, mamando: false }])
  })

  it('o casal encerrado com filhote mamando fica aguardando o desmame', () => {
    const encerrado = { ...casal, ativo: false }

    expect(casalNoCard(encerrado, naCaixa([doParto(4, 1, '2026-10-25', [5, 4], [0, 0], false)]), hoje)).toMatchObject({
      encerrado: true,
      aguardandoDesmame: true,
    })
    expect(casalNoCard(encerrado, naCaixa([doParto(4, 1, '2026-09-25', [5, 4])]), hoje)?.aguardandoDesmame).toBe(false)
  })

  it('caixa sem vivo mostra o casal sem ninhada; sem casal, nao ha card de casal', () => {
    expect(casalNoCard(casal, naCaixa([]), hoje)).toMatchObject({ ninhadas: [], reservado: 0 })
    expect(casalNoCard(undefined, naCaixa([]), hoje)).toBeNull()
  })
})

describe('o numero do parto na celula acompanha a fase', () => {
  const partos = [parto(1, '2026-08-01', '2026-08-24'), parto(2, '2026-08-30')]
  const casal = { identificacao: 'AB', ativo: true, partos }

  it('parto 1 nascido e acasalamento 2 pendente: em aleitamento, numero 1', () => {
    const mamando = [doParto(4, 1, '2026-10-25', [5, 4], [0, 0], false)]

    expect(casalNoCard(casal, naCaixa(mamando), hoje)?.partoDaFase).toBe(1)
    expect(partoDaFase('mamando', partos, mamando)).toBe(1)
  })

  it('desmamado na caixa: numero do parto desmamado, o mais antigo se houver mais de um', () => {
    const desmamados = [doParto(5, 2, '2026-09-20', [2, 2]), doParto(4, 1, '2026-09-01', [3, 1])]

    expect(casalNoCard(casal, naCaixa(desmamados.slice(1)), hoje)?.partoDaFase).toBe(1)
    expect(partoDaFase('pronto_estoque', partos, desmamados)).toBe(1)
  })

  it('so o parto 2 pendente: acasalado, numero 2', () => {
    expect(casalNoCard(casal, naCaixa([]), hoje)?.partoDaFase).toBe(2)
  })
})

describe('o casal que ja estava no Nº parto quando foi cadastrado', () => {
  it('o parto atual e o de maior ordem, nao quantos partos o casal tem no Nidus', () => {
    expect(partoAtual([parto(3, '2026-09-01')])).toBe(3)
    expect(partoAtual([parto(3, '2026-09-01', '2026-09-24'), parto(4, '2026-09-30')])).toBe(4)
    expect(partoAtual([parto(5, '2026-09-01', '2026-09-24')])).toBe(5)
  })

  it('o card e a celula mostram o Nº parto: acasalado, em aleitamento e depois o seguinte', () => {
    const noTerceiro = { identificacao: 'AB', ativo: true, partos: [parto(3, '2026-10-20')] }
    expect(casalNoCard(noTerceiro, naCaixa([]), hoje)).toMatchObject({ partoAtual: 3, partoDaFase: 3, partoPrevisto: '2026-11-12' })

    const nascido = { ...noTerceiro, partos: [parto(3, '2026-09-30', '2026-10-23'), parto(4, '2026-10-29')] }
    const mamando = [doParto(4, 3, '2026-10-23', [4, 4], [0, 0], false)]
    expect(casalNoCard(nascido, naCaixa(mamando), hoje)).toMatchObject({
      partoAtual: 4,
      partoDaFase: 3,
      ninhadas: [{ casal: 'AB', parto: 3, m: 4, f: 4, mamando: true }],
    })
  })
})

describe('a caixa de estoque no card', () => {
  it('dentro da caixa so a idade distingue: partos do mesmo dia viram um grupo, do mais velho para o mais novo', () => {
    const grupos = gruposPorNascimento(
      [doParto(7, 2, '2026-10-01', [4, 0], [1, 0]), doParto(5, 1, '2026-09-01', [3, 0]), doParto(8, 3, '2026-10-01', [2, 0], [2, 0])],
      hoje,
    )

    expect(grupos.map(({ partos, ...grupo }) => ({ ...grupo, partos: partos.map((p) => p.idParto) }))).toEqual([
      { dtNascimento: '2026-09-01', idadeDias: 68, total: 3, reservados: 0, livres: 3, partos: [5] },
      { dtNascimento: '2026-10-01', idadeDias: 38, total: 6, reservados: 3, livres: 3, partos: [7, 8] },
    ])
  })

  it('o sexo e a linhagem da caixa, o total, o reservado e as idades por nascimento', () => {
    const card = estoqueNoCard(
      { sexo: 'F', idLinhagem: 3 },
      naCaixa([doParto(5, 1, '2026-09-01', [0, 3]), doParto(7, 2, '2026-10-01', [0, 4], [0, 4])]),
      hoje,
    )

    expect(card).toEqual({
      sexo: 'F',
      idLinhagem: 3,
      total: 7,
      reservado: 4,
      nascimentoDe: '2026-09-01',
      nascimentoAte: '2026-10-01',
      grupos: [
        { dtNascimento: '2026-09-01', idadeDias: 68, total: 3, reservados: 0 },
        { dtNascimento: '2026-10-01', idadeDias: 38, total: 4, reservados: 4 },
      ],
    })
  })

  it('a ninhada do cadastro inicial entra nos grupos por nascimento como qualquer outra', () => {
    const doCadastro: VivosDoParto = { ...doParto(9, 1, '2026-10-04', [6, 0]), ordem: null, casal: null, caixaDoCasal: null }
    const card = estoqueNoCard({ sexo: 'M', idLinhagem: 3 }, naCaixa([doCadastro, doParto(5, 1, '2026-09-19', [3, 0], [1, 0])]), hoje)

    expect(card).toMatchObject({
      total: 9,
      reservado: 1,
      nascimentoDe: '2026-09-19',
      nascimentoAte: '2026-10-04',
      grupos: [
        { dtNascimento: '2026-09-19', idadeDias: 50, total: 3, reservados: 1 },
        { dtNascimento: '2026-10-04', idadeDias: 35, total: 6, reservados: 0 },
      ],
    })
  })

  it('a caixa enviada nao tem vivo: total zero e sem idades', () => {
    expect(estoqueNoCard({ sexo: 'M', idLinhagem: 3 }, naCaixa([]), hoje)).toMatchObject({
      total: 0,
      reservado: 0,
      nascimentoDe: null,
      grupos: [],
    })
  })
})

describe('a leitura dos cards', () => {
  const caixa = (id: number, campos: Record<string, unknown>) => ({
    id,
    face: 1,
    linha: 1,
    coluna: id,
    codigo: `F1${'ABCDEFGH'[id - 1]}`,
    tipo: 'estoque',
    sexo: 'M',
    idLinhagem: 3,
    ativa: true,
    dtLiberacao: null,
    motivoLiberacao: null,
    estante: { numeroVisivel: 'E1' },
    linhagem: { nome: 'Wistar' },
    casais: [],
    ...campos,
  })
  const linha = (idCaixa: number, sexo: string, idPedido: number | null, qtd: number) => ({
    idCaixa,
    idParto: 4,
    sexo,
    idPedido,
    _count: { _all: qtd },
  })

  const banco = (caixas: unknown[], linhas: unknown[]) => ({
    caixa: { findMany: async () => caixas },
    animal: { groupBy: async () => linhas },
    parto: {
      findMany: async () => [
        {
          id: 4,
          ordem: 1,
          dtPartoReal: d('2026-09-01'),
          dtDesmameReal: d('2026-09-23'),
          casal: { identificacao: 'AB', idLinhagem: 3, caixa: { id: 1, codigo: 'F1A', estante: { numeroVisivel: 'E1' } } },
        },
      ],
    },
  })

  it('a fase de cada caixa sai do que ela tem, e a linhagem da caixa de estoque e a dela', async () => {
    const casal = { identificacao: 'AB', ativo: true, linhagem: { nome: 'Kyoto' }, partos: [parto(1, '2026-08-01', '2026-08-24')] }
    const cards = await lerCards(
      banco(
        [
          caixa(1, { tipo: 'casal', sexo: null, idLinhagem: null, linhagem: null, casais: [casal] }),
          caixa(2, {}),
          caixa(3, {}),
          caixa(4, { ativa: false, motivoLiberacao: 'entrega', dtLiberacao: d('2026-11-05') }),
        ],
        [linha(1, 'M', 9, 2), linha(2, 'M', null, 3), linha(2, 'M', 9, 1), linha(3, 'M', 9, 4)],
      ) as never,
      {},
      hoje,
    )

    // F1A: desmamados ainda na caixa do casal; a de estoque e estoque, reservada ou nao; a liberada nao tem fase
    expect(cards.map((c) => [c.codigo, c.fase, c.atrasado, c.linhagem])).toEqual([
      ['F1A', 'pronto_estoque', false, 'Kyoto'],
      ['F1B', 'estoque', false, 'Wistar'],
      ['F1C', 'estoque', false, 'Wistar'],
      ['F1D', null, false, 'Wistar'],
    ])
    expect(cards[0]?.casal).toMatchObject({ identificacao: 'AB', reservado: 2 })
    expect(cards[0]?.estoque).toBeNull()
    expect(cards[1]?.casal).toBeNull()
    expect(cards[1]?.estoque).toMatchObject({ sexo: 'M', idLinhagem: 3, total: 4, reservado: 1 })
  })

  it('a caixa liberada nao tem fase', async () => {
    const [card] = await lerCards(
      banco([caixa(1, { ativa: false, motivoLiberacao: 'baixa', dtLiberacao: d('2026-11-05') })], []) as never,
      {},
      hoje,
    )

    expect(card?.fase).toBeNull()
  })
})
