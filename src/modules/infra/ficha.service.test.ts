import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VivosDoParto, VivosNaCaixa } from '../colonia/consultas.ts'
import { exigirDepoisDaChegada } from '../colonia/escolha.ts'
import { montarFicha } from './ficha.service.ts'

// A ficha junta o que outros modulos ja sabem contar: a ficha de cada parto (cicloFicha), a do
// casal (casalFicha), os vivos da caixa (vivosNasCaixas) e os eventos (eventosDaCaixa). Aqui eles
// sao de mentira, e o teste confere como a ficha os junta

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const banco = vi.hoisted(() => ({
  caixa: null as Record<string, unknown> | null,
  partos: [] as { id: number; idCasal: number }[],
  ciclos: new Map<number, Record<string, unknown>>(),
  casais: new Map<number, Record<string, unknown>>(),
  vivos: null as unknown,
  desmamados: null as unknown,
  /** os vivos da caixa um a um: o pedido, a chegada e o nascimento */
  umAUm: [] as { idPedido: number | null; dtMovimento: Date | null; parto: { dtPartoReal: Date | null } }[],
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: { findUnique: async () => banco.caixa },
    animal: { findMany: async () => banco.umAUm },
    parto: {
      findMany: async ({ where }: { where: { idCasal: number } }) => banco.partos.filter((p) => p.idCasal === where.idCasal),
    },
  },
}))

vi.mock('../reproducao/cicloFicha.ts', () => ({ cicloFicha: async (id: number) => banco.ciclos.get(id) }))
vi.mock('../reproducao/reproducao.service.ts', () => ({ casalFicha: async (id: number) => banco.casais.get(id) }))

vi.mock('../colonia/consultas.ts', async (original) => ({
  ...(await original<typeof import('../colonia/consultas.ts')>()),
  vivosNasCaixas: async (_banco: unknown, ids: number[]) => new Map(ids.map((id) => [id, banco.vivos])),
}))

vi.mock('./eventos.ts', () => ({
  eventosDaCaixa: async (_idCaixa: number, desmamados: unknown) => {
    banco.desmamados = desmamados
    return [{ dataHora: '2026-10-01T00:00:00.000Z', tipo: 'nascimento', descricao: 'x', autor: 'Ana', idOcorrencia: 1, anulavel: false }]
  },
}))

const doParto = (idParto: number, dtNascimento: string, vivos: [number, number], reservados: [number, number] = [0, 0], campos: Partial<VivosDoParto> = {}): VivosDoParto => ({
  idParto,
  ordem: 1,
  casal: 'AB',
  idLinhagem: 3,
  dtNascimento,
  desmamado: true,
  caixaDoCasal: { idCaixa: 1, codigo: 'F1A', numeroVisivel: 'E1' },
  vivos: { m: vivos[0], f: vivos[1] },
  reservados: { m: reservados[0], f: reservados[1] },
  ...campos,
})

const naCaixa = (partos: VivosDoParto[], pedidos: VivosNaCaixa['pedidos'] = []): VivosNaCaixa => ({
  vivos: partos.reduce((s, p) => ({ m: s.m + p.vivos.m, f: s.f + p.vivos.f }), { m: 0, f: 0 }),
  reservados: partos.reduce((s, p) => ({ m: s.m + p.reservados.m, f: s.f + p.reservados.f }), { m: 0, f: 0 }),
  partos,
  pedidos,
})

const ciclo = (id: number, campos: Record<string, unknown> = {}) => ({
  id,
  ordem: 1,
  dtPartoReal: '2026-09-01',
  dtSemNinhada: null,
  desmamadoM: null,
  desmamadoF: null,
  ...campos,
})

const caixa = (campos: Record<string, unknown> = {}) => ({
  id: 7,
  codigo: 'F1A',
  tipo: 'casal',
  sexo: null,
  idLinhagem: null,
  ativa: true,
  dtLiberacao: null,
  motivoLiberacao: null,
  especie: { nome: 'Rato' },
  linhagem: null,
  estante: { numeroVisivel: 'E1', sala: { nome: 'Sala 1' } },
  // o casal ativo, com o 1o parto nascido e o 2o acasalado em 07/09 (parto previsto em 30/09), e o de antes
  casais: [
    {
      id: 2,
      partos: [
        { ordem: 1, dtAcasalamento: d('2026-08-09'), dtPartoReal: d('2026-09-01'), dtSemNinhada: null },
        { ordem: 2, dtAcasalamento: d('2026-09-07'), dtPartoReal: null, dtSemNinhada: null },
      ],
    },
    { id: 1, partos: [] },
  ],
  ...campos,
})

beforeEach(() => {
  banco.caixa = caixa()
  banco.partos = [
    { id: 10, idCasal: 1 },
    { id: 20, idCasal: 2 },
    { id: 21, idCasal: 2 },
  ]
  banco.ciclos = new Map([
    [10, ciclo(10, { ordem: 5, desmamadoM: 3, desmamadoF: 4 })],
    [20, ciclo(20, { desmamadoM: 5, desmamadoF: 5 })],
    [21, ciclo(21, { ordem: 2, dtPartoReal: null })],
  ])
  banco.casais = new Map([
    [2, { id: 2, identificacao: 'CD', linhagem: 'Wistar', idLinhagem: 3, ativo: true }],
    [1, { id: 1, identificacao: 'AB', linhagem: 'Wistar', idLinhagem: 3, ativo: false }],
  ])
  banco.vivos = naCaixa([doParto(20, '2026-09-01', [5, 5], [1, 0])])
  banco.desmamados = null
})

describe('a ficha da caixa de casal', () => {
  it('o casal da caixa com os partos, os casais de antes, a fase e os eventos', async () => {
    const ficha = await montarFicha(7)

    expect(ficha).toMatchObject({
      tipo: 'casal',
      virarEstoque: null,
      caixa: {
        id: 7,
        endereco: { numeroVisivel: 'E1', sala: 'Sala 1', codigo: 'F1A' },
        especie: 'rato',
        linhagem: 'Wistar',
        idLinhagem: 3,
        // desmamados do 1o parto ainda na caixa, e o 2o passou da data prevista sem nascer
        fase: 'pronto_estoque',
        atrasado: true,
        ativa: true,
        dtLiberacao: null,
      },
      casal: { identificacao: 'CD' },
      partos: [{ id: 20 }, { id: 21 }],
      anteriores: [{ casal: { identificacao: 'AB' }, partos: [{ id: 10 }] }],
      eventos: [expect.objectContaining({ tipo: 'nascimento', idOcorrencia: 1 })],
    })
  })

  it('os eventos recebem as contagens do desmame de cada parto, contadas na ficha', async () => {
    await montarFicha(7)

    expect(banco.desmamados).toEqual(
      new Map([
        [20, { m: 5, f: 5 }],
        [10, { m: 3, f: 4 }],
      ]),
    )
  })

  it('o casal encerrado com desmamados de um sexo so: a caixa pode virar de estoque com esse sexo', async () => {
    banco.casais.set(2, { id: 2, identificacao: 'CD', linhagem: 'Wistar', ativo: false })
    banco.ciclos.set(21, ciclo(21, { ordem: 2, dtPartoReal: '2026-10-01' }))
    banco.vivos = naCaixa([doParto(20, '2026-09-01', [0, 5])])

    expect((await montarFicha(7)).virarEstoque).toBe('F')
  })

  it('com parto pendente a caixa nao vira de estoque, nem com o casal encerrado', async () => {
    banco.casais.set(2, { id: 2, identificacao: 'CD', linhagem: 'Wistar', ativo: false })
    banco.vivos = naCaixa([doParto(20, '2026-09-01', [0, 5])])

    expect((await montarFicha(7)).virarEstoque).toBeNull()
  })

  it('a caixa liberada continua tendo ficha, sem fase', async () => {
    banco.caixa = caixa({ ativa: false, dtLiberacao: d('2026-10-30'), motivoLiberacao: 'casal_encerrado' })
    banco.vivos = naCaixa([])

    expect((await montarFicha(7)).caixa).toMatchObject({
      fase: null,
      atrasado: false,
      ativa: false,
      dtLiberacao: '2026-10-30',
      motivoLiberacao: 'casal_encerrado',
    })
  })

  it('caixa que nao existe', async () => {
    banco.caixa = null

    await expect(montarFicha(7)).rejects.toEqual(expect.objectContaining({ status: 404 }))
  })
})

describe('a ficha da caixa de estoque', () => {
  /** um vivo da caixa: o pedido, quando chegou nela e quando nasceu */
  const vivo = (dtNascimento: string, dtMovimento: string | null, idPedido: number | null = null) => ({
    idPedido,
    dtMovimento: dtMovimento === null ? null : d(dtMovimento),
    parto: { dtPartoReal: d(dtNascimento) },
  })

  beforeEach(() => {
    banco.umAUm = [
      vivo('2026-09-01', '2026-09-25'),
      vivo('2026-09-01', '2026-09-28'),
      vivo('2026-09-01', '2026-09-25'),
      vivo('2026-09-01', null),
      vivo('2026-10-01', '2026-10-25', 9),
      vivo('2026-10-01', '2026-10-25', 9),
      vivo('2026-10-01', '2026-10-27'),
      vivo('2026-10-01', '2026-10-25', 9),
    ]
    banco.caixa = caixa({ tipo: 'estoque', sexo: 'M', idLinhagem: 3, linhagem: { nome: 'Wistar' }, casais: [] })
    banco.vivos = naCaixa(
      [
        doParto(20, '2026-09-01', [4, 0], [0, 0]),
        doParto(30, '2026-10-01', [3, 0], [2, 0], { ordem: 2, casal: 'EF', caixaDoCasal: { idCaixa: 5, codigo: 'T2C', numeroVisivel: 'E2' } }),
        doParto(31, '2026-10-01', [1, 0], [1, 0], { ordem: 1, casal: 'GH' }),
      ],
      [{ idPedido: 9, m: 3, f: 0 }],
    )
  })

  it('os vivos por data de nascimento, com as origens; os pedidos com o que tem reservado nela', async () => {
    const ficha = await montarFicha(7)

    expect(ficha).toMatchObject({
      tipo: 'estoque',
      caixa: { id: 7, linhagem: 'Wistar', idLinhagem: 3, sexo: 'M', fase: 'estoque', atrasado: false },
      total: 8,
      reservado: 3,
      livre: 5,
      nascimentoDe: '2026-09-01',
      nascimentoAte: '2026-10-01',
      pedidos: [{ idPedido: 9, qtd: 3 }],
      casaisAnteriores: [],
    })
    if (ficha.tipo !== 'estoque') throw new Error('ficha de casal')

    expect(ficha.grupos).toEqual([
      {
        dtNascimento: '2026-09-01',
        idadeDias: expect.any(Number),
        total: 4,
        reservados: 0,
        livres: 4,
        pedidos: [],
        dtChegada: '2026-09-28',
        origens: [{ idParto: 20, ordem: 1, casal: 'AB', codigoOrigem: 'F1A', numeroVisivelOrigem: 'E1', qtd: 4 }],
      },
      {
        dtNascimento: '2026-10-01',
        idadeDias: expect.any(Number),
        total: 4,
        reservados: 3,
        livres: 1,
        pedidos: [{ idPedido: 9, qtd: 3 }],
        dtChegada: '2026-10-27',
        origens: [
          { idParto: 30, ordem: 2, casal: 'EF', codigoOrigem: 'T2C', numeroVisivelOrigem: 'E2', qtd: 3 },
          { idParto: 31, ordem: 1, casal: 'GH', codigoOrigem: 'F1A', numeroVisivelOrigem: 'E1', qtd: 1 },
        ],
      },
    ])
  })

  it('a chegada de cada idade e o limite que a baixa, a mudanca e a entrega conferem com os escolhidos dela', async () => {
    const ficha = await montarFicha(7)
    if (ficha.tipo !== 'estoque') throw new Error('ficha de casal')

    for (const grupo of ficha.grupos) {
      const escolhidos = banco.umAUm
        .filter((animal) => animal.parto.dtPartoReal?.toISOString().slice(0, 10) === grupo.dtNascimento)
        .map((animal, i) => ({ id: i, idCaixa: 7, idPedido: animal.idPedido, dtMovimento: animal.dtMovimento, dtNascimento: d(grupo.dtNascimento) }))
      const chegada = grupo.dtChegada ?? ''
      const vespera = new Date(d(chegada).getTime() - 86_400_000).toISOString().slice(0, 10)

      // no dia da chegada passa; na vespera, recusa
      expect(() => exigirDepoisDaChegada('dtFato', chegada, escolhidos)).not.toThrow()
      expect(() => exigirDepoisDaChegada('dtFato', vespera, escolhidos)).toThrow()
    }
  })

  it('a idade cujos vivos nunca mudaram de caixa nao tem chegada', async () => {
    banco.umAUm = banco.umAUm.map((animal) => ({ ...animal, dtMovimento: null }))
    const ficha = await montarFicha(7)
    if (ficha.tipo !== 'estoque') throw new Error('ficha de casal')

    expect(ficha.grupos.map((grupo) => grupo.dtChegada)).toEqual([null, null])
  })

  it('a caixa que era de casal antes de virar de estoque mostra os casais dela', async () => {
    banco.caixa = caixa({ tipo: 'estoque', sexo: 'M', idLinhagem: 3, linhagem: { nome: 'Wistar' }, casais: [{ id: 1 }] })

    const ficha = await montarFicha(7)

    expect(ficha).toMatchObject({ casaisAnteriores: [{ casal: { identificacao: 'AB' }, partos: [{ id: 10 }] }] })
  })

  it('a esvaziada pela entrega continua tendo ficha, sem vivo e sem fase', async () => {
    banco.caixa = caixa({
      tipo: 'estoque',
      sexo: 'M',
      idLinhagem: 3,
      linhagem: { nome: 'Wistar' },
      casais: [],
      ativa: false,
      motivoLiberacao: 'entrega',
      dtLiberacao: new Date(),
    })
    banco.vivos = naCaixa([])

    expect(await montarFicha(7)).toMatchObject({ caixa: { fase: null, ativa: false }, total: 0, grupos: [] })
  })
})
