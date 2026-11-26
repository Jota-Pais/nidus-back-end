import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Escolha, Escolhido, Grupo } from '../colonia/escolha.ts'
import type { Lancamento } from '../colonia/ocorrencia.ts'
import { erroDeRegra } from '../../shared/erros.ts'
import {
  exigirDestinosDiferentes,
  exigirSomaQueCabe,
  partesDaMudanca,
  registrarMudanca,
  viradaParaEstoque,
  virarCaixaDeEstoque,
} from './mudanca.service.ts'
import type { ParteComIdade, ParteDaMudanca } from './mudanca.service.ts'
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
  estante: { findFirst: async () => ({ id: 1, numeroVisivel: 'E1', formato: { faces: 2, linhas: 3, colunas: 3 } }) },
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
          return { ...parto, idLinhagem: casal.idLinhagem, casal: { identificacao: casal.identificacao } }
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
          (grupo.dtNascimento === undefined || nascimento(a) === grupo.dtNascimento) &&
          !(escolha.excluir ?? []).includes(a.id),
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

      // a recusa de verdade (409 SEM_ANIMAIS, sem campo): o servico a poe no campo da parte
      if (escolhidos.length < qtd) throw erroDeRegra('SEM_ANIMAIS', `Pediu ${qtd}, mas so ha ${escolhidos.length} para esta operacao.`)

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

describe('a mudanca de um sexo dividido em varias caixas', () => {
  const em = (linha: number, coluna: number) => ({ ...vazia, linha, coluna })
  const novas = () => [...banco.caixas.values()].filter((c) => c.id >= 1000)
  const nada = () => {
    expect(banco.ocorrencias).toEqual([])
    expect(novas()).toEqual([])
    expect(vivosEm(1)).toHaveLength(9)
  }

  it('os machos em duas partes, uma posicao vazia e uma caixa de estoque que existe: uma ocorrencia por parte', async () => {
    caixa(3, 'estoque', { sexo: 'M', idLinhagem: 3 })

    const feita = await registrarMudanca(
      1,
      {
        dtFato: '2026-09-25',
        machos: [
          { qtd: 2, destino: { posicao: vazia } },
          { qtd: 3, destino: { idCaixa: 3 } },
        ],
      },
      7,
    )

    const nova = novas()[0] as Caixa
    expect(feita).toEqual({
      caixas: [
        { idCaixa: nova.id, codigo: 'F2A', sexo: 'M', qtd: 2 },
        { idCaixa: 3, codigo: 'F1C', sexo: 'M', qtd: 3 },
      ],
      liberada: false,
    })
    expect(nova).toMatchObject({ tipo: 'estoque', sexo: 'M', idLinhagem: 3 })
    expect(vivosEm(nova.id)).toHaveLength(2)
    expect(vivosEm(3)).toHaveLength(3)
    expect(vivosEm(1).map((a) => a.sexo)).toEqual(['F', 'F', 'F', 'F'])
    expect(banco.ocorrencias.map((o) => [o.tipo, o.idCaixaOrigem, o.idCaixaDestino, (o.ids as number[]).length])).toEqual([
      ['mudanca', 1, nova.id, 2],
      ['mudanca', 1, 3, 3],
    ])
  })

  it('cada parte leva animais diferentes: nenhum rato vai duas vezes', async () => {
    const feita = await registrarMudanca(
      1,
      {
        dtFato: '2026-09-25',
        machos: [
          { qtd: 2, destino: { posicao: em(2, 1) } },
          { qtd: 2, destino: { posicao: em(2, 2) } },
          { qtd: 1, destino: { posicao: em(2, 3) } },
        ],
      },
      7,
    )

    expect(feita.caixas.map((c) => c.qtd)).toEqual([2, 2, 1])
    const idsPorOcorrencia = banco.ocorrencias.map((o) => o.ids as number[])
    expect(new Set(idsPorOcorrencia.flat()).size).toBe(5)
    expect(feita.caixas.map((c) => vivosEm(c.idCaixa).length)).toEqual([2, 2, 1])
    expect(feita.liberada).toBe(false)
  })

  it('os dois sexos divididos: machos primeiro na resposta, mesmo escritos depois', async () => {
    const feita = await registrarMudanca(
      1,
      {
        dtFato: '2026-09-25',
        femeas: [
          { qtd: 1, destino: { posicao: em(3, 1) } },
          { qtd: 3, destino: { posicao: em(3, 2) } },
        ],
        machos: [
          { qtd: 4, destino: { posicao: em(2, 1) } },
          { qtd: 1, destino: { posicao: em(2, 2) } },
        ],
      },
      7,
    )

    expect(feita.caixas.map((c) => [c.sexo, c.qtd])).toEqual([
      ['M', 4],
      ['M', 1],
      ['F', 1],
      ['F', 3],
    ])
    expect(banco.ocorrencias).toHaveLength(4)
    expect(vivosEm(1)).toHaveLength(0)
  })

  it('soma igual aos vivos passa, e com o casal encerrado a caixa de origem e liberada', async () => {
    ;(banco.casais.get(10) as Casal).ativo = false

    const feita = await registrarMudanca(
      1,
      {
        dtFato: '2026-09-25',
        machos: [
          { qtd: 3, destino: { posicao: em(2, 1) } },
          { qtd: 2, destino: { posicao: em(2, 2) } },
        ],
        femeas: { qtd: 4, destino: { posicao: em(3, 1) } },
      },
      7,
    )

    expect(feita.liberada).toBe(true)
    expect(banco.liberadas).toEqual([{ idCaixa: 1, dtFato: '2026-09-25', motivo: 'mudanca' }])
  })

  it('soma maior que os vivos: SEM_ANIMAIS na quantidade da parte que passa, com quantos sobram, e nada grava', async () => {
    await expect(
      registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 3, destino: { posicao: em(2, 1) } },
            { qtd: 3, destino: { posicao: em(2, 2) } },
          ],
        },
        7,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'SEM_ANIMAIS',
        message: expect.stringContaining('As caixas somam 6 machos, mas só há 5 nesta caixa'),
        extras: { campos: { 'machos.1.qtd': 'Passa do total: sobram 2 para esta caixa.' } },
      }),
    )
    nada()
  })

  it('sobrando um so, o campo diz "sobra 1", e e a primeira parte que passa que leva o campo', async () => {
    await expect(
      registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 4, destino: { posicao: em(2, 1) } },
            { qtd: 2, destino: { posicao: em(2, 2) } },
            { qtd: 1, destino: { posicao: em(2, 3) } },
          ],
        },
        7,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ extras: { campos: { 'machos.1.qtd': 'Passa do total: sobra 1 para esta caixa.' } } }),
    )
    nada()
  })

  it('a soma de um sexo nao conta o outro: 5 machos cabem, mas as femeas passam das 4', async () => {
    await expect(
      registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 2, destino: { posicao: em(2, 1) } },
            { qtd: 3, destino: { posicao: em(2, 2) } },
          ],
          femeas: [
            { qtd: 2, destino: { posicao: em(3, 1) } },
            { qtd: 3, destino: { posicao: em(3, 2) } },
          ],
        },
        7,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        codigo: 'SEM_ANIMAIS',
        extras: { campos: { 'femeas.1.qtd': 'Passa do total: sobram 2 para esta caixa.' } },
      }),
    )
    nada()
  })

  it('a mesma caixa de estoque em duas partes do mesmo sexo e recusada, todas as repetidas de uma vez', async () => {
    caixa(3, 'estoque', { sexo: 'M', idLinhagem: 3 })

    await expect(
      registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 1, destino: { idCaixa: 3 } },
            { qtd: 1, destino: { idCaixa: 3 } },
            { qtd: 1, destino: { posicao: vazia } },
            { qtd: 1, destino: { posicao: vazia } },
            { qtd: 1, destino: { idCaixa: 3 } },
          ],
        },
        7,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        codigo: 'VALIDACAO',
        extras: {
          campos: {
            'machos.1.destino': 'Esta caixa já está em outra parte: junte as quantidades numa parte só.',
            'machos.3.destino': 'Esta posição já está em outra parte: junte as quantidades numa parte só.',
            'machos.4.destino': 'Esta caixa já está em outra parte: junte as quantidades numa parte só.',
          },
        },
      }),
    )
    nada()
  })

  it('machos e femeas na mesma posicao ou na mesma caixa: recusa no destino das femeas', async () => {
    await expect(
      registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 1, destino: { posicao: em(2, 1) } },
            { qtd: 1, destino: { posicao: em(2, 2) } },
          ],
          femeas: [
            { qtd: 1, destino: { posicao: em(3, 1) } },
            { qtd: 1, destino: { posicao: em(2, 2) } },
          ],
        },
        7,
      ),
    ).rejects.toEqual(noCampo('femeas.1.destino', 'Machos e fêmeas vão em caixas diferentes.'))

    caixa(3, 'estoque', { sexo: 'M', idLinhagem: 3 })
    await expect(
      registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [{ qtd: 1, destino: { idCaixa: 3 } }],
          femeas: [{ qtd: 1, destino: { idCaixa: 3 } }],
        },
        7,
      ),
    ).rejects.toEqual(noCampo('femeas.0.destino', 'caixas diferentes'))
    nada()
  })

  it('uma parte recusada pelo destino (outro sexo) fica no campo dela, pelo indice da parte', async () => {
    await expect(
      registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 1, destino: { posicao: em(2, 1) } },
            { qtd: 1, destino: { idCaixa: 2 } },
          ],
        },
        7,
      ),
    ).rejects.toEqual(noCampo('machos.1.destino', 'outro sexo'))
  })

  describe('com duas idades no mesmo sexo', () => {
    beforeEach(() => {
      // mais 3 machos de um parto de 10/08, tambem desmamados, na caixa 1: 5 de 01/09 e 3 de 10/08
      banco.partos.set(22, {
        id: 22,
        idCasal: 10,
        ordem: 0,
        dtPartoReal: d('2026-08-10'),
        dtDesmameReal: d('2026-09-02'),
        dtSemNinhada: null,
      })
      animais(22, 1, 'M', 3)
    })

    it('uma parte de cada idade, cada uma com a data dela', async () => {
      const feita = await registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 5, dtNascimento: '2026-09-01', destino: { posicao: em(2, 1) } },
            { qtd: 3, dtNascimento: '2026-08-10', destino: { posicao: em(2, 2) } },
          ],
        },
        7,
      )

      expect(vivosEm(feita.caixas[0]?.idCaixa as number).map(nascimento)).toEqual(Array(5).fill('2026-09-01'))
      expect(vivosEm(feita.caixas[1]?.idCaixa as number).map(nascimento)).toEqual(Array(3).fill('2026-08-10'))
    })

    it('parte sem a data da idade e recusada no campo dela, antes de qualquer animal sair', async () => {
      await expect(
        registrarMudanca(
          1,
          {
            dtFato: '2026-09-25',
            machos: [
              { qtd: 5, dtNascimento: '2026-09-01', destino: { posicao: em(2, 1) } },
              { qtd: 1, destino: { posicao: em(2, 2) } },
            ],
          },
          7,
        ),
      ).rejects.toEqual(noCampo('machos.1.dtNascimento', 'mais de uma idade'))
      expect(banco.ocorrencias).toEqual([])
      expect(novas()).toEqual([])
    })

    it('a soma e por idade: 4 + 2 de 10/08 passam dos 3, ainda que os 8 machos bastem', async () => {
      await expect(
        registrarMudanca(
          1,
          {
            dtFato: '2026-09-25',
            machos: [
              { qtd: 4, dtNascimento: '2026-08-10', destino: { posicao: em(2, 1) } },
              { qtd: 2, dtNascimento: '2026-08-10', destino: { posicao: em(2, 2) } },
            ],
          },
          7,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          codigo: 'SEM_ANIMAIS',
          message: expect.stringContaining('nesta caixa e idade'),
          extras: { campos: { 'machos.0.qtd': 'Passa do total: sobram 3 para esta caixa.' } },
        }),
      )
      expect(banco.ocorrencias).toEqual([])
      expect(novas()).toEqual([])
    })
  })

  describe('com reservados', () => {
    const machos = () => banco.animais.filter((a) => a.idCaixa === 1 && a.sexo === 'M')

    it('so do pedido numa parte e livres na outra, no mesmo sexo', async () => {
      for (const a of machos().slice(3)) a.idPedido = 9

      const feita = await registrarMudanca(
        1,
        {
          dtFato: '2026-09-25',
          machos: [
            { qtd: 2, idPedido: 9, soDoPedido: true, destino: { posicao: em(2, 1) } },
            { qtd: 3, destino: { posicao: em(2, 2) } },
          ],
        },
        7,
      )

      expect(vivosEm(feita.caixas[0]?.idCaixa as number).map((a) => a.idPedido)).toEqual([9, 9])
      expect(vivosEm(feita.caixas[1]?.idCaixa as number).map((a) => a.idPedido)).toEqual([null, null, null])
    })

    it('livres que nao bastam com dois pedidos: pede o pedido no campo da parte', async () => {
      const [, , , do7, do9] = machos()
      if (do7 === undefined || do9 === undefined) throw new Error('sem animal')
      do7.idPedido = 7
      do9.idPedido = 9

      await expect(
        registrarMudanca(
          1,
          {
            dtFato: '2026-09-25',
            machos: [
              { qtd: 1, destino: { posicao: em(2, 1) } },
              { qtd: 4, destino: { posicao: em(2, 2) } },
            ],
          },
          7,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          codigo: 'PEDIDO_NAO_INDICADO',
          extras: { campos: { 'machos.1.idPedido': 'Escolha um dos pedidos: #7, #9.' } },
        }),
      )
    })

    it('reservados que faltam na parte 2: SEM_ANIMAIS no campo da quantidade dela', async () => {
      // 2 reservados do pedido 9: a parte 1 leva 1 e a parte 2 pede 2 so do pedido, mas resta 1
      for (const a of machos().slice(3)) a.idPedido = 9

      await expect(
        registrarMudanca(
          1,
          {
            dtFato: '2026-09-25',
            machos: [
              { qtd: 1, idPedido: 9, soDoPedido: true, destino: { posicao: em(2, 1) } },
              { qtd: 2, idPedido: 9, soDoPedido: true, destino: { posicao: em(2, 2) } },
            ],
          },
          7,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          status: 409,
          codigo: 'SEM_ANIMAIS',
          extras: { campos: { 'machos.1.qtd': expect.stringContaining('Pediu 2') } },
        }),
      )
    })

    it('com o objeto antigo (sem lista), a falta de reservados cai em machos.qtd', async () => {
      await expect(
        registrarMudanca(
          1,
          { dtFato: '2026-09-25', machos: { qtd: 1, idPedido: 9, soDoPedido: true, destino: { posicao: vazia } } },
          7,
        ),
      ).rejects.toEqual(
        expect.objectContaining({ codigo: 'SEM_ANIMAIS', extras: { campos: { 'machos.qtd': expect.any(String) } } }),
      )
    })
  })
})

describe('as funcoes da mudanca em partes', () => {
  const posicao = (linha: number, coluna: number) => ({ posicao: { idEstante: 1, face: 'frontal' as const, linha, coluna } })
  const parte = (sexo: 'M' | 'F', campo: string, destino: ParteDaMudanca['destino'], qtd = 1): ParteDaMudanca => ({
    sexo,
    campo,
    qtd,
    destino,
  })
  const comIdade = (p: ParteDaMudanca, dtNascimento?: string): ParteComIdade => ({ ...p, dtNascimento })

  describe('partesDaMudanca', () => {
    it('o objeto antigo e uma parte so, no campo do sexo', () => {
      expect(partesDaMudanca({ dtFato: '2026-09-25', machos: { qtd: 2, destino: { idCaixa: 3 } } })).toEqual([
        { sexo: 'M', campo: 'machos', qtd: 2, destino: { idCaixa: 3 } },
      ])
    })

    it('a lista vira uma parte por item, com o indice no campo, e os machos vem antes das femeas', () => {
      const partes = partesDaMudanca({
        dtFato: '2026-09-25',
        femeas: { qtd: 4, destino: { idCaixa: 5 } },
        machos: [
          { qtd: 1, destino: { idCaixa: 3 } },
          { qtd: 2, dtNascimento: '2026-09-01', destino: posicao(2, 1) },
        ],
      })

      expect(partes.map((p) => [p.sexo, p.campo, p.qtd])).toEqual([
        ['M', 'machos.0', 1],
        ['M', 'machos.1', 2],
        ['F', 'femeas', 4],
      ])
      expect(partes[1]?.dtNascimento).toBe('2026-09-01')
    })

    it('sexo ausente nao gera parte', () => {
      expect(partesDaMudanca({ dtFato: '2026-09-25' })).toEqual([])
    })
  })

  describe('exigirDestinosDiferentes', () => {
    it('destinos todos diferentes passam', () => {
      expect(() =>
        exigirDestinosDiferentes([
          parte('M', 'machos.0', posicao(2, 1)),
          parte('M', 'machos.1', posicao(2, 2)),
          parte('M', 'machos.2', { idCaixa: 3 }),
          parte('F', 'femeas', { idCaixa: 4 }),
        ]),
      ).not.toThrow()
    })

    it('a mesma linha e coluna em outra face ou outra estante e outro lugar', () => {
      const outraFace = { posicao: { idEstante: 1, face: 'traseira' as const, linha: 2, coluna: 1 } }
      const outraEstante = { posicao: { idEstante: 2, face: 'frontal' as const, linha: 2, coluna: 1 } }

      expect(() =>
        exigirDestinosDiferentes([
          parte('M', 'machos.0', posicao(2, 1)),
          parte('M', 'machos.1', outraFace),
          parte('M', 'machos.2', outraEstante),
        ]),
      ).not.toThrow()
    })

    it('repetido no sexo: junte as quantidades; entre sexos: caixas diferentes; tudo num erro so', () => {
      const erro = (() => {
        try {
          exigirDestinosDiferentes([
            parte('M', 'machos.0', { idCaixa: 3 }),
            parte('M', 'machos.1', { idCaixa: 3 }),
            parte('F', 'femeas.0', posicao(2, 1)),
            parte('F', 'femeas.1', posicao(2, 1)),
            parte('M', 'machos.2', posicao(2, 1)),
          ])
        } catch (e) {
          return e
        }
      })()

      expect(erro).toMatchObject({
        status: 400,
        codigo: 'VALIDACAO',
        extras: {
          campos: {
            'machos.1.destino': 'Esta caixa já está em outra parte: junte as quantidades numa parte só.',
            'femeas.1.destino': 'Esta posição já está em outra parte: junte as quantidades numa parte só.',
            'machos.2.destino': 'Machos e fêmeas vão em caixas diferentes.',
          },
        },
      })
    })
  })

  describe('exigirSomaQueCabe', () => {
    const ninhadas = [{ dtNascimento: '2026-09-01', vivos: { m: 5, f: 4 } }]
    const recusa = (partes: ParteComIdade[], ninhadasDaCaixa = ninhadas) => {
      try {
        exigirSomaQueCabe(partes, ninhadasDaCaixa)
      } catch (e) {
        return e
      }
    }
    const macho = (campo: string, qtd: number, idCaixa: number, dtNascimento?: string) =>
      comIdade(parte('M', campo, { idCaixa }, qtd), dtNascimento)

    it('soma menor ou igual passa, sexo por sexo', () => {
      expect(() =>
        exigirSomaQueCabe(
          [macho('machos.0', 2, 3), macho('machos.1', 3, 4), comIdade(parte('F', 'femeas', { idCaixa: 5 }, 4))],
          ninhadas,
        ),
      ).not.toThrow()
    })

    it('uma parte so que passa: "Pediu 7 machos, mas so ha 5", com o limite no campo', () => {
      expect(recusa([macho('machos', 7, 3)])).toMatchObject({
        status: 409,
        codigo: 'SEM_ANIMAIS',
        message: 'Pediu 7 machos, mas só há 5 nesta caixa.',
        extras: { campos: { 'machos.qtd': 'Só há 5 nesta caixa.' } },
      })
    })

    it('varias partes: "As caixas somam 7 machos", e o campo e o da que estoura', () => {
      expect(recusa([macho('machos.0', 4, 3), macho('machos.1', 3, 4)])).toMatchObject({
        message: 'As caixas somam 7 machos, mas só há 5 nesta caixa.',
        extras: { campos: { 'machos.1.qtd': 'Passa do total: sobra 1 para esta caixa.' } },
      })
    })

    it('a primeira parte ja passa sozinha: o campo e o dela, com tudo o que ha', () => {
      expect(recusa([macho('machos.0', 6, 3), macho('machos.1', 1, 4)])).toMatchObject({
        extras: { campos: { 'machos.0.qtd': 'Passa do total: sobram 5 para esta caixa.' } },
      })
    })

    it('sem nenhum vivo do sexo, o aviso e que nao ha', () => {
      const semFemeas = [{ dtNascimento: '2026-09-01', vivos: { m: 5, f: 0 } }]

      expect(recusa([comIdade(parte('F', 'femeas', { idCaixa: 3 }, 1))], semFemeas)).toMatchObject({
        codigo: 'SEM_ANIMAIS',
        message: 'Não há fêmeas vivas nesta caixa para esta mudança.',
      })
    })

    it('com a idade, so os vivos daquela idade contam; havendo mais de uma idade a mensagem diz "caixa e idade"', () => {
      const duas = [
        { dtNascimento: '2026-09-01', vivos: { m: 5, f: 0 } },
        { dtNascimento: '2026-08-10', vivos: { m: 3, f: 0 } },
      ]

      expect(() => exigirSomaQueCabe([macho('machos.0', 5, 3, '2026-09-01'), macho('machos.1', 3, 4, '2026-08-10')], duas)).not.toThrow()
      expect(recusa([macho('machos.0', 4, 3, '2026-08-10')], duas)).toMatchObject({
        message: 'Pediu 4 machos, mas só há 3 nesta caixa e idade.',
      })
    })
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
