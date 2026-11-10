import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Escolha, Escolhido, Grupo } from '../colonia/escolha.ts'
import type { Lancamento } from '../colonia/ocorrencia.ts'
import { registrarMudanca, viradaParaEstoque, virarCaixaDeEstoque } from './mudanca.service.ts'
import type { CaixaParaVirar } from './mudanca.service.ts'

// Uma colonia de mentira, em memoria: caixas, casais, partos e os animais (uma linha por rato). O
// Prisma e as funcoes do modulo colonia sao trocados por versoes que leem e escrevem aqui, com o
// mesmo contrato: a escolha pega os livres primeiro e completa com os reservados do pedido (o
// indicado ou o unico, pela regra de verdade do modulo), ou so os do pedido com soDoPedido; o
// lancamento muda a caixa dos animais, e a liberacao so libera caixa sem vivo (a de casal, tambem
// sem casal ativo). As regras finas de cada uma estao nos testes do modulo colonia; aqui ficam as
// regras da mudanca e do virar estoque

type Caixa = {
  id: number
  codigo: string
  ativa: boolean
  tipo: string
  idEspecie: number
  sexo: string | null
  idLinhagem: number | null
  idEstante: number
  face: number
  linha: number
  coluna: number
}
type Casal = { id: number; idCaixa: number; idLinhagem: number; identificacao: string; ativo: boolean }
type Parto = {
  id: number
  idCasal: number
  ordem: number
  dtPartoReal: Date | null
  dtDesmameReal: Date | null
  dtSemNinhada: Date | null
}
type Animal = {
  id: number
  idParto: number
  sexo: 'M' | 'F'
  idCaixa: number
  situacao: string
  dtMovimento: Date | null
  idPedido: number | null
}

const banco = vi.hoisted(() => ({
  caixas: new Map<number, Caixa>(),
  casais: new Map<number, Casal>(),
  partos: new Map<number, Parto>(),
  animais: [] as Animal[],
  ocorrencias: [] as Record<string, unknown>[],
  /** a primeira chegada de animais em cada caixa, antes deste teste */
  chegadas: new Map<number, Date>(),
  historicos: [] as Record<string, unknown>[],
  liberadas: [] as { idCaixa: number; dtFato: string; motivo: string }[],
  proximoId: 1000,
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const iso = (data: Date | null) => (data === null ? null : data.toISOString().slice(0, 10))
const vivosEm = (idCaixa: number) => banco.animais.filter((a) => a.idCaixa === idCaixa && a.situacao === 'vivo')

// ------------------------------------------------------------------ o Prisma de mentira

function comCasais(caixa: Caixa) {
  const casais = [...banco.casais.values()]
    .filter((c) => c.idCaixa === caixa.id)
    .map((c) => ({
      ativo: c.ativo,
      partos: [...banco.partos.values()].filter((p) => p.idCasal === c.id && p.dtPartoReal === null && p.dtSemNinhada === null),
    }))
  return { ...caixa, casais }
}

const db = {
  $queryRaw: async () => [],
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  estante: { findFirst: async () => ({ id: 1, numeroVisivel: 'E1', faces: 2, linhas: 3, colunas: 3 }) },
  caixa: {
    findUnique: async ({ where }: { where: { id: number } }) => {
      const caixa = banco.caixas.get(where.id)
      return caixa === undefined ? null : comCasais(caixa)
    },
    findFirst: async ({ where }: { where: { face: number; linha: number; coluna: number } }) =>
      [...banco.caixas.values()].find(
        (c) => c.ativa && c.face === where.face && c.linha === where.linha && c.coluna === where.coluna,
      ) ?? null,
    // o codigo vem do trigger da posicao
    create: async ({ data }: { data: Omit<Caixa, 'id' | 'codigo' | 'ativa'> }) => {
      const caixa = { id: banco.proximoId++, ativa: true, codigo: `F${data.linha}${'ABC'[data.coluna - 1]}`, ...data }
      banco.caixas.set(caixa.id, caixa)
      return { id: caixa.id, codigo: caixa.codigo }
    },
    update: async ({ where, data }: { where: { id: number }; data: Partial<Caixa> }) => {
      Object.assign(banco.caixas.get(where.id) as Caixa, data)
    },
  },
  ocorrencia: {
    aggregate: async ({ where }: { where: { idCaixaDestino: number } }) => ({
      _min: { dtFato: banco.chegadas.get(where.idCaixaDestino) ?? null },
    }),
  },
  parto: {
    findMany: async ({ where }: { where: { animais: { some: { id: { in: number[] } } } } }) => {
      const ids = new Set(where.animais.some.id.in)
      const partos = new Set(banco.animais.filter((a) => ids.has(a.id)).map((a) => a.idParto))
      return [...partos]
        .sort((a, b) => a - b)
        .map((id) => {
          const parto = banco.partos.get(id) as Parto
          const casal = banco.casais.get(parto.idCasal) as Casal
          return { ...parto, casal: { identificacao: casal.identificacao, idLinhagem: casal.idLinhagem } }
        })
    },
  },
  historico: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      banco.historicos.push(data)
    },
  },
}

// o vi.mock sobe para o topo do arquivo, antes de 'db' existir: o Prisma le 'db' so na hora do uso
vi.mock('../../shared/prisma.ts', () => ({
  prisma: new Proxy({}, { get: (_prisma, chave) => db[chave as keyof typeof db] }),
}))

// ------------------------------------------------------------------ o modulo colonia de mentira

const nascimento = (a: Animal) => iso((banco.partos.get(a.idParto) as Parto).dtPartoReal)

vi.mock('../colonia/consultas.ts', async (original) => ({
  ...(await original<typeof import('../colonia/consultas.ts')>()),
  idadesNaCaixa: async (_tx: unknown, idCaixa: number, sexo: string) =>
    [...new Set(vivosEm(idCaixa).filter((a) => a.sexo === sexo).map(nascimento))].sort(),
  vivosNasCaixas: async (_tx: unknown, ids: number[]) =>
    new Map(
      ids.map((idCaixa) => {
        const vivos = vivosEm(idCaixa)
        const partos = [...new Set(vivos.map((a) => a.idParto))].map((idParto) => {
          const parto = banco.partos.get(idParto) as Parto
          const casal = banco.casais.get(parto.idCasal) as Casal
          const doParto = vivos.filter((a) => a.idParto === idParto)
          return {
            idParto,
            ordem: parto.ordem,
            casal: casal.identificacao,
            idLinhagem: casal.idLinhagem,
            dtNascimento: iso(parto.dtPartoReal),
            desmamado: parto.dtDesmameReal !== null,
            vivos: { m: doParto.filter((a) => a.sexo === 'M').length, f: doParto.filter((a) => a.sexo === 'F').length },
          }
        })
        return [idCaixa, { partos }]
      }),
    ),
}))

vi.mock('../colonia/escolha.ts', async (original) => {
  const real = await original<typeof import('../colonia/escolha.ts')>()

  return {
    ...real,
    escolherAnimais: async (_tx: unknown, grupo: Grupo, qtd: number, escolha: Escolha = {}) => {
      const doGrupo = banco.animais.filter(
        (a) =>
          a.situacao === 'vivo' &&
          a.sexo === grupo.sexo &&
          a.idCaixa === grupo.idCaixa &&
          (grupo.dtNascimento === undefined || nascimento(a) === grupo.dtNascimento),
      )
      const livres = doGrupo.filter((a) => a.idPedido === null).slice(0, qtd)
      const doPedido = (id: number | null | undefined) => doGrupo.filter((a) => a.idPedido !== null && a.idPedido === id)
      const pedidos = [...new Set(doGrupo.flatMap((a) => (a.idPedido === null ? [] : [a.idPedido])))].sort((a, b) => a - b)
      // de qual pedido saem os que faltam: a regra de verdade (pedidoDosReservados), com a recusa dela
      const escolhidos =
        escolha.soDoPedido === true
          ? doPedido(escolha.idPedido).slice(0, qtd)
          : livres.length === qtd
            ? livres
            : [...livres, ...doPedido(real.pedidoDosReservados(pedidos, escolha.idPedido, escolha.campoDoPedido))].slice(0, qtd)

      if (escolhidos.length < qtd) throw Object.assign(new Error('sem animais'), { status: 409, codigo: 'SEM_ANIMAIS' })

      return escolhidos.map(
        (a): Escolhido => ({
          id: a.id,
          idCaixa: a.idCaixa,
          idPedido: a.idPedido,
          dtMovimento: a.dtMovimento,
          dtNascimento: (banco.partos.get(a.idParto) as Parto).dtPartoReal as Date,
        }),
      )
    },
  }
})

vi.mock('../colonia/ocorrencia.ts', () => ({
  lancarOcorrencia: async (_tx: unknown, l: Lancamento) => {
    if (l.tipo !== 'mudanca') throw new Error(`a mudanca nao lanca ${l.tipo}`)

    for (const a of banco.animais.filter((animal) => l.ids.includes(animal.id))) {
      Object.assign(a, { idCaixa: l.idCaixaDestino, dtMovimento: d(l.dtFato) })
    }
    banco.ocorrencias.push({ ...l })
    return { idOcorrencia: banco.proximoId++, ids: l.ids }
  },
}))

vi.mock('../colonia/liberacao.ts', async (original) => ({
  ...(await original<typeof import('../colonia/liberacao.ts')>()),
  liberarSeVazia: async (_tx: unknown, idCaixa: number, dtFato: string, motivo: string) => {
    const caixa = banco.caixas.get(idCaixa) as Caixa
    const segura = caixa.tipo === 'casal' && comCasais(caixa).casais.some((c) => c.ativo || c.partos.length > 0)
    if (!caixa.ativa || segura || vivosEm(idCaixa).length > 0) return false

    caixa.ativa = false
    banco.liberadas.push({ idCaixa, dtFato, motivo })
    return true
  },
}))

// ------------------------------------------------------------------ o cenario

function caixa(id: number, tipo: string, campos: Partial<Caixa> = {}): Caixa {
  const nova = {
    id,
    codigo: `F1${'ABC'[id - 1] ?? 'X'}`,
    ativa: true,
    tipo,
    idEspecie: 1,
    sexo: null,
    idLinhagem: null,
    idEstante: 1,
    face: 1,
    linha: 1,
    coluna: id,
    ...campos,
  }
  banco.caixas.set(id, nova)
  return nova
}

function animais(idParto: number, idCaixa: number, sexo: 'M' | 'F', qtd: number, campos: Partial<Animal> = {}) {
  for (let i = 0; i < qtd; i += 1) {
    banco.animais.push({ id: banco.proximoId++, idParto, sexo, idCaixa, situacao: 'vivo', dtMovimento: null, idPedido: null, ...campos })
  }
}

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })
const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })

const vazia = { idEstante: 1, face: 'frontal' as const, linha: 2, coluna: 1 }

beforeEach(() => {
  banco.caixas.clear()
  banco.casais.clear()
  banco.partos.clear()
  banco.animais = []
  banco.ocorrencias = []
  banco.chegadas.clear()
  banco.historicos = []
  banco.liberadas = []
  banco.proximoId = 1000

  // caixa 1: o casal AB (Wistar), com a ninhada do 1o parto desmamada: 5 M e 4 F
  caixa(1, 'casal')
  banco.casais.set(10, { id: 10, idCaixa: 1, idLinhagem: 3, identificacao: 'AB', ativo: true })
  banco.partos.set(20, { id: 20, idCasal: 10, ordem: 1, dtPartoReal: d('2026-09-01'), dtDesmameReal: d('2026-09-23'), dtSemNinhada: null })
  animais(20, 1, 'M', 5)
  animais(20, 1, 'F', 4)

  // caixa 2: estoque de femeas Wistar, ja com 2 de outro parto
  caixa(2, 'estoque', { sexo: 'F', idLinhagem: 3 })
  banco.partos.set(21, { id: 21, idCasal: 10, ordem: 0, dtPartoReal: d('2026-08-01'), dtDesmameReal: d('2026-08-23'), dtSemNinhada: null })
  animais(21, 2, 'F', 2, { dtMovimento: d('2026-08-25') })
})

describe('a passagem da caixa do casal para o estoque', () => {
  it('machos para uma caixa nova numa posicao vazia, femeas para a de estoque que ja existe', async () => {
    const feita = await registrarMudanca(
      1,
      { dtFato: '2026-09-25', machos: { qtd: 5, destino: { posicao: vazia } }, femeas: { qtd: 4, destino: { idCaixa: 2 } } },
      7,
    )

    const nova = [...banco.caixas.values()].find((c) => c.id >= 1000) as Caixa
    expect(feita).toEqual({
      caixas: [
        { idCaixa: nova.id, codigo: 'F2A', sexo: 'M', qtd: 5 },
        { idCaixa: 2, codigo: 'F1B', sexo: 'F', qtd: 4 },
      ],
      liberada: false,
    })
    // a caixa nova nasce de estoque, com o sexo e a linhagem dos animais
    expect(nova).toMatchObject({ tipo: 'estoque', sexo: 'M', idLinhagem: 3, idEspecie: 1, face: 1, linha: 2, coluna: 1 })
    expect(vivosEm(nova.id)).toHaveLength(5)
    expect(vivosEm(2)).toHaveLength(6)
    expect(vivosEm(1)).toHaveLength(0)
    // chegam na data do fato
    expect(vivosEm(nova.id).every((a) => iso(a.dtMovimento) === '2026-09-25')).toBe(true)
    expect(banco.ocorrencias.map((o) => [o.tipo, o.idCaixaOrigem, o.idCaixaDestino, (o.ids as number[]).length])).toEqual([
      ['mudanca', 1, nova.id, 5],
      ['mudanca', 1, 2, 4],
    ])
  })

  it('o casal ativo segura a caixa vazia; com o casal encerrado ela e liberada pela mudanca', async () => {
    await registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 5, destino: { posicao: vazia } } }, 7)
    expect(banco.liberadas).toEqual([])

    ;(banco.casais.get(10) as Casal).ativo = false
    const feita = await registrarMudanca(1, { dtFato: '2026-09-26', femeas: { qtd: 4, destino: { idCaixa: 2 } } }, 7)

    expect(feita.liberada).toBe(true)
    expect(banco.liberadas).toEqual([{ idCaixa: 1, dtFato: '2026-09-26', motivo: 'mudanca' }])
  })

  it('saem os livres primeiro: o reservado fica enquanto houver livre', async () => {
    const [primeiro] = banco.animais.filter((a) => a.idCaixa === 1 && a.sexo === 'M')
    if (primeiro === undefined) throw new Error('sem animal')
    primeiro.idPedido = 9

    await registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 4, destino: { posicao: vazia } } }, 7)

    expect(vivosEm(1).filter((a) => a.sexo === 'M').map((a) => a.idPedido)).toEqual([9])
  })

  it('com reservados de dois pedidos e livres que nao bastam, pede o pedido; com ele, completa os livres', async () => {
    // 5 machos: 3 livres, 1 do pedido #7 e 1 do #9; mudam 4
    const [, , , do7, do9] = banco.animais.filter((a) => a.idCaixa === 1 && a.sexo === 'M')
    if (do7 === undefined || do9 === undefined) throw new Error('sem animal')
    do7.idPedido = 7
    do9.idPedido = 9

    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 4, destino: { posicao: vazia } } }, 7),
    ).rejects.toEqual(
      expect.objectContaining({
        codigo: 'PEDIDO_NAO_INDICADO',
        extras: { campos: { 'machos.idPedido': 'Escolha um dos pedidos: #7, #9.' } },
      }),
    )

    // o tecnico faz o que a recusa pede: diz o pedido, e os livres vao junto
    const feita = await registrarMudanca(
      1,
      { dtFato: '2026-09-25', machos: { qtd: 4, idPedido: 9, destino: { posicao: vazia } } },
      7,
    )

    expect(vivosEm(feita.caixas[0]?.idCaixa as number).map((a) => a.idPedido)).toEqual([null, null, null, 9])
    expect(vivosEm(1).filter((a) => a.sexo === 'M').map((a) => a.idPedido)).toEqual([7])
  })

  it('so do pedido: leva so os reservados dele, mesmo com livres na caixa, e a reserva vai junto', async () => {
    const machos = banco.animais.filter((a) => a.idCaixa === 1 && a.sexo === 'M')
    for (const a of machos.slice(3)) a.idPedido = 9

    const feita = await registrarMudanca(
      1,
      { dtFato: '2026-09-25', machos: { qtd: 2, idPedido: 9, soDoPedido: true, destino: { posicao: vazia } } },
      7,
    )

    const destino = feita.caixas[0]?.idCaixa as number
    expect(vivosEm(destino).map((a) => a.idPedido)).toEqual([9, 9])
    expect(vivosEm(1).filter((a) => a.sexo === 'M').map((a) => a.idPedido)).toEqual([null, null, null])
  })

  it('so do pedido e sem reservados que bastem, nada muda', async () => {
    await expect(
      registrarMudanca(
        1,
        { dtFato: '2026-09-25', machos: { qtd: 1, idPedido: 9, soDoPedido: true, destino: { posicao: vazia } } },
        7,
      ),
    ).rejects.toEqual(recusa(409, 'SEM_ANIMAIS'))
    expect(banco.ocorrencias).toEqual([])
  })
})

describe('a mudanca de estoque para estoque', () => {
  it('juntar caixas: a de estoque que esvazia e liberada na hora', async () => {
    caixa(3, 'estoque', { sexo: 'F', idLinhagem: 3 })
    animais(20, 3, 'F', 3, { dtMovimento: d('2026-09-30') })

    const feita = await registrarMudanca(3, { dtFato: '2026-10-02', femeas: { qtd: 3, destino: { idCaixa: 2 } } }, 7)

    expect(feita.liberada).toBe(true)
    expect(banco.liberadas).toEqual([{ idCaixa: 3, dtFato: '2026-10-02', motivo: 'mudanca' }])
    expect(vivosEm(2)).toHaveLength(5)
  })

  it('a caixa com duas idades no sexo pede de qual; com a data, so os daquela idade mudam', async () => {
    animais(20, 2, 'F', 3, { dtMovimento: d('2026-09-30') })

    await expect(
      registrarMudanca(2, { dtFato: '2026-10-02', femeas: { qtd: 1, destino: { posicao: vazia } } }, 7),
    ).rejects.toEqual(noCampo('femeas.dtNascimento', 'mais de uma idade'))

    const feita = await registrarMudanca(
      2,
      { dtFato: '2026-10-02', femeas: { qtd: 3, dtNascimento: '2026-09-01', destino: { posicao: vazia } } },
      7,
    )

    expect(vivosEm(feita.caixas[0]?.idCaixa as number).map(nascimento)).toEqual(['2026-09-01', '2026-09-01', '2026-09-01'])
    expect(vivosEm(2).map(nascimento)).toEqual(['2026-08-01', '2026-08-01'])
  })

  it('a caixa de destino ja existe na data: antes dos primeiros animais dela e recusado', async () => {
    caixa(3, 'estoque', { sexo: 'F', idLinhagem: 3 })
    animais(21, 3, 'F', 1, { dtMovimento: d('2026-10-10') })
    banco.chegadas.set(3, d('2026-10-10'))
    animais(20, 2, 'F', 3, { dtMovimento: d('2026-09-30') })
    const femeas = (dtFato: string) => ({
      dtFato,
      femeas: { qtd: 3, dtNascimento: '2026-09-01', destino: { idCaixa: 3 } },
    })

    await expect(registrarMudanca(2, femeas('2026-10-01'), 7)).rejects.toEqual(
      noCampo('dtFato', 'primeiros animais na caixa F1C'),
    )
    expect(banco.ocorrencias).toEqual([])

    await expect(registrarMudanca(2, femeas('2026-10-10'), 7)).resolves.toMatchObject({
      caixas: [{ idCaixa: 3, qtd: 3 }],
    })
  })

  it('a chegada nunca volta no tempo: antes da chegada dos animais na caixa e recusado', async () => {
    await expect(
      registrarMudanca(2, { dtFato: '2026-08-24', femeas: { qtd: 2, destino: { posicao: vazia } } }, 7),
    ).rejects.toEqual(noCampo('dtFato', 'chegada dos animais'))
  })
})

describe('o que a mudanca recusa', () => {
  it('filhote que mama fica com a mae', async () => {
    ;(banco.partos.get(20) as Parto).dtDesmameReal = null

    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 5, destino: { posicao: vazia } } }, 7),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(vivosEm(1)).toHaveLength(9)
  })

  it('a chegada no estoque e no dia do desmame ou depois', async () => {
    await expect(
      registrarMudanca(1, { dtFato: '2026-09-22', machos: { qtd: 5, destino: { posicao: vazia } } }, 7),
    ).rejects.toEqual(noCampo('dtFato', 'desmame'))

    await expect(
      registrarMudanca(1, { dtFato: '2026-09-23', machos: { qtd: 5, destino: { posicao: vazia } } }, 7),
    ).resolves.toMatchObject({ liberada: false })
  })

  it('a caixa de estoque do outro sexo ou de outra linhagem nao recebe', async () => {
    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 1, destino: { idCaixa: 2 } } }, 7),
    ).rejects.toEqual(noCampo('machos.destino', 'outro sexo'))

    caixa(3, 'estoque', { sexo: 'F', idLinhagem: 6 })
    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', femeas: { qtd: 1, destino: { idCaixa: 3 } } }, 7),
    ).rejects.toEqual(noCampo('femeas.destino', 'outra linhagem'))
    expect(banco.ocorrencias).toEqual([])
  })

  it('caixa de casal nao recebe animais de fora, e a caixa nao muda para ela mesma', async () => {
    caixa(3, 'casal')
    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 1, destino: { idCaixa: 3 } } }, 7),
    ).rejects.toEqual(noCampo('machos.destino', 'caixa de estoque'))

    await expect(
      registrarMudanca(2, { dtFato: '2026-09-25', femeas: { qtd: 1, destino: { idCaixa: 2 } } }, 7),
    ).rejects.toEqual(noCampo('femeas.destino', 'já estão nesta caixa'))
  })

  it('posicao ocupada, e machos e femeas na mesma posicao', async () => {
    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 1, destino: { posicao: { ...vazia, linha: 1 } } } }, 7),
    ).rejects.toEqual(noCampo('machos.destino', 'já tem uma caixa'))

    await expect(
      registrarMudanca(
        1,
        { dtFato: '2026-09-25', machos: { qtd: 1, destino: { posicao: vazia } }, femeas: { qtd: 1, destino: { posicao: vazia } } },
        7,
      ),
    ).rejects.toEqual(noCampo('femeas.destino', 'caixas diferentes'))
  })

  it('a caixa liberada nao perde animal', async () => {
    ;(banco.caixas.get(1) as Caixa).ativa = false

    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 1, destino: { posicao: vazia } } }, 7),
    ).rejects.toEqual(recusa(409, 'CAIXA_LIBERADA'))
  })

  it('mais animais do que ha: nada muda', async () => {
    await expect(
      registrarMudanca(1, { dtFato: '2026-09-25', machos: { qtd: 6, destino: { posicao: vazia } } }, 7),
    ).rejects.toEqual(recusa(409, 'SEM_ANIMAIS'))
    expect([...banco.caixas.values()].filter((c) => c.id >= 1000)).toEqual([])
  })
})

describe('virar caixa de estoque', () => {
  const pronta: CaixaParaVirar = {
    codigo: 'F1A',
    ativa: true,
    tipo: 'casal',
    casalAtivo: false,
    partoPendente: false,
    ninhadas: [{ ordem: 1, casal: 'AB', idLinhagem: 3, desmamado: true, vivos: { m: 0, f: 4 } }],
  }
  const recusada = (caixa: Partial<CaixaParaVirar>, codigo: string, trecho: string) =>
    expect(viradaParaEstoque({ ...pronta, ...caixa })).toEqual({
      recusa: { codigo, mensagem: expect.stringContaining(trecho) },
    })

  it('o casal encerrado, sem parto pendente e com desmamados de um sexo e uma linhagem: vira com esse sexo', () => {
    expect(viradaParaEstoque(pronta)).toEqual({ sexo: 'F', idLinhagem: 3 })
  })

  it('o que impede', () => {
    recusada({ casalAtivo: true }, 'SEQUENCIA_INVALIDA', 'encerre o casal')
    recusada({ partoPendente: true }, 'SEQUENCIA_INVALIDA', 'parto pendente')
    recusada({ ninhadas: [] }, 'SEQUENCIA_INVALIDA', 'Não sobrou animal')
    recusada({ tipo: 'estoque' }, 'CAIXA_DE_ESTOQUE', 'já é de estoque')
    recusada({ ativa: false }, 'CAIXA_LIBERADA', 'já foi liberada')
    recusada(
      { ninhadas: [{ ordem: 2, casal: 'AB', idLinhagem: 3, desmamado: false, vivos: { m: 0, f: 4 } }] },
      'CAIXA_COM_ANIMAIS',
      'ainda está em aleitamento',
    )
    recusada(
      { ninhadas: [{ ordem: 1, casal: 'AB', idLinhagem: 3, desmamado: true, vivos: { m: 1, f: 4 } }] },
      'CAIXA_COM_ANIMAIS',
      'machos e fêmeas',
    )
    recusada(
      {
        ninhadas: [
          { ordem: 1, casal: 'AB', idLinhagem: 3, desmamado: true, vivos: { m: 0, f: 4 } },
          { ordem: 1, casal: 'CD', idLinhagem: 6, desmamado: true, vivos: { m: 0, f: 1 } },
        ],
      },
      'CAIXA_COM_ANIMAIS',
      'linhagens diferentes',
    )
  })

  it('grava o tipo, o sexo e a linhagem da caixa, sem mexer em animal, e registra no historico', async () => {
    // o casal encerrou e os machos ja mudaram: sobram na caixa as 4 femeas desmamadas
    ;(banco.casais.get(10) as Casal).ativo = false
    banco.animais = banco.animais.filter((a) => !(a.idCaixa === 1 && a.sexo === 'M'))
    const antes = banco.animais.map((a) => ({ ...a }))

    await expect(virarCaixaDeEstoque(1, 7)).resolves.toEqual({ idCaixa: 1, sexo: 'F' })

    expect(banco.caixas.get(1)).toMatchObject({ tipo: 'estoque', sexo: 'F', idLinhagem: 3 })
    expect(banco.animais).toEqual(antes)
    expect(banco.historicos).toEqual([
      expect.objectContaining({ entidade: 'caixa', idEntidade: 1, acao: 'virar_estoque', idUsuario: 7 }),
    ])
  })

  it('a recusa sai com o codigo da regra e nada muda', async () => {
    await expect(virarCaixaDeEstoque(1, 7)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.caixas.get(1)?.tipo).toBe('casal')
  })

  it('caixa que nao existe', async () => {
    await expect(virarCaixaDeEstoque(99, 7)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
