import { beforeEach, describe, expect, it, vi } from 'vitest'
import { linhaDaLiberada, listarLiberadas, ondeDasLiberadas } from './liberadas.service.ts'

// A lista das caixas liberadas: o where, a linha montada e as duas leituras, com o prisma de mentira

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const banco = vi.hoisted(() => ({
  findMany: vi.fn(),
  groupBy: vi.fn(),
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: { findMany: banco.findMany },
    animal: { groupBy: banco.groupBy },
  },
}))

type Caixa = Parameters<typeof linhaDaLiberada>[0]

const casal = (campos: Record<string, unknown> = {}) => ({
  id: 10,
  identificacao: 'AB',
  dtFormacao: d('2026-01-10'),
  dtEncerramento: d('2026-05-01'),
  motivoEncerramento: 'fim',
  linhagem: { id: 3, nome: 'Wistar' },
  partos: [],
  ...campos,
})

const caixa = (campos: Record<string, unknown> = {}): Caixa =>
  ({
    id: 1,
    codigo: 'F1A',
    tipo: 'casal',
    sexo: null,
    dtLiberacao: d('2026-06-01'),
    motivoLiberacao: 'casal_encerrado',
    linhagem: null,
    estante: { numeroVisivel: 'E1', sala: { nome: 'Sala 1' } },
    casais: [casal()],
    ...campos,
  }) as unknown as Caixa

describe('ondeDasLiberadas', () => {
  it('sempre pede a caixa inativa da especie', () => {
    expect(ondeDasLiberadas({ idEspecie: 2 })).toEqual({ idEspecie: 2, ativa: false })
  })

  it('a linhagem vale para a caixa de estoque ou para qualquer casal dela (OR)', () => {
    const onde = ondeDasLiberadas({ idEspecie: 2, idLinhagem: 7 })

    expect(onde.AND).toEqual([{ OR: [{ idLinhagem: 7 }, { casais: { some: { idLinhagem: 7 } } }] }])
  })

  it('a busca olha codigo, estante e identificacao do casal, sem diferenciar maiusculas', () => {
    const contem = { contains: 'ab', mode: 'insensitive' }

    expect(ondeDasLiberadas({ idEspecie: 2, busca: 'ab' }).AND).toEqual([
      { OR: [{ codigo: contem }, { estante: { numeroVisivel: contem } }, { casais: { some: { identificacao: contem } } }] },
    ])
  })

  it('de e ate viram gte e lte sobre a liberacao', () => {
    expect(ondeDasLiberadas({ idEspecie: 2, de: '2026-01-01' }).dtLiberacao).toEqual({ gte: d('2026-01-01') })
    expect(ondeDasLiberadas({ idEspecie: 2, ate: '2026-02-01' }).dtLiberacao).toEqual({ lte: d('2026-02-01') })
    expect(ondeDasLiberadas({ idEspecie: 2, de: '2026-01-01', ate: '2026-02-01' }).dtLiberacao).toEqual({
      gte: d('2026-01-01'),
      lte: d('2026-02-01'),
    })
  })

  it('sem de nem ate nao filtra a data', () => {
    expect(ondeDasLiberadas({ idEspecie: 2 })).not.toHaveProperty('dtLiberacao')
  })

  it('linhagem e busca juntas ficam no AND, cada uma com o seu OR', () => {
    const onde = ondeDasLiberadas({ idEspecie: 2, idLinhagem: 7, busca: 'x' })

    expect(onde.AND).toHaveLength(2)
  })
})

describe('linhaDaLiberada', () => {
  it('caixa de estoque: linhagem e sexo da caixa', () => {
    const linha = linhaDaLiberada(
      caixa({ tipo: 'estoque', sexo: 'M', linhagem: { id: 5, nome: 'Lewis' }, casais: [] }),
      new Map(),
    )

    expect(linha).toMatchObject({ tipo: 'estoque', sexo: 'M', linhagem: 'Lewis', idLinhagem: 5, casais: [] })
  })

  it('caixa de casal: linhagem do casal mais recente e sem sexo', () => {
    const linha = linhaDaLiberada(
      caixa({
        sexo: 'M',
        linhagem: { id: 9, nome: 'Da caixa' },
        casais: [casal(), casal({ id: 11, linhagem: { id: 4, nome: 'Antigo' } })],
      }),
      new Map(),
    )

    expect(linha).toMatchObject({ tipo: 'casal', sexo: null, linhagem: 'Wistar', idLinhagem: 3 })
  })

  it('sem linhagem nenhuma, linhagem e idLinhagem sao null', () => {
    const linha = linhaDaLiberada(caixa({ casais: [] }), new Map())

    expect(linha.linhagem).toBeNull()
    expect(linha.idLinhagem).toBeNull()
  })

  it('conta so os partos nascidos, o ultimo e os nascidos por parto (ausente = 0)', () => {
    const partos = [
      { id: 1, ordem: 1, dtPartoReal: d('2026-02-01') },
      { id: 2, ordem: 2, dtPartoReal: d('2026-03-01') },
      { id: 3, ordem: 3, dtPartoReal: null },
      { id: 4, ordem: null, dtPartoReal: d('2026-04-01') },
    ]
    const linha = linhaDaLiberada(
      caixa({ casais: [casal({ partos })] }),
      new Map([
        [1, 8],
        [2, 5],
      ]),
    )

    expect(linha.casais[0]).toMatchObject({ partos: 3, ultimoParto: 2, nascidos: 13 })
  })

  it('sem parto nascido: ultimoParto null e nascidos 0', () => {
    const linha = linhaDaLiberada(
      caixa({ casais: [casal({ partos: [{ id: 3, ordem: 1, dtPartoReal: null }] })] }),
      new Map(),
    )

    expect(linha.casais[0]).toMatchObject({ partos: 0, ultimoParto: null, nascidos: 0 })
  })

  it('apara a identificacao e escreve as datas em ISO, com null onde nao ha', () => {
    const linha = linhaDaLiberada(
      caixa({
        dtLiberacao: null,
        casais: [casal({ identificacao: 'AB ', dtEncerramento: null, motivoEncerramento: null })],
      }),
      new Map(),
    )

    expect(linha.dtLiberacao).toBeNull()
    expect(linha.casais[0]).toMatchObject({
      identificacao: 'AB',
      dtFormacao: '2026-01-10',
      dtEncerramento: null,
      motivoEncerramento: null,
    })
    expect(linhaDaLiberada(caixa(), new Map()).dtLiberacao).toBe('2026-06-01')
  })

  it('traz sala e numero da estante', () => {
    expect(linhaDaLiberada(caixa(), new Map())).toMatchObject({ sala: 'Sala 1', numeroVisivel: 'E1', codigo: 'F1A' })
  })
})

describe('listarLiberadas', () => {
  beforeEach(() => {
    banco.findMany.mockReset()
    banco.groupBy.mockReset()
    banco.groupBy.mockResolvedValue([])
  })

  const muitas = (n: number) => Array.from({ length: n }, (_, i) => caixa({ id: n - i, casais: [] }))

  it('le limite + 1, ordena pela liberacao e corta a sobra, com temMais', async () => {
    banco.findMany.mockResolvedValue(muitas(3))

    const r = await listarLiberadas({ idEspecie: 1, limite: 2 })

    expect(banco.findMany.mock.calls[0]?.[0]).toMatchObject({
      take: 3,
      where: { idEspecie: 1, ativa: false },
      orderBy: [{ dtLiberacao: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    })
    expect(r.caixas.map((c) => c.id)).toEqual([3, 2])
    expect(r.temMais).toBe(true)
  })

  it('exatamente o limite: temMais falso', async () => {
    banco.findMany.mockResolvedValue(muitas(2))

    const r = await listarLiberadas({ idEspecie: 1, limite: 2 })

    expect(r.caixas).toHaveLength(2)
    expect(r.temMais).toBe(false)
  })

  it('sem partos nao le os animais (so uma leitura)', async () => {
    banco.findMany.mockResolvedValue([caixa({ casais: [casal()] })])

    await listarLiberadas({ idEspecie: 1, limite: 50 })

    expect(banco.groupBy).not.toHaveBeenCalled()
  })

  it('com partos, uma unica contagem dos animais, sem os anulados, so dos partos da pagina', async () => {
    const partos = (ids: number[]) => ids.map((id) => ({ id, ordem: 1, dtPartoReal: d('2026-02-01') }))
    banco.findMany.mockResolvedValue([
      caixa({ id: 3, casais: [casal({ partos: partos([1, 2]) })] }),
      caixa({ id: 2, casais: [casal({ id: 11, partos: partos([3]) })] }),
      caixa({ id: 1, casais: [casal({ id: 12, partos: partos([99]) })] }),
    ])
    banco.groupBy.mockResolvedValue([
      { idParto: 1, _count: { _all: 4 } },
      { idParto: 2, _count: { _all: 6 } },
    ])

    const r = await listarLiberadas({ idEspecie: 1, limite: 2 })

    expect(banco.groupBy).toHaveBeenCalledTimes(1)
    expect(banco.groupBy.mock.calls[0]?.[0]).toMatchObject({
      by: ['idParto'],
      where: { idParto: { in: [1, 2, 3] }, situacao: { not: 'anulado' } },
    })
    expect(r.caixas[0]?.casais[0]?.nascidos).toBe(10)
    expect(r.caixas[1]?.casais[0]?.nascidos).toBe(0)
  })
})
