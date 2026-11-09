import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dataDaLiberacao, liberarSeVazia } from './liberacao.ts'

const banco = vi.hoisted(() => ({
  caixa: null as Record<string, unknown> | null,
  vivos: 0,
  /** As ultimas datas dos animais e da trilha na caixa */
  ultimos: { dtSaida: null, dtMovimento: null, dtFato: null } as Record<string, Date | null>,
  travas: [] as string[],
  atualizada: null as Record<string, unknown> | null,
  historicos: [] as Record<string, unknown>[],
}))

const tx = {
  $queryRaw: async (partes: TemplateStringsArray) => {
    banco.travas.push(partes.join('?'))
    return []
  },
  caixa: {
    findUnique: async () => banco.caixa,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      banco.atualizada = data
    },
  },
  animal: {
    count: async () => banco.vivos,
    aggregate: async () => ({ _max: { dtSaida: banco.ultimos.dtSaida, dtMovimento: banco.ultimos.dtMovimento } }),
  },
  ocorrencia: { aggregate: async () => ({ _max: { dtFato: banco.ultimos.dtFato } }) },
  historico: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      banco.historicos.push(data)
    },
  },
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const estoque = { id: 6, codigo: 'F2C', ativa: true, tipo: 'estoque', casais: [] }
const casal = (casais: Record<string, unknown>[]) => ({ id: 1, codigo: 'F1A', ativa: true, tipo: 'casal', casais })

beforeEach(() => {
  banco.caixa = estoque
  banco.vivos = 0
  banco.ultimos = { dtSaida: null, dtMovimento: null, dtFato: null }
  banco.travas = []
  banco.atualizada = null
  banco.historicos = []
})

describe('liberarSeVazia', () => {
  it('a caixa de estoque sem vivo libera na hora, com a data do fato e o motivo', async () => {
    expect(await liberarSeVazia(tx as never, 6, '2026-11-02', 'baixa', 4)).toBe(true)

    expect(banco.atualizada).toMatchObject({ ativa: false, dtLiberacao: d('2026-11-02'), motivoLiberacao: 'baixa' })
    expect(banco.historicos[0]).toMatchObject({ entidade: 'caixa', idEntidade: 6, acao: 'liberacao', idUsuario: 4 })
  })

  it('trava a caixa antes de contar os vivos', async () => {
    await liberarSeVazia(tx as never, 6, '2026-11-02', 'baixa', 4)

    expect(banco.travas[0]).toContain('FOR UPDATE')
  })

  it('com vivo dentro nao libera', async () => {
    banco.vivos = 1

    expect(await liberarSeVazia(tx as never, 6, '2026-11-02', 'baixa', 4)).toBe(false)
    expect(banco.atualizada).toBeNull()
  })

  it('a caixa de casal nao libera com casal ativo nem com parto pendente', async () => {
    banco.caixa = casal([{ ativo: true, partos: [] }])
    expect(await liberarSeVazia(tx as never, 1, '2026-11-02', 'casal_encerrado', 4)).toBe(false)

    banco.caixa = casal([{ ativo: false, partos: [{ id: 3 }] }])
    expect(await liberarSeVazia(tx as never, 1, '2026-11-02', 'casal_encerrado', 4)).toBe(false)

    expect(banco.atualizada).toBeNull()
  })

  it('a caixa de casal encerrado, sem parto pendente e sem vivo, libera', async () => {
    banco.caixa = casal([{ ativo: false, partos: [] }])

    expect(await liberarSeVazia(tx as never, 1, '2026-11-02', 'casal_encerrado', 4)).toBe(true)
    expect(banco.atualizada).toMatchObject({ motivoLiberacao: 'casal_encerrado' })
  })

  it('a baixa retroativa do ultimo vivo nao libera antes da morte ja registrada de outro animal', async () => {
    banco.ultimos = { dtSaida: d('2026-11-05'), dtMovimento: d('2026-10-01'), dtFato: d('2026-11-05') }

    await liberarSeVazia(tx as never, 6, '2026-11-02', 'baixa', 4)

    expect(banco.atualizada).toMatchObject({ dtLiberacao: d('2026-11-05') })
    expect(banco.historicos[0]).toMatchObject({ dados: { dtLiberacao: '2026-11-05', motivo: 'baixa' } })
  })

  it('caixa ja liberada fica como esta', async () => {
    banco.caixa = { ...estoque, ativa: false }

    expect(await liberarSeVazia(tx as never, 6, '2026-11-02', 'baixa', 4)).toBe(false)
    expect(banco.atualizada).toBeNull()
  })
})

describe('dataDaLiberacao', () => {
  it('e a data do fato que esvaziou a caixa quando nada nela e mais novo', () => {
    expect(dataDaLiberacao('2026-11-02', [d('2026-10-01'), null, d('2026-11-02')])).toBe('2026-11-02')
  })

  it('nunca vem antes do ultimo fato na caixa: chegada, saida ou ocorrencia', () => {
    expect(dataDaLiberacao('2026-11-02', [d('2026-11-04'), null, d('2026-11-03')])).toBe('2026-11-04')
    expect(dataDaLiberacao('2026-11-02', [null, d('2026-11-06'), null])).toBe('2026-11-06')
  })
})
