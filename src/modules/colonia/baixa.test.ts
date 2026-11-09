import { beforeEach, describe, expect, it, vi } from 'vitest'
import { anularBaixa, registrarBaixa } from './baixa.service.ts'
import type { Escolhido, Grupo } from './escolha.ts'
import type { Lancamento } from './ocorrencia.ts'

// Uma colonia de mentira: os vivos de cada caixa, por id. A escolha pega os livres do grupo
// primeiro (a regra fina da escolha esta em escolha.test.ts), o lancamento so e guardado, e a
// liberacao libera a caixa sem vivo

type Animal = {
  id: number
  idCaixa: number
  sexo: 'M' | 'F'
  idPedido: number | null
  situacao: string
  dtNascimento: string
  dtMovimento: string | null
}

type Caixa = { id: number; codigo: string; ativa: boolean; tipo: string; sexo: string | null; idLinhagem: number | null }

const banco = vi.hoisted(() => ({
  animais: [] as Animal[],
  caixas: new Map<number, Caixa>(),
  /** As ninhadas (vivos por parto) de cada caixa de casal */
  ninhadas: new Map<number, { idParto: number; ordem: number; casal: string; m: number; f: number; desmamado: boolean }[]>(),
  baixa: null as Record<string, unknown> | null,
  pedidos: new Map<number, { status: string; pedido: { qtdM: number; qtdF: number; qtdQualquer: number }; tem: { m: number; f: number } }>(),
  lancados: [] as Lancamento[],
  liberadas: [] as { idCaixa: number; dtFato: string; motivo: string }[],
  escolhas: [] as { grupo: Grupo; qtd: number }[],
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async () => [],
        caixa: { findUnique: async ({ where }: { where: { id: number } }) => banco.caixas.get(where.id) ?? null },
        ocorrencia: { findUnique: async () => banco.baixa },
      }),
  },
}))

vi.mock('./escolha.ts', async (original) => ({
  ...(await original<typeof import('./escolha.ts')>()),
  escolherAnimais: async (_tx: unknown, grupo: Grupo, qtd: number, escolha: { excluir?: number[] } = {}) => {
    banco.escolhas.push({ grupo, qtd })
    const doGrupo = banco.animais
      .filter(
        (a) =>
          a.situacao === 'vivo' &&
          a.idCaixa === grupo.idCaixa &&
          a.sexo === grupo.sexo &&
          (grupo.dtNascimento === undefined || a.dtNascimento === grupo.dtNascimento) &&
          !(escolha.excluir ?? []).includes(a.id),
      )
      .sort((a, b) => Number(a.idPedido !== null) - Number(b.idPedido !== null) || a.id - b.id)
      .slice(0, qtd)

    if (doGrupo.length < qtd) throw Object.assign(new Error('sem animais'), { status: 409, codigo: 'SEM_ANIMAIS' })

    return doGrupo.map(
      (a): Escolhido => ({
        id: a.id,
        idCaixa: a.idCaixa,
        idPedido: a.idPedido,
        dtNascimento: d(a.dtNascimento),
        dtMovimento: a.dtMovimento === null ? null : d(a.dtMovimento),
      }),
    )
  },
}))

vi.mock('./ocorrencia.ts', () => ({
  lancarOcorrencia: async (_tx: unknown, lancamento: Lancamento) => {
    banco.lancados.push(lancamento)
    if (lancamento.tipo === 'baixa') {
      for (const a of banco.animais) if (lancamento.ids.includes(a.id)) a.situacao = 'morto'
    }
    return { idOcorrencia: 77, ids: 'ids' in lancamento ? lancamento.ids : [] }
  },
}))

vi.mock('./liberacao.ts', async (original) => ({
  ...(await original<typeof import('./liberacao.ts')>()),
  liberarSeVazia: async (_tx: unknown, idCaixa: number, dtFato: string, motivo: string) => {
    if (banco.animais.some((a) => a.idCaixa === idCaixa && a.situacao === 'vivo')) return false
    banco.liberadas.push({ idCaixa, dtFato, motivo })
    return true
  },
}))

vi.mock('./consultas.ts', () => ({
  idadesNaCaixa: async (_tx: unknown, idCaixa: number, sexo: string) =>
    [
      ...new Set(
        banco.animais.filter((a) => a.idCaixa === idCaixa && a.sexo === sexo && a.situacao === 'vivo').map((a) => a.dtNascimento),
      ),
    ].sort(),
  faltasDosPedidos: async (_tx: unknown, ids: number[]) => ids.map((idPedido) => ({ idPedido, m: 1, f: 0, qualquer: 0 })),
  contagemDosPedidos: async (_tx: unknown, ids: number[]) =>
    new Map([...banco.pedidos.entries()].filter(([id]) => ids.includes(id))),
  ninhadasNaCaixa: async (_tx: unknown, idCaixa: number) => banco.ninhadas.get(idCaixa) ?? [],
}))

const vivo = (id: number, parcial: Partial<Animal> = {}): Animal => ({
  id,
  idCaixa: 6,
  sexo: 'M',
  idPedido: null,
  situacao: 'vivo',
  dtNascimento: '2026-09-01',
  dtMovimento: '2026-09-23',
  ...parcial,
})

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })
const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })

const estoque = (id: number, codigo: string, sexo = 'M', idLinhagem = 3): Caixa => ({
  id,
  codigo,
  ativa: true,
  tipo: 'estoque',
  sexo,
  idLinhagem,
})
const caixaDeCasal = (id: number, codigo: string, ativa = true): Caixa => ({
  id,
  codigo,
  ativa,
  tipo: 'casal',
  sexo: null,
  idLinhagem: null,
})

beforeEach(() => {
  banco.animais = []
  banco.caixas = new Map([
    [6, estoque(6, 'F2C')],
    [7, estoque(7, 'F3C')],
  ])
  banco.ninhadas = new Map()
  banco.baixa = null
  banco.pedidos = new Map()
  banco.lancados = []
  banco.liberadas = []
  banco.escolhas = []
})

describe('baixa em qualquer caixa', () => {
  it('morte na caixa de estoque: os vivos saem como mortos e a caixa vazia libera na hora', async () => {
    banco.animais = [vivo(1), vivo(2)]

    const resultado = await registrarBaixa(6, { dtFato: '2026-11-02', motivo: 'morte', itens: [{ sexo: 'M', qtd: 2 }] }, 4)

    expect(resultado).toEqual({ baixas: { m: 2, f: 0 }, liberada: true, faltas: [] })
    expect(banco.lancados).toEqual([
      { tipo: 'baixa', dtFato: '2026-11-02', idUsuario: 4, idCaixa: 6, motivo: 'morte', ids: [1, 2] },
    ])
    expect(banco.liberadas).toEqual([{ idCaixa: 6, dtFato: '2026-11-02', motivo: 'baixa' }])
  })

  it('com vivos sobrando, a caixa continua ativa', async () => {
    banco.animais = [vivo(1), vivo(2), vivo(3)]

    const resultado = await registrarBaixa(6, { dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 1 }] }, 4)

    expect(resultado.liberada).toBe(false)
  })

  it('o reservado que morre deixa o pedido em falta, e a resposta diz qual', async () => {
    banco.animais = [vivo(1, { idPedido: 3 })]

    const resultado = await registrarBaixa(6, { dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 1 }] }, 4)

    expect(resultado.faltas).toEqual([{ idPedido: 3, m: 1, f: 0, qualquer: 0 }])
  })

  it('com mais de uma idade no sexo, pede a data de nascimento no campo do item', async () => {
    banco.animais = [vivo(1), vivo(2, { dtNascimento: '2026-09-20' })]

    await expect(
      registrarBaixa(6, { dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 1 }] }, 4),
    ).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { 'itens.0.dtNascimento': expect.any(String) } } }),
    )
  })

  it('com a idade indicada, a baixa sai daquela idade', async () => {
    banco.animais = [vivo(1), vivo(2, { dtNascimento: '2026-09-20' })]

    await registrarBaixa(6, { dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 1, dtNascimento: '2026-09-20' }] }, 4)

    expect(banco.lancados[0]).toMatchObject({ ids: [2] })
  })

  it('a data nao pode ser antes da chegada dos animais na caixa', async () => {
    banco.animais = [vivo(1, { dtMovimento: '2026-10-23' })]

    await expect(registrarBaixa(6, { dtFato: '2026-10-22', itens: [{ sexo: 'M', qtd: 1 }] }, 4)).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { dtFato: expect.stringContaining('chegada') } } }),
    )
    expect(banco.lancados).toEqual([])
  })

  it('dois itens do mesmo grupo nao pegam o mesmo animal', async () => {
    banco.animais = [vivo(1), vivo(2), vivo(3, { sexo: 'F' })]

    await registrarBaixa(
      6,
      {
        dtFato: '2026-11-02',
        itens: [
          { sexo: 'M', qtd: 1 },
          { sexo: 'M', qtd: 1 },
          { sexo: 'F', qtd: 1 },
        ],
      },
      4,
    )

    expect(banco.lancados[0]).toMatchObject({ ids: [1, 2, 3] })
  })

  it('caixa liberada nao recebe baixa', async () => {
    banco.caixas.set(6, { ...estoque(6, 'F2C'), ativa: false })

    await expect(registrarBaixa(6, { dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 1 }] }, 4)).rejects.toEqual(
      recusa(409, 'CAIXA_LIBERADA'),
    )
  })

  it('caixa inexistente e 404', async () => {
    await expect(registrarBaixa(99, { dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 1 }] }, 4)).rejects.toEqual(
      recusa(404, 'NAO_ENCONTRADO'),
    )
  })
})

describe('anulacao de baixa', () => {
  const baixaDe = (
    animais: { id: number; sexo: string; idPedido: number | null; desmame?: string | null; idParto?: number }[],
  ) => ({
    tipo: 'baixa',
    idParto: null,
    idCaixaOrigem: 6,
    anulacao: null,
    animais: animais.map((a) => ({
      animal: {
        id: a.id,
        sexo: a.sexo,
        idPedido: a.idPedido,
        idParto: a.idParto ?? 1,
        parto: {
          dtDesmameReal: a.desmame === null ? null : d(a.desmame ?? '2026-09-23'),
          casal: { idLinhagem: 3 },
        },
      },
    })),
  })

  it('os animais voltam vivos para a caixa onde estavam', async () => {
    banco.caixas.set(6, caixaDeCasal(6, 'F1A'))
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null }, { id: 2, sexo: 'F', idPedido: null }])

    const resultado = await anularBaixa(30, { motivo: 'baixa por engano' }, 4)

    expect(resultado).toEqual({ idCaixa: 6, voltaram: { m: 1, f: 1 }, soltos: 0 })
    expect(banco.lancados[0]).toMatchObject({
      tipo: 'anulacao',
      idAnulada: 30,
      motivo: 'baixa por engano',
      idCaixaOrigem: 6,
      idCaixaDestino: undefined,
      ids: [1, 2],
      soltos: [],
    })
  })

  it('a reserva volta junto so com o pedido reservado que ainda comporta o animal', async () => {
    banco.baixa = baixaDe([
      { id: 1, sexo: 'M', idPedido: 3 },
      { id: 2, sexo: 'M', idPedido: 3 },
      { id: 3, sexo: 'M', idPedido: 5 },
    ])
    banco.pedidos.set(3, { status: 'reservado', pedido: { qtdM: 2, qtdF: 0, qtdQualquer: 0 }, tem: { m: 1, f: 0 } })
    banco.pedidos.set(5, { status: 'aprovado', pedido: { qtdM: 1, qtdF: 0, qtdQualquer: 0 }, tem: { m: 0, f: 0 } })

    const resultado = await anularBaixa(30, { motivo: 'engano' }, 4)

    expect(banco.lancados[0]).toMatchObject({ soltos: [2, 3] })
    expect(resultado.soltos).toBe(2)
  })

  it('com a caixa ja liberada, pede para onde os animais voltam', async () => {
    banco.caixas.set(6, { ...estoque(6, 'F2C'), ativa: false })
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null }])

    await expect(anularBaixa(30, { motivo: 'engano' }, 4)).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { idCaixa: expect.stringContaining('liberada') } } }),
    )
  })

  it('com a caixa liberada e a caixa indicada, a volta vira mudanca para ela', async () => {
    banco.caixas.set(6, { ...estoque(6, 'F2C'), ativa: false })
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null }])

    const resultado = await anularBaixa(30, { motivo: 'engano', idCaixa: 7 }, 4)

    expect(resultado.idCaixa).toBe(7)
    expect(banco.lancados[0]).toMatchObject({ idCaixaOrigem: 6, idCaixaDestino: 7 })
  })

  it('caixa da baixa ainda ativa: nao aceita outra caixa', async () => {
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null }])

    await expect(anularBaixa(30, { motivo: 'engano', idCaixa: 7 }, 4)).rejects.toEqual(
      expect.objectContaining({ status: 400, extras: { campos: { idCaixa: expect.stringContaining('continua ativa') } } }),
    )
  })

  it('filhote que mama nao muda para outra caixa na anulacao', async () => {
    banco.caixas.set(6, caixaDeCasal(6, 'F1A', false))
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null, desmame: null }])

    await expect(anularBaixa(30, { motivo: 'engano', idCaixa: 7 }, 4)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
  })

  it('a caixa do casal com a ninhada de outro parto nao recebe a volta: duas ninhadas nao dividem a caixa', async () => {
    banco.caixas.set(6, caixaDeCasal(6, 'F1A'))
    banco.ninhadas.set(6, [{ idParto: 2, ordem: 2, casal: 'AB', m: 4, f: 4, desmamado: false }])
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null, idParto: 1 }])

    await expect(anularBaixa(30, { motivo: 'engano' }, 4)).rejects.toEqual(
      noCampo('idCaixa', 'tem agora a ninhada do 2o parto'),
    )

    const resultado = await anularBaixa(30, { motivo: 'engano', idCaixa: 7 }, 4)

    expect(resultado.idCaixa).toBe(7)
    expect(banco.lancados[0]).toMatchObject({ idCaixaOrigem: 6, idCaixaDestino: 7 })
  })

  it('os vivos do proprio parto na caixa do casal nao impedem a volta', async () => {
    banco.caixas.set(6, caixaDeCasal(6, 'F1A'))
    banco.ninhadas.set(6, [{ idParto: 1, ordem: 1, casal: 'AB', m: 3, f: 2, desmamado: false }])
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null, idParto: 1, desmame: null }])

    const resultado = await anularBaixa(30, { motivo: 'engano' }, 4)

    expect(resultado.idCaixa).toBe(6)
  })

  it('filhote que mama nao volta para a caixa com a ninhada de outro parto, nem vai para o estoque', async () => {
    banco.caixas.set(6, caixaDeCasal(6, 'F1A'))
    banco.ninhadas.set(6, [{ idParto: 2, ordem: 2, casal: 'AB', m: 4, f: 4, desmamado: false }])
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null, idParto: 1, desmame: null }])

    await expect(anularBaixa(30, { motivo: 'engano', idCaixa: 7 }, 4)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
    expect(banco.lancados).toEqual([])
  })

  it('a caixa de casal que virou estoque depois da baixa recebe a volta so do sexo dela', async () => {
    banco.caixas.set(6, estoque(6, 'F1A', 'M'))
    banco.baixa = baixaDe([{ id: 1, sexo: 'F', idPedido: null }])

    await expect(anularBaixa(30, { motivo: 'engano' }, 4)).rejects.toEqual(
      noCampo('idCaixa', 'agora e caixa de estoque de machos'),
    )
    expect(banco.lancados).toEqual([])

    banco.caixas.set(9, estoque(9, 'F5C', 'F'))
    expect((await anularBaixa(30, { motivo: 'engano', idCaixa: 9 }, 4)).idCaixa).toBe(9)

    banco.lancados = []
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null }])
    expect((await anularBaixa(30, { motivo: 'engano' }, 4)).idCaixa).toBe(6)
    expect(banco.lancados[0]).toMatchObject({ idCaixaOrigem: 6, idCaixaDestino: undefined })
  })

  it('filhote que mama nao volta para a caixa de casal que virou estoque', async () => {
    banco.caixas.set(6, estoque(6, 'F1A', 'M'))
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null, desmame: null }])

    await expect(anularBaixa(30, { motivo: 'engano' }, 4)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('a caixa indicada e de estoque, do sexo e da linhagem dos animais', async () => {
    banco.caixas.set(6, caixaDeCasal(6, 'F1A', false))
    banco.caixas.set(8, caixaDeCasal(8, 'F4C'))
    banco.caixas.set(9, estoque(9, 'F5C', 'F'))
    banco.caixas.set(10, estoque(10, 'F6C', 'M', 4))
    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null }])

    await expect(anularBaixa(30, { motivo: 'engano', idCaixa: 8 }, 4)).rejects.toEqual(noCampo('idCaixa', 'estoque'))
    await expect(anularBaixa(30, { motivo: 'engano', idCaixa: 9 }, 4)).rejects.toEqual(noCampo('idCaixa', 'outro sexo'))
    await expect(anularBaixa(30, { motivo: 'engano', idCaixa: 10 }, 4)).rejects.toEqual(
      noCampo('idCaixa', 'outra linhagem'),
    )

    banco.baixa = baixaDe([{ id: 1, sexo: 'M', idPedido: null }, { id: 2, sexo: 'F', idPedido: null }])
    await expect(anularBaixa(30, { motivo: 'engano', idCaixa: 7 }, 4)).rejects.toEqual(
      noCampo('idCaixa', 'machos e femeas'),
    )
    expect(banco.lancados).toEqual([])
  })

  it('so a baixa se anula, e uma vez so', async () => {
    banco.baixa = { ...baixaDe([]), tipo: 'mudanca' }
    await expect(anularBaixa(30, { motivo: 'engano' }, 4)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))

    banco.baixa = { ...baixaDe([]), anulacao: { id: 31 } }
    await expect(anularBaixa(30, { motivo: 'engano' }, 4)).rejects.toEqual(recusa(409, 'OCORRENCIA_JA_ANULADA'))

    banco.baixa = null
    await expect(anularBaixa(30, { motivo: 'engano' }, 4)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
    expect(banco.lancados).toEqual([])
  })
})
