import { beforeEach, describe, expect, it, vi } from 'vitest'
import { levarParaViuvas, porQueNaoViraViuva } from './viuva.service.ts'
import type { CasalParaViuva } from './viuva.service.ts'

type Parto = {
  ordem: number | null
  dtPartoReal: Date | null
  dtDesmameReal: Date | null
  dtSemNinhada: Date | null
}
type Caixa = { id: number; codigo: string; ativa: boolean; tipo: string; idLinhagem: number | null }
type Viuva = { id: number; idCaixa: number; idCasal: number; idLinhagem: number; dtViuvez: Date }

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const banco = vi.hoisted(() => ({
  casal: null as null | {
    id: number
    idCaixa: number
    idLinhagem: number
    identificacao: string
    ativo: boolean
    dtEncerramento: Date | null
    partos: Parto[]
  },
  caixas: new Map<number, Caixa>(),
  viuvas: [] as Viuva[],
  naCaixa: new Map<number, { idParto: number; ordem: number | null; casal: string; m: number; f: number; desmamado: boolean }[]>(),
  ocupante: null as null | { id: number },
  historicos: [] as Record<string, unknown>[],
  proximoId: 100,
}))

const db = {
  $queryRaw: async () => [],
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  casal: {
    findUnique: async () => {
      const { casal } = banco
      if (casal === null) return null
      const viuvas = banco.viuvas
        .filter((v) => v.idCasal === casal.id)
        .map((v) => ({ dtViuvez: v.dtViuvez, caixa: { codigo: banco.caixas.get(v.idCaixa)?.codigo } }))
      return { ...casal, linhagem: { idEspecie: 1 }, caixa: { codigo: banco.caixas.get(casal.idCaixa)?.codigo }, viuvas }
    },
  },
  estante: { findFirst: async () => ({ id: 1, numeroVisivel: 'E1', faces: 2, linhas: 3, colunas: 3 }) },
  caixa: {
    findFirst: async () => banco.ocupante,
    findUnique: async ({ where }: { where: { id: number } }) => {
      const caixa = banco.caixas.get(where.id)
      if (caixa === undefined) return null
      return { ...caixa, _count: { viuvas: banco.viuvas.filter((v) => v.idCaixa === caixa.id).length } }
    },
    create: async ({ data }: { data: Omit<Caixa, 'id' | 'codigo' | 'ativa'> }) => {
      const caixa = { id: banco.proximoId++, codigo: 'F2B', ativa: true, ...data }
      banco.caixas.set(caixa.id, caixa)
      return { id: caixa.id, codigo: caixa.codigo }
    },
  },
  viuva: {
    create: async ({ data }: { data: Omit<Viuva, 'id'> }) => {
      const viuva = { id: banco.proximoId++, ...data }
      banco.viuvas.push(viuva)
      return { id: viuva.id }
    },
  },
  historico: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      banco.historicos.push(data)
    },
  },
}

vi.mock('../../shared/prisma.ts', () => ({
  prisma: new Proxy({}, { get: (_prisma, chave) => db[chave as keyof typeof db] }),
}))

vi.mock('../colonia/consultas.ts', () => ({
  ninhadasNaCaixa: async (_tx: unknown, idCaixa: number) => banco.naCaixa.get(idCaixa) ?? [],
}))

function partosDoCasal(): Parto[] {
  return [1, 2, 3, 4, 5].map((ordem) => ({
    ordem,
    dtPartoReal: d(ordem === 5 ? '2026-09-28' : `2026-0${ordem + 3}-01`),
    dtDesmameReal: d(ordem === 5 ? '2026-10-20' : `2026-0${ordem + 3}-23`),
    dtSemNinhada: null,
  }))
}

beforeEach(() => {
  banco.casal = {
    id: 1,
    idCaixa: 1,
    idLinhagem: 3,
    identificacao: 'AB',
    ativo: false,
    dtEncerramento: d('2026-09-28'),
    partos: partosDoCasal(),
  }
  banco.caixas = new Map([
    [1, { id: 1, codigo: 'F1A', ativa: true, tipo: 'casal', idLinhagem: null }],
    [9, { id: 9, codigo: 'F3A', ativa: true, tipo: 'viuvas', idLinhagem: 3 }],
    [6, { id: 6, codigo: 'F2C', ativa: true, tipo: 'estoque', idLinhagem: 3 }],
    [8, { id: 8, codigo: 'F3B', ativa: true, tipo: 'viuvas', idLinhagem: 5 }],
  ])
  banco.viuvas = []
  banco.naCaixa = new Map()
  banco.ocupante = null
  banco.historicos = []
  banco.proximoId = 100
})

const recusa = (status: number, codigo: string, trecho?: string) =>
  expect.objectContaining({ status, codigo, ...(trecho === undefined ? {} : { message: expect.stringContaining(trecho) }) })
const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })

function outraViuva() {
  banco.viuvas.push({ id: banco.proximoId++, idCaixa: 9, idCasal: 50 + banco.viuvas.length, idLinhagem: 3, dtViuvez: d('2026-10-01') })
}

describe('quando a femea do casal vira viuva', () => {
  const casal = (parcial: Partial<CasalParaViuva>): CasalParaViuva => ({
    ativo: false,
    viuva: null,
    partos: partosDoCasal(),
    ninhadas: [],
    ...parcial,
  })

  it('so do casal encerrado, uma vez so, sem parto pendente e sem ninhada mamando', () => {
    expect(porQueNaoViraViuva(casal({}))).toBeNull()
    expect(porQueNaoViraViuva(casal({ ativo: true }))).toContain('ainda está ativo')
    expect(porQueNaoViraViuva(casal({ viuva: { codigo: 'F3A', dtViuvez: d('2026-10-21') } }))).toBe(
      'A fêmea deste casal já foi para a caixa de viúvas F3A em 21/10/2026.',
    )
    expect(
      porQueNaoViraViuva(casal({ partos: [...partosDoCasal().slice(0, 4), { ordem: 5, dtPartoReal: null, dtDesmameReal: null, dtSemNinhada: null }] })),
    ).toContain('O 5º parto do casal ainda está pendente')
    expect(porQueNaoViraViuva(casal({ ninhadas: [{ ordem: 5, desmamado: false }] }))).toContain('ainda está em aleitamento')
    expect(porQueNaoViraViuva(casal({ ninhadas: [{ ordem: 5, desmamado: true }] }))).toBeNull()
  })
})

describe('levar a femea para a caixa de viuvas', () => {
  const ida = { dtViuvez: '2026-10-21', idCaixa: 9 }

  it('grava a viuva com a data e registra de qual caixa ela veio', async () => {
    const { idCaixa, idViuva } = await levarParaViuvas(1, ida, 4)

    expect(idCaixa).toBe(9)
    expect(banco.viuvas).toEqual([{ id: idViuva, idCaixa: 9, idCasal: 1, idLinhagem: 3, dtViuvez: d('2026-10-21'), idUsuario: 4 }])
    expect(banco.historicos[0]).toMatchObject({
      entidade: 'viuva',
      idEntidade: idViuva,
      acao: 'formacao',
      descricao: 'Fêmea do casal AB (caixa F1A) foi para a caixa de viúvas F3A em 21/10/2026',
    })
  })

  it('numa posicao vazia cria a caixa de viuvas, com a linhagem do casal', async () => {
    const { idCaixa } = await levarParaViuvas(1, { dtViuvez: '2026-10-21', posicao: { idEstante: 1, face: 'frontal', linha: 2, coluna: 2 } }, 4)

    expect(banco.caixas.get(idCaixa)).toMatchObject({ tipo: 'viuvas', idLinhagem: 3, idEspecie: 1 })
  })

  it('a posicao ocupada por uma caixa de viuvas leva a femea para ela', async () => {
    banco.ocupante = { id: 9 }

    expect((await levarParaViuvas(1, { dtViuvez: '2026-10-21', posicao: { idEstante: 1, face: 'frontal', linha: 1, coluna: 1 } }, 4)).idCaixa).toBe(9)
  })

  it('recusa o casal ativo, a femea que ja foi e a ninhada ainda mamando', async () => {
    banco.naCaixa.set(1, [{ idParto: 5, ordem: 5, casal: 'AB', m: 4, f: 4, desmamado: false }])
    await expect(levarParaViuvas(1, ida, 4)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA', 'ainda está em aleitamento'))
    banco.naCaixa = new Map()

    banco.viuvas.push({ id: 60, idCaixa: 9, idCasal: 1, idLinhagem: 3, dtViuvez: d('2026-10-21') })
    await expect(levarParaViuvas(1, ida, 4)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA', 'já foi para a caixa de viúvas F3A'))
    banco.viuvas = []

    if (banco.casal !== null) Object.assign(banco.casal, { ativo: true, dtEncerramento: null })
    await expect(levarParaViuvas(1, ida, 4)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA', 'ainda está ativo'))
    expect(banco.viuvas).toEqual([])
  })

  it('a data nao fica antes do ultimo desmame do casal', async () => {
    await expect(levarParaViuvas(1, { ...ida, dtViuvez: '2026-10-19' }, 4)).rejects.toEqual(
      noCampo('dtViuvez', 'Não pode ser antes do desmame do 5º parto (20/10/2026).'),
    )
    await expect(levarParaViuvas(1, { ...ida, dtViuvez: '2026-10-20' }, 4)).resolves.toMatchObject({ idCaixa: 9 })
  })

  it('recusa a caixa cheia, a de outra linhagem e a que nao e de viuvas', async () => {
    await expect(levarParaViuvas(1, { ...ida, idCaixa: 8 }, 4)).rejects.toEqual(noCampo('idCaixa', 'de outra linhagem'))
    await expect(levarParaViuvas(1, { ...ida, idCaixa: 6 }, 4)).rejects.toEqual(noCampo('idCaixa', 'não é uma caixa de viúvas'))

    outraViuva()
    outraViuva()
    outraViuva()
    await expect(levarParaViuvas(1, ida, 4)).rejects.toEqual(recusa(409, 'CAIXA_DE_VIUVAS', 'já tem 3 viúvas'))
  })
})
