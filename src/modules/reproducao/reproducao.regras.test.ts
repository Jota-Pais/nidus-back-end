import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Escolha, Escolhido, Grupo } from '../colonia/escolha.ts'
import type { Lancamento } from '../colonia/ocorrencia.ts'
import { cicloFicha } from './cicloFicha.ts'
import { corrigirAcasalamento, corrigirDesmame, corrigirNascimento } from './correcao.service.ts'
import {
  encerrarCasal,
  fecharSemNinhada,
  formarCasal,
  registrarDesmame,
  registrarNascimento,
  registrarSelecao,
} from './reproducao.service.ts'

// Uma colonia de mentira, em memoria: caixas, casais, partos, os animais (uma linha por rato) e a
// trilha. O Prisma e as funcoes do modulo colonia sao trocados por versoes que leem e escrevem
// aqui, com o mesmo contrato: a escolha pega os livres primeiro e depois os reservados de um
// pedido, o lancamento aplica o tipo da ocorrencia nos animais, e a liberacao so libera caixa sem
// vivo (a de casal, tambem sem casal ativo e sem parto pendente). As regras finas de cada uma
// estao nos testes do modulo colonia; aqui ficam as regras do casal e do parto

type Caixa = {
  id: number
  codigo: string
  ativa: boolean
  tipo: string
  idEspecie: number
  sexo?: string | null
  idLinhagem?: number | null
}
type Casal = {
  id: number
  idCaixa: number
  idLinhagem: number
  identificacao: string
  ativo: boolean
  dtFormacao: Date
  dtEncerramento: Date | null
  motivoEncerramento?: string
}
type Parto = {
  id: number
  idCasal: number
  ordem: number
  dtAcasalamento: Date
  dtPartoReal: Date | null
  dtDesmameReal: Date | null
  dtSemNinhada: Date | null
  motivoSemNinhada: string | null
  idUsuarioParto?: number
}
type Animal = {
  id: number
  idParto: number
  sexo: 'M' | 'F'
  idCaixa: number
  situacao: string
  dtSaida: Date | null
  dtMovimento: Date | null
  idPedido: number | null
}
type Ocorrencia = {
  id: number
  tipo: string
  dtFato: Date
  idParto: number | null
  motivo: string | null
  ids: number[]
  anulada: boolean
  /** a caixa onde os animais chegaram (mudanca, a mais da correcao, volta da anulacao) */
  idCaixaDestino?: number | null
}

const banco = vi.hoisted(() => ({
  caixas: new Map<number, Caixa>(),
  casais: new Map<number, Casal>(),
  partos: new Map<number, Parto>(),
  animais: [] as Animal[],
  ocorrencias: [] as Ocorrencia[],
  historicos: [] as Record<string, unknown>[],
  liberadas: [] as { idCaixa: number; dtFato: string; motivo: string }[],
  linhagem: { id: 3, idEspecie: 1, nome: 'Wistar', ativa: true },
  parValido: true,
  proximoId: 1000,
  /** o dia da primeira chegada de animais em cada caixa (a primeira ocorrencia com destino nela) */
  primeiraChegada: new Map<number, Date>(),
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const iso = (data: Date | null) => (data === null ? null : data.toISOString().slice(0, 10))

// ------------------------------------------------------------------ o Prisma de mentira

function partoComCasal(parto: Parto) {
  const casal = banco.casais.get(parto.idCasal) as Casal
  return { ...parto, casal: { ...casal, caixa: banco.caixas.get(casal.idCaixa) } }
}

type FiltroDeOcorrencia = {
  tipo?: string | { in: string[] }
  idParto?: number
  motivo?: string
  animais?: { some: { animal: { idParto: number; situacao?: { not: string } } } }
  /** os 'not' do destino: { not: null } e { not: idCaixa }, como o Prisma (o null nunca passa no 'not') */
  AND?: { idCaixaDestino: { not: number | null } }[]
}

function ocorrenciasQue(where: FiltroDeOcorrencia) {
  return banco.ocorrencias.filter((o) => {
    if (o.anulada) return false
    if (typeof where.tipo === 'string' && o.tipo !== where.tipo) return false
    if (typeof where.tipo === 'object' && !where.tipo.in.includes(o.tipo)) return false
    if (where.idParto !== undefined && o.idParto !== where.idParto) return false
    if (where.motivo !== undefined && o.motivo !== where.motivo) return false
    if (where.animais !== undefined) {
      const { idParto, situacao } = where.animais.some.animal
      const casa = (a: Animal | undefined) => a?.idParto === idParto && (situacao === undefined || a.situacao !== situacao.not)
      if (!o.ids.some((id) => casa(banco.animais.find((a) => a.id === id)))) return false
    }
    for (const { idCaixaDestino } of where.AND ?? []) {
      const destino = o.idCaixaDestino ?? null
      if (destino === null || destino === idCaixaDestino.not) return false
    }
    return true
  })
}

const db = {
  $queryRaw: async () => [],
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  linhagem: { findUnique: async () => banco.linhagem },
  grupoGeneticoPar: {
    findFirst: async () => (banco.parValido ? { id: 1 } : null),
    findMany: async () => [{ grupoFemea: 'B' }],
  },
  estante: { findFirst: async () => ({ id: 1, numeroVisivel: 'E1', faces: 2, linhas: 3, colunas: 3 }) },
  caixa: {
    findUnique: async ({ where }: { where: { id: number } }) => {
      const caixa = banco.caixas.get(where.id)
      if (caixa === undefined) return null
      const casais = [...banco.casais.values()]
        .filter((c) => c.idCaixa === caixa.id)
        .map((c) => ({
          ativo: c.ativo,
          partos: [...banco.partos.values()].filter(
            (p) => p.idCasal === c.id && p.dtPartoReal === null && p.dtSemNinhada === null,
          ),
        }))
      return { ...caixa, casais }
    },
    findFirst: async () => null,
    create: async ({ data }: { data: Omit<Caixa, 'id' | 'codigo' | 'ativa'> }) => {
      const caixa = { id: banco.proximoId++, codigo: '', ativa: true, ...data }
      banco.caixas.set(caixa.id, caixa)
      return caixa
    },
  },
  casal: {
    findUnique: async ({ where }: { where: { id: number } }) => {
      const casal = banco.casais.get(where.id)
      if (casal === undefined) return null
      const partos = [...banco.partos.values()].filter((p) => p.idCasal === casal.id).sort((a, b) => b.ordem - a.ordem)
      return { ...casal, linhagem: { nome: 'Wistar' }, partos: partos.slice(0, 1) }
    },
    create: async ({ data }: { data: Omit<Casal, 'id' | 'ativo' | 'dtEncerramento'> }) => {
      const casal = { id: banco.proximoId++, ativo: true, dtEncerramento: null, ...data }
      banco.casais.set(casal.id, casal)
      return casal
    },
    update: async ({ where, data }: { where: { id: number }; data: Partial<Casal> }) => {
      Object.assign(banco.casais.get(where.id) as Casal, data)
    },
  },
  parto: {
    findUnique: async ({ where }: { where: { id: number } }) => {
      const parto = banco.partos.get(where.id)
      return parto === undefined ? null : partoComCasal(parto)
    },
    findFirst: async ({ where }: { where: { idCasal: number; ordem: number } }) =>
      [...banco.partos.values()].find((p) => p.idCasal === where.idCasal && p.ordem === where.ordem) ?? null,
    create: async ({ data }: { data: Pick<Parto, 'idCasal' | 'ordem' | 'dtAcasalamento'> }) => {
      const parto = {
        id: banco.proximoId++,
        dtPartoReal: null,
        dtDesmameReal: null,
        dtSemNinhada: null,
        motivoSemNinhada: null,
        ...data,
      }
      banco.partos.set(parto.id, parto)
      return parto
    },
    update: async ({ where, data }: { where: { id: number }; data: Partial<Parto> }) => {
      Object.assign(banco.partos.get(where.id) as Parto, data)
    },
    delete: async ({ where }: { where: { id: number } }) => {
      banco.partos.delete(where.id)
    },
  },
  ocorrencia: {
    findFirst: async ({ where, orderBy }: { where: FiltroDeOcorrencia; orderBy: { dtFato: 'asc' | 'desc' } }) => {
      const achadas = ocorrenciasQue(where).sort((a, b) => a.dtFato.getTime() - b.dtFato.getTime())
      const achada = orderBy.dtFato === 'asc' ? achadas[0] : achadas.at(-1)
      return achada === undefined
        ? null
        : { ...achada, animais: achada.ids.map((idAnimal) => ({ idAnimal })) }
    },
    updateMany: async ({ where, data }: { where: { idParto: number; tipo: string }; data: { dtFato: Date } }) => {
      for (const o of ocorrenciasQue(where)) o.dtFato = data.dtFato
    },
    update: async ({ where, data }: { where: { id: number }; data: { dtFato: Date } }) => {
      const ocorrencia = banco.ocorrencias.find((o) => o.id === where.id) as Ocorrencia
      ocorrencia.dtFato = data.dtFato
    },
    aggregate: async ({ where }: { where: { idCaixaDestino: number } }) => ({
      _min: { dtFato: banco.primeiraChegada.get(where.idCaixaDestino) ?? null },
    }),
  },
  historico: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      banco.historicos.push(data)
    },
  },
  animal: {
    // a primeira chegada dos animais do parto na caixa, sem contar registro anulado
    aggregate: async ({ where }: { where: { idParto: number; idCaixa: number } }) => {
      const chegadas = banco.animais
        .filter((a) => a.idParto === where.idParto && a.idCaixa === where.idCaixa && a.situacao !== 'anulado')
        .flatMap((a) => (a.dtMovimento === null ? [] : [a.dtMovimento]))
        .sort((x, y) => x.getTime() - y.getTime())
      return { _min: { dtMovimento: chegadas[0] ?? null } }
    },
  },
}

// o vi.mock sobe para o topo do arquivo, antes de 'db' existir: o Prisma le 'db' so na hora do uso
vi.mock('../../shared/prisma.ts', () => ({
  prisma: new Proxy({}, { get: (_prisma, chave) => db[chave as keyof typeof db] }),
}))

// ------------------------------------------------------------------ o modulo colonia de mentira

vi.mock('../colonia/consultas.ts', () => ({
  animaisDoParto: async (_tx: unknown, idParto: number) =>
    banco.animais
      .filter((a) => a.idParto === idParto)
      .map((a) => {
        const caixa = banco.caixas.get(a.idCaixa) as Caixa
        return { ...a, caixa: { codigo: caixa.codigo, tipo: caixa.tipo, estante: { numeroVisivel: 'E1' } } }
      }),
  ninhadasNaCaixa: async (_tx: unknown, idCaixa: number) => {
    const vivos = banco.animais.filter((a) => a.idCaixa === idCaixa && a.situacao === 'vivo')
    return [...new Set(vivos.map((a) => a.idParto))].map((idParto) => {
      const parto = banco.partos.get(idParto) as Parto
      return {
        idParto,
        ordem: parto.ordem,
        casal: 'AB',
        m: vivos.filter((a) => a.idParto === idParto && a.sexo === 'M').length,
        f: vivos.filter((a) => a.idParto === idParto && a.sexo === 'F').length,
        desmamado: parto.dtDesmameReal !== null,
      }
    })
  },
  faltasDosPedidos: async (_tx: unknown, ids: number[]) => ids.map((idPedido) => ({ idPedido, m: 0, f: 0, qualquer: 1 })),
}))

vi.mock('../colonia/escolha.ts', async (original) => ({
  ...(await original<typeof import('../colonia/escolha.ts')>()),
  escolherAnimais: async (_tx: unknown, grupo: Grupo, qtd: number, escolha: Escolha = {}) => {
    if (qtd === 0) return []

    const doGrupo = banco.animais.filter(
      (a) =>
        a.situacao === 'vivo' &&
        a.sexo === grupo.sexo &&
        (grupo.idCaixa === undefined || a.idCaixa === grupo.idCaixa) &&
        (grupo.idParto === undefined || a.idParto === grupo.idParto) &&
        !(escolha.excluir ?? []).includes(a.id),
    )
    const livres = doGrupo.filter((a) => a.idPedido === null)
    const pedidos = [...new Set(doGrupo.flatMap((a) => (a.idPedido === null ? [] : [a.idPedido])))]
    const pedido = escolha.soLivres === true ? undefined : (escolha.idPedido ?? (pedidos.length === 1 ? pedidos[0] : undefined))
    const escolhidos = [...livres, ...doGrupo.filter((a) => a.idPedido !== null && a.idPedido === pedido)].slice(0, qtd)

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
}))

function criarAnimais(idParto: number, idCaixa: number, m: number, f: number, dtMovimento: Date | null = null) {
  const sexos = [...Array<'M'>(m).fill('M'), ...Array<'F'>(f).fill('F')]
  return sexos.map((sexo) => {
    const animal = {
      id: banco.proximoId++,
      idParto,
      sexo,
      idCaixa,
      situacao: 'vivo',
      dtSaida: null,
      dtMovimento,
      idPedido: null,
    }
    banco.animais.push(animal)
    return animal.id
  })
}

const animaisCom = (ids: number[]) => banco.animais.filter((a) => ids.includes(a.id))

vi.mock('../colonia/ocorrencia.ts', () => ({
  lancarOcorrencia: async (_tx: unknown, l: Lancamento) => {
    let ids: number[] = []

    if (l.tipo === 'nascimento') ids = criarAnimais(l.idParto, l.idCaixa, l.nascidos.m, l.nascidos.f)

    if (l.tipo === 'baixa') {
      ids = l.ids
      for (const a of animaisCom(ids)) Object.assign(a, { situacao: 'morto', dtSaida: d(l.dtFato) })
    }

    if (l.tipo === 'correcao') {
      const trocados = l.trocaDeSexo?.ids ?? []
      for (const a of animaisCom(trocados)) a.sexo = l.trocaDeSexo?.para ?? a.sexo
      for (const a of animaisCom(l.anulados ?? [])) a.situacao = 'anulado'
      for (const a of animaisCom(l.novaSaida?.ids ?? [])) a.dtSaida = d(l.novaSaida?.dtSaida ?? '')
      const novos =
        l.novos === undefined
          ? []
          : criarAnimais(l.idParto, l.novos.idCaixa, l.novos.m, l.novos.f, l.novos.chegam ? d(l.dtFato) : null)
      ids = [...trocados, ...(l.anulados ?? []), ...(l.novaSaida?.ids ?? []), ...novos]
    }

    const ocorrencia = {
      id: banco.proximoId++,
      tipo: l.tipo,
      dtFato: d(l.dtFato),
      idParto: 'idParto' in l ? (l.idParto ?? null) : null,
      motivo: l.motivo ?? null,
      ids,
      anulada: false,
      idCaixaDestino: l.tipo === 'correcao' ? (l.novos?.idCaixa ?? null) : null,
    }
    banco.ocorrencias.push(ocorrencia)
    return { idOcorrencia: ocorrencia.id, ids }
  },
}))

vi.mock('../colonia/liberacao.ts', async (original) => ({
  ...(await original<typeof import('../colonia/liberacao.ts')>()),
  liberarSeVazia: async (_tx: unknown, idCaixa: number, dtFato: string, motivo: string) => {
    const caixa = banco.caixas.get(idCaixa) as Caixa
    const casais = [...banco.casais.values()].filter((c) => c.idCaixa === idCaixa)
    const pendente = [...banco.partos.values()].some(
      (p) => casais.some((c) => c.id === p.idCasal) && p.dtPartoReal === null && p.dtSemNinhada === null,
    )
    const vivo = banco.animais.some((a) => a.idCaixa === idCaixa && a.situacao === 'vivo')

    if (!caixa.ativa || vivo || (caixa.tipo === 'casal' && (casais.some((c) => c.ativo) || pendente))) return false

    caixa.ativa = false
    banco.liberadas.push({ idCaixa, dtFato, motivo })
    return true
  },
}))

// ------------------------------------------------------------------ o cenario

/** A caixa F1A com o casal AB (formado em 01/09) e o 1o parto acasalado no mesmo dia */
function cenario() {
  banco.caixas = new Map([
    [1, { id: 1, codigo: 'F1A', ativa: true, tipo: 'casal', idEspecie: 1 }],
    [6, { id: 6, codigo: 'F2C', ativa: true, tipo: 'estoque', idEspecie: 1, sexo: 'M', idLinhagem: 3 }],
    [7, { id: 7, codigo: 'F3C', ativa: true, tipo: 'estoque', idEspecie: 1, sexo: 'F', idLinhagem: 3 }],
  ])
  banco.casais = new Map([
    [1, { id: 1, idCaixa: 1, idLinhagem: 3, identificacao: 'AB', ativo: true, dtFormacao: d('2026-09-01'), dtEncerramento: null }],
  ])
  banco.partos = new Map()
  banco.animais = []
  banco.ocorrencias = []
  banco.historicos = []
  banco.liberadas = []
  banco.linhagem = { id: 3, idEspecie: 1, nome: 'Wistar', ativa: true }
  banco.parValido = true
  banco.proximoId = 1000
  banco.primeiraChegada = new Map([
    [6, d('2026-09-01')],
    [7, d('2026-09-01')],
  ])
  parto({ id: 1, ordem: 1, dtAcasalamento: d('2026-09-01') })
}

function parto(campos: Partial<Parto> & Pick<Parto, 'id' | 'ordem' | 'dtAcasalamento'>) {
  banco.partos.set(campos.id, {
    idCasal: 1,
    dtPartoReal: null,
    dtDesmameReal: null,
    dtSemNinhada: null,
    motivoSemNinhada: null,
    ...campos,
  })
}

/** O 1o parto nascido em 24/09, com a ninhada na caixa do casal */
function nascido(m = 5, f = 5) {
  Object.assign(banco.partos.get(1) as Parto, { dtPartoReal: d('2026-09-24') })
  return criarAnimais(1, 1, m, f)
}

/** A baixa de 'qtd' machos vivos do 1o parto na caixa do casal, como a baixa da caixa lanca */
function morteNaCaixa(qtd: number, dtFato: string) {
  const mortos = doParto(1).filter((a) => a.sexo === 'M' && a.idCaixa === 1).slice(0, qtd)
  for (const a of mortos) Object.assign(a, { situacao: 'morto', dtSaida: d(dtFato) })
  const ids = mortos.map((a) => a.id)
  banco.ocorrencias.push({ id: banco.proximoId++, tipo: 'baixa', dtFato: d(dtFato), idParto: null, motivo: 'morte', ids, anulada: false })
  return ids
}

/** Um animal a mais do 1o parto que chegou na caixa de estoque, com a ocorrencia que a correcao grava */
function chegaAMais(idCaixa: number, dtFato: string) {
  const ids = criarAnimais(1, idCaixa, 1, 0, d(dtFato))
  banco.ocorrencias.push({ id: banco.proximoId++, tipo: 'correcao', dtFato: d(dtFato), idParto: 1, motivo: 'a mais', ids, anulada: false, idCaixaDestino: idCaixa })
  return ids
}

const doParto = (idParto: number, situacao = 'vivo') =>
  banco.animais.filter((a) => a.idParto === idParto && a.situacao === situacao)
const contar = (animais: Animal[]) => ({
  m: animais.filter((a) => a.sexo === 'M').length,
  f: animais.filter((a) => a.sexo === 'F').length,
})
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })
const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })

beforeEach(cenario)

// ------------------------------------------------------------------ casal

describe('formar casal', () => {
  const novo = { idLinhagem: 3, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: '2026-11-01' }

  it('numa posicao vazia nasce a caixa de casal, sem codigo (o trigger escreve), e o 1o parto acasalado na formacao', async () => {
    const { idCaixa } = await formarCasal({ ...novo, posicao: { idEstante: 1, face: 'frontal', linha: 2, coluna: 1 } }, 4)

    expect(banco.caixas.get(idCaixa)).toMatchObject({ tipo: 'casal', codigo: '', idEspecie: 1 })
    const casal = [...banco.casais.values()].find((c) => c.idCaixa === idCaixa) as Casal
    const [primeiro] = [...banco.partos.values()].filter((p) => p.idCasal === casal.id)
    expect(primeiro).toMatchObject({ ordem: 1, dtAcasalamento: d('2026-11-01') })
    expect(primeiro).not.toHaveProperty('dtPartoPrevisto')
  })

  it('caixa de estoque nao recebe casal', async () => {
    await expect(formarCasal({ ...novo, idCaixa: 6 }, 4)).rejects.toEqual(recusa(409, 'CAIXA_DE_ESTOQUE'))
  })

  it('caixa liberada nao recebe casal: a posicao recebe caixa nova', async () => {
    Object.assign(banco.caixas.get(1) as Caixa, { ativa: false })

    await expect(formarCasal({ ...novo, idCaixa: 1 }, 4)).rejects.toEqual(recusa(409, 'CAIXA_LIBERADA'))
  })

  it('caixa com casal ativo recusa', async () => {
    await expect(formarCasal({ ...novo, idCaixa: 1 }, 4)).rejects.toEqual(recusa(409, 'CAIXA_JA_TEM_CASAL_ATIVO'))
  })

  it('caixa com parto pendente do casal encerrado recusa: a femea ainda pode parir', async () => {
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-09-10') })

    await expect(formarCasal({ ...novo, idCaixa: 1 }, 4)).rejects.toEqual(
      expect.objectContaining({ codigo: 'CAIXA_COM_ANIMAIS', message: expect.stringContaining('pendente') }),
    )
  })

  it('caixa com vivos da ninhada de antes recusa, contando os animais', async () => {
    nascido(3, 2)
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-10-20') })

    await expect(formarCasal({ ...novo, idCaixa: 1 }, 4)).rejects.toEqual(
      expect.objectContaining({ codigo: 'CAIXA_COM_ANIMAIS', message: expect.stringContaining('a ninhada desmamada do 1º parto do casal AB (3 machos e 2 fêmeas)') }),
    )
  })

  it('linhagem inativa nao forma casal novo', async () => {
    banco.linhagem = { ...banco.linhagem, ativa: false }

    await expect(formarCasal({ ...novo, idCaixa: 1 }, 4)).rejects.toEqual(noCampo('idLinhagem', 'inativa'))
  })
})

/** O parto de ordem 'ordem' do casal 1, se existir */
const partoDeOrdem = (ordem: number) => [...banco.partos.values()].find((p) => p.idCasal === 1 && p.ordem === ordem)

describe('acasalamento automatico', () => {
  it('o nascimento abre o parto seguinte 6 dias depois, como acao do sistema', async () => {
    const ciclo = await registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 5, nascidoF: 5 }, 4)

    expect(partoDeOrdem(2)).toMatchObject({ dtAcasalamento: d('2026-09-30'), dtPartoReal: null })
    expect(banco.historicos.at(-1)).toEqual({
      idUsuario: null,
      dtHora: expect.any(Date),
      entidade: 'parto',
      idEntidade: partoDeOrdem(2)?.id,
      acao: 'acasalamento',
      descricao: 'Acasalamento do 2º parto do casal AB em 30/09/2026, aberto automaticamente 6 dias depois do 1º parto',
      dados: { dtAcasalamento: '2026-09-30', automatico: true },
    })
    // a ficha que volta e a do parto que nasceu
    expect(ciclo).toMatchObject({ ordem: 1, dtPartoReal: '2026-09-24' })
  })

  it('o parto seguinte que ja existe nao se abre de novo', async () => {
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-28') })

    await registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 1, nascidoF: 1 }, 4)

    expect([...banco.partos.values()].filter((p) => p.ordem === 2)).toEqual([expect.objectContaining({ id: 2, dtAcasalamento: d('2026-09-28') })])
  })

  it('o 5o parto nao abre o 6o: o casal encerra', async () => {
    banco.partos.delete(1)
    parto({ id: 5, ordem: 5, dtAcasalamento: d('2026-09-01') })

    await registrarNascimento(5, { dtPartoReal: '2026-09-24', nascidoM: 3, nascidoF: 3 }, 4)

    expect(partoDeOrdem(6)).toBeUndefined()
    expect(banco.historicos.some((h) => h.acao === 'acasalamento')).toBe(false)
  })

  it('o casal encerrado nao acasala de novo: o parto pendente nasce e nada abre', async () => {
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-09-10') })

    await registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 4, nascidoF: 4 }, 4)

    expect(partoDeOrdem(2)).toBeUndefined()
  })

  it('o encerramento antes do acasalamento que o sistema abriu o desfaz, e a data passa a contar do de antes', async () => {
    nascido()
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })

    await encerrarCasal(1, { dtEncerramento: '2026-09-27', motivo: 'macho morreu' }, 4)

    expect(partoDeOrdem(2)).toBeUndefined()
    expect(banco.casais.get(1)).toMatchObject({ ativo: false, dtEncerramento: d('2026-09-27') })
    expect(banco.historicos.find((h) => h.acao === 'acasalamento_desfeito')).toMatchObject({
      idUsuario: 4,
      entidade: 'parto',
      idEntidade: 2,
      descricao: 'Acasalamento do 2º parto do casal AB em 30/09/2026 desfeito: o casal foi encerrado antes, em 27/09/2026',
    })
    // a ninhada do 1o parto continua na caixa: ela nao libera
    expect(banco.liberadas).toEqual([])
  })

  it('encerrado no dia do acasalamento ou depois, o parto pendente fica: a femea pode estar prenhe', async () => {
    nascido()
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })

    await encerrarCasal(1, { dtEncerramento: '2026-09-30', motivo: 'idade' }, 4)

    expect(partoDeOrdem(2)).toMatchObject({ id: 2, dtAcasalamento: d('2026-09-30') })
  })

  it('o encerramento desfeito nao volta antes do acasalamento do parto de antes', async () => {
    banco.partos.delete(1)
    parto({ id: 1, ordem: 1, dtAcasalamento: d('2026-09-01'), dtPartoReal: d('2026-09-24') })
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30'), dtPartoReal: d('2026-10-23') })
    parto({ id: 3, ordem: 3, dtAcasalamento: d('2026-10-29') })

    await expect(encerrarCasal(1, { dtEncerramento: '2026-09-29', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtEncerramento', 'Não pode ser antes do acasalamento do 2º parto (30/09/2026).'),
    )
    expect(partoDeOrdem(3)).toBeDefined()
  })
})

// ------------------------------------------------------------------ nascimento

describe('nascimento', () => {
  it('cria um animal vivo por filhote na caixa do casal, com a ocorrencia e o autor', async () => {
    const ciclo = await registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 5, nascidoF: 6 }, 4)

    expect(contar(doParto(1))).toEqual({ m: 5, f: 6 })
    expect(doParto(1).every((a) => a.idCaixa === 1)).toBe(true)
    expect(banco.ocorrencias).toEqual([expect.objectContaining({ tipo: 'nascimento', dtFato: d('2026-09-24') })])
    expect(banco.partos.get(1)).toMatchObject({ dtPartoReal: d('2026-09-24'), idUsuarioParto: 4 })
    expect(ciclo).toMatchObject({ nascidoM: 5, nascidoF: 6, vivos: { m: 5, f: 6 } })
  })

  it('a ninhada de antes ainda mamando na caixa barra o parto seguinte', async () => {
    nascido(3, 2)
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })

    await expect(
      registrarNascimento(2, { dtPartoReal: '2026-10-23', nascidoM: 5, nascidoF: 5 }, 4),
    ).rejects.toEqual(expect.objectContaining({ codigo: 'CAIXA_COM_ANIMAIS', message: expect.stringContaining('ainda está em aleitamento') }))
    expect(doParto(2)).toEqual([])
  })

  it('com a ninhada de antes fora da caixa (morta ou mudada), o parto seguinte registra', async () => {
    const ids = nascido(1, 0)
    for (const a of animaisCom(ids)) a.idCaixa = 6
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })

    await registrarNascimento(2, { dtPartoReal: '2026-10-23', nascidoM: 2, nascidoF: 2 }, 4)

    expect(contar(doParto(2))).toEqual({ m: 2, f: 2 })
  })

  it('o parto pendente de casal encerrado nasce: a femea pare o que carrega', async () => {
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-09-10') })

    await registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 4, nascidoF: 4 }, 4)

    expect(doParto(1)).toHaveLength(8)
    expect(banco.liberadas).toEqual([])
  })

  it('o 5o parto encerra o casal na data do parto e a caixa fica com a ninhada', async () => {
    banco.partos.delete(1)
    parto({ id: 5, ordem: 5, dtAcasalamento: d('2026-09-01') })

    await registrarNascimento(5, { dtPartoReal: '2026-09-24', nascidoM: 3, nascidoF: 3 }, 4)

    expect(banco.casais.get(1)).toMatchObject({ ativo: false, dtEncerramento: d('2026-09-24') })
    expect(banco.caixas.get(1)?.ativa).toBe(true)
    expect(banco.historicos.at(-1)).toMatchObject({ acao: 'encerramento', dados: expect.objectContaining({ automatico: true }) })
  })

  it('nao pode ser antes do acasalamento', async () => {
    await expect(
      registrarNascimento(1, { dtPartoReal: '2026-08-31', nascidoM: 5, nascidoF: 5 }, 4),
    ).rejects.toEqual(noCampo('dtPartoReal', 'Não pode ser antes do acasalamento (01/09/2026).'))
  })

  it('parto ja nascido ou fechado sem ninhada nao nasce de novo', async () => {
    nascido()
    await expect(
      registrarNascimento(1, { dtPartoReal: '2026-09-24', nascidoM: 5, nascidoF: 5 }, 4),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))

    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30'), dtSemNinhada: d('2026-10-30'), motivoSemNinhada: 'x' })
    await expect(
      registrarNascimento(2, { dtPartoReal: '2026-10-23', nascidoM: 5, nascidoF: 5 }, 4),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })
})

// ------------------------------------------------------------------ selecao

describe('selecao (baixa restrita ao parto, antes do desmame)', () => {
  it('em duas rodadas: cada uma e uma baixa com a sua data, e a ficha soma as duas', async () => {
    nascido()

    await registrarSelecao(1, { dtSelecao: '2026-09-26', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    const { parto: ciclo } = await registrarSelecao(1, { dtSelecao: '2026-09-29', eutanasiadoM: 1, eutanasiadoF: 1 }, 4)

    const baixas = banco.ocorrencias.filter((o) => o.tipo === 'baixa')
    expect(baixas.map((o) => [iso(o.dtFato), o.ids.length, o.motivo])).toEqual([
      ['2026-09-26', 1, 'eutanasia de selecao'],
      ['2026-09-29', 2, 'eutanasia de selecao'],
    ])
    expect(contar(doParto(1))).toEqual({ m: 3, f: 4 })
    expect(ciclo).toMatchObject({ baixasAntesDoDesmame: { m: 2, f: 1 }, nascidoM: 5, nascidoF: 5 })
  })

  it('nao passa dos vivos do parto na caixa do casal, campo a campo', async () => {
    nascido(2, 5)

    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-26', eutanasiadoM: 3, eutanasiadoF: 1 }, 4),
    ).rejects.toEqual(noCampo('eutanasiadoM', 'na caixa do casal (2 machos e 5 fêmeas).'))
    expect(banco.ocorrencias).toEqual([])
  })

  it('depois do desmame nao e selecao: e baixa na caixa', async () => {
    nascido()
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })

    await expect(
      registrarSelecao(1, { dtSelecao: '2026-10-17', eutanasiadoM: 1, eutanasiadoF: 0 }, 4),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('nao pode ser antes do parto, nem antes de o parto nascer', async () => {
    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-26', eutanasiadoM: 1, eutanasiadoF: 0 }, 4),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))

    nascido()
    await expect(
      registrarSelecao(1, { dtSelecao: '2026-09-23', eutanasiadoM: 1, eutanasiadoF: 0 }, 4),
    ).rejects.toEqual(noCampo('dtSelecao', 'do parto'))
  })

  it('livres primeiro; o reservado so sai quando os livres acabam, e o pedido fica em falta', async () => {
    const [primeiro, segundo] = nascido(2, 0)
    for (const a of animaisCom([primeiro as number])) a.idPedido = 7

    const { faltas } = await registrarSelecao(1, { dtSelecao: '2026-09-26', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    expect(banco.ocorrencias.at(-1)?.ids).toEqual([segundo])
    expect(faltas).toEqual([])

    const depois = await registrarSelecao(1, { dtSelecao: '2026-09-27', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    expect(depois.faltas).toEqual([{ idPedido: 7, m: 0, f: 0, qualquer: 1 }])
  })

  it('a selecao que esvazia a caixa do casal encerrado sem parto pendente libera a caixa', async () => {
    nascido(1, 0)
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-09-10') })

    await registrarSelecao(1, { dtSelecao: '2026-09-26', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)

    expect(banco.liberadas).toEqual([{ idCaixa: 1, dtFato: '2026-09-26', motivo: 'baixa' }])
  })
})

// ------------------------------------------------------------------ desmame

describe('desmame', () => {
  it('com menos animais que os vivos, a diferenca vira baixa "nao chegou ao desmame" na data dele', async () => {
    nascido(5, 5)

    const { parto: ciclo } = await registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 4, desmamadoF: 3 }, 4)

    const baixa = banco.ocorrencias.find((o) => o.tipo === 'baixa')
    expect(baixa).toMatchObject({ dtFato: d('2026-10-16'), motivo: 'nao chegou ao desmame', idParto: 1 })
    expect(contar(animaisCom(baixa?.ids ?? []))).toEqual({ m: 1, f: 2 })
    expect(contar(doParto(1))).toEqual({ m: 4, f: 3 })
    expect(ciclo).toMatchObject({ dtDesmameReal: '2026-10-16', desmamadoM: 4, desmamadoF: 3 })
    expect(banco.historicos.at(-1)).toMatchObject({
      acao: 'desmame',
      descricao: 'Desmame do 1º parto em 16/10/2026: 4 machos e 3 fêmeas',
    })
  })

  it('com a contagem igual aos vivos, nenhuma baixa', async () => {
    nascido(2, 2)

    await registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 2, desmamadoF: 2 }, 4)

    expect(banco.ocorrencias).toEqual([])
  })

  it('acima dos vivos e recusado: o que falta e corrigir o nascimento', async () => {
    nascido(2, 2)

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 3, desmamadoF: 2 }, 4),
    ).rejects.toEqual(noCampo('desmamadoM', 'corrija o parto'))
    expect(banco.partos.get(1)?.dtDesmameReal).toBeNull()
  })

  it('nao pode ser antes da ultima eutanasia de selecao', async () => {
    nascido(3, 3)
    await registrarSelecao(1, { dtSelecao: '2026-10-01', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-09-30', desmamadoM: 2, desmamadoF: 3 }, 4),
    ).rejects.toEqual(noCampo('dtDesmameReal', 'última eutanásia de seleção'))
  })

  it('registrado depois de uma morte na caixa com data posterior: o morto chegou ao desmame e conta nele', async () => {
    nascido(3, 3)
    morteNaCaixa(1, '2026-10-23')

    const { parto: ciclo } = await registrarDesmame(1, { dtDesmameReal: '2026-10-21', desmamadoM: 3, desmamadoF: 3 }, 4)

    expect(banco.ocorrencias.filter((o) => o.motivo === 'nao chegou ao desmame')).toEqual([])
    expect(ciclo).toMatchObject({ desmamadoM: 3, desmamadoF: 3, baixasAntesDoDesmame: { m: 0, f: 0 } })
  })

  it('a diferenca sai dos vivos de agora, e o morto depois da data continua desmamado', async () => {
    nascido(3, 3)
    const [morto] = morteNaCaixa(1, '2026-10-23')

    const { parto: ciclo } = await registrarDesmame(1, { dtDesmameReal: '2026-10-21', desmamadoM: 2, desmamadoF: 3 }, 4)

    const baixa = banco.ocorrencias.find((o) => o.motivo === 'nao chegou ao desmame')
    expect(baixa?.ids).toHaveLength(1)
    expect(baixa?.ids).not.toContain(morto)
    expect(ciclo).toMatchObject({ desmamadoM: 2, desmamadoF: 3 })
  })

  it('o desmamado nao fica abaixo dos que morreram depois da data', async () => {
    nascido(3, 3)
    morteNaCaixa(1, '2026-10-23')

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-21', desmamadoM: 0, desmamadoF: 3 }, 4),
    ).rejects.toEqual(noCampo('desmamadoM', 'Quem morreu depois desta data chegou ao desmame e conta nele: 1 macho deste parto.'))
    expect(banco.partos.get(1)?.dtDesmameReal).toBeNull()
  })

  it('a morte antes da data nao chegou ao desmame: a contagem nao passa dos que sobraram', async () => {
    nascido(3, 3)
    morteNaCaixa(1, '2026-10-10')

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-21', desmamadoM: 3, desmamadoF: 3 }, 4),
    ).rejects.toEqual(noCampo('desmamadoM', 'no dia do desmame (2 machos e 3 fêmeas).'))
  })

  it('desmame ja registrado se corrige, nao se registra de novo', async () => {
    nascido()
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })

    await expect(
      registrarDesmame(1, { dtDesmameReal: '2026-10-17', desmamadoM: 5, desmamadoF: 5 }, 4),
    ).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })
})

// ------------------------------------------------------------------ encerramento e sem ninhada

describe('encerramento e parto sem ninhada', () => {
  it('casal encerrado sem vivo e sem parto pendente libera a caixa na data do encerramento', async () => {
    nascido(1, 0)
    for (const a of doParto(1)) a.idCaixa = 6

    await encerrarCasal(1, { dtEncerramento: '2026-10-30', motivo: 'idade' }, 4)

    expect(banco.casais.get(1)).toMatchObject({ ativo: false, dtEncerramento: d('2026-10-30') })
    expect(banco.liberadas).toEqual([{ idCaixa: 1, dtFato: '2026-10-30', motivo: 'casal_encerrado' }])
  })

  it('com parto pendente a caixa espera; fechado sem ninhada, ela libera', async () => {
    nascido(0, 0)
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })

    await encerrarCasal(1, { dtEncerramento: '2026-10-02', motivo: 'macho morreu' }, 4)
    expect(banco.liberadas).toEqual([])

    const ciclo = await fecharSemNinhada(2, { dtSemNinhada: '2026-10-30', motivo: 'não pariu' }, 4)

    expect(ciclo).toMatchObject({ dtSemNinhada: '2026-10-30', motivoSemNinhada: 'não pariu' })
    expect(banco.liberadas).toEqual([{ idCaixa: 1, dtFato: '2026-10-30', motivo: 'casal_encerrado' }])
  })

  it('o encerramento nao vem antes do ultimo acasalamento', async () => {
    await expect(encerrarCasal(1, { dtEncerramento: '2026-08-31', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtEncerramento', 'formação'),
    )
  })

  it('sem ninhada so para casal encerrado, e nao antes do encerramento', async () => {
    await expect(fecharSemNinhada(1, { dtSemNinhada: '2026-10-30', motivo: 'x' }, 4)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )

    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-09-20') })
    await expect(fecharSemNinhada(1, { dtSemNinhada: '2026-09-19', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtSemNinhada', 'encerramento do casal'),
    )
  })

  it('parto nascido nao fecha sem ninhada', async () => {
    nascido()
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-09-20') })

    await expect(fecharSemNinhada(1, { dtSemNinhada: '2026-10-30', motivo: 'x' }, 4)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
  })
})

// ------------------------------------------------------------------ correcoes

describe('correcao do acasalamento', () => {
  it('muda a data com motivo, guardando antes e depois no historico', async () => {
    const ciclo = await corrigirAcasalamento(1, { dtAcasalamento: '2026-09-05', motivo: 'nova monta' }, 4)

    expect(ciclo).toMatchObject({ dtAcasalamento: '2026-09-05', dtPartoPrevisto: '2026-09-28' })
    expect(banco.historicos.at(-1)).toMatchObject({
      acao: 'correcao_acasalamento',
      // a ficha mostra o evento pela descricao: ela diz o que mudou
      descricao: 'Correção do acasalamento do 1º parto (de 01/09/2026 para 05/09/2026): nova monta',
      dados: { motivo: 'nova monta', antes: { dtAcasalamento: '2026-09-01' }, depois: { dtAcasalamento: '2026-09-05' } },
    })
  })

  it('sem motivo, a data editada passa a valer, e o historico diz de qual para qual', async () => {
    const ciclo = await corrigirAcasalamento(1, { dtAcasalamento: '2026-09-03' }, 4)

    expect(ciclo).toMatchObject({ dtAcasalamento: '2026-09-03', dtPartoPrevisto: '2026-09-26' })
    expect(banco.historicos.at(-1)).toEqual({
      idUsuario: 4,
      dtHora: expect.any(Date),
      entidade: 'parto',
      idEntidade: 1,
      acao: 'correcao_acasalamento',
      descricao: 'Correção do acasalamento do 1º parto (de 01/09/2026 para 03/09/2026)',
      dados: { antes: { dtAcasalamento: '2026-09-01' }, depois: { dtAcasalamento: '2026-09-03' } },
    })
  })

  it('a mesma data nao grava nada', async () => {
    await corrigirAcasalamento(1, { dtAcasalamento: '2026-09-01' }, 4)

    expect(banco.historicos.some((h) => h.acao === 'correcao_acasalamento')).toBe(false)
  })

  it('fica entre a formacao e o parto', async () => {
    await expect(corrigirAcasalamento(1, { dtAcasalamento: '2026-08-31', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtAcasalamento', 'formação'),
    )

    nascido()
    await expect(corrigirAcasalamento(1, { dtAcasalamento: '2026-09-25', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtAcasalamento', 'depois do parto'),
    )
  })
})

describe('correcao do nascimento', () => {
  const correcao = (campos: Partial<Parameters<typeof corrigirNascimento>[1]> = {}) => ({
    dtPartoReal: '2026-09-24',
    nascidoM: 5,
    nascidoF: 5,
    motivo: 'contagem errada',
    ...campos,
  })

  it('a dtPrimeiroFato da ficha e o limite da correcao da data: no dia passa, no dia seguinte recusa', async () => {
    nascido()
    morteNaCaixa(1, '2026-09-28')

    const { dtPrimeiroFato } = await cicloFicha(1)
    expect(dtPrimeiroFato).toBe('2026-09-28')

    await expect(corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-29' }), 4)).rejects.toEqual(
      noCampo('dtPartoReal', 'primeira baixa dos animais deste parto'),
    )
    await corrigirNascimento(1, correcao({ dtPartoReal: dtPrimeiroFato ?? '' }), 4)
    expect(iso(banco.partos.get(1)?.dtPartoReal ?? null)).toBe('2026-09-28')
  })

  it('a data muda no parto e na ocorrencia do nascimento, e com ela a idade de todos', async () => {
    nascido()
    banco.ocorrencias.push({ id: 1, tipo: 'nascimento', dtFato: d('2026-09-24'), idParto: 1, motivo: null, ids: [], anulada: false })

    await corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-22' }), 4)

    expect(banco.partos.get(1)?.dtPartoReal).toEqual(d('2026-09-22'))
    expect(banco.ocorrencias[0]?.dtFato).toEqual(d('2026-09-22'))
    expect(banco.ocorrencias).toHaveLength(1)
    expect(banco.historicos.at(-1)).toMatchObject({
      acao: 'correcao_nascimento',
      descricao: 'Correção do 1º parto (nascimento de 24/09/2026 para 22/09/2026): contagem errada',
      dados: expect.objectContaining({ antes: expect.objectContaining({ dtPartoReal: '2026-09-24' }) }),
    })
  })

  it('a data nao passa do primeiro fato dos animais (baixa, mudanca ou entrega)', async () => {
    nascido()
    await registrarSelecao(1, { dtSelecao: '2026-09-25', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)

    await expect(corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-26' }), 4)).rejects.toEqual(
      noCampo('dtPartoReal', 'primeira baixa'),
    )
  })

  it('a baixa anulada nao conta: o animal nao morreu', async () => {
    nascido()
    await registrarSelecao(1, { dtSelecao: '2026-09-25', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    for (const o of banco.ocorrencias) o.anulada = true

    await corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-26' }), 4)

    expect(banco.partos.get(1)?.dtPartoReal).toEqual(d('2026-09-26'))
  })

  it('nem passa do desmame ou do acasalamento seguinte corrigido a mao, que fica onde esta', async () => {
    nascido()
    // 29/09 nao e 24/09 + 6: alguem corrigiu o acasalamento que o sistema abriu
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-29') })

    await expect(corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-30' }), 4)).rejects.toEqual(
      noCampo('dtPartoReal', 'acasalamento do 2º parto'),
    )

    await corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-26' }), 4)
    expect(banco.partos.get(2)?.dtAcasalamento).toEqual(d('2026-09-29'))
    expect(banco.historicos.some((h) => h.acao === 'correcao_acasalamento')).toBe(false)
  })

  it('o acasalamento que o sistema abriu, editado a mao, nao acompanha mais a correcao do nascimento', async () => {
    nascido()
    // o sistema abriu o 2o parto 6 dias depois do 1o, em 30/09; alguem pos 28/09
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })
    await corrigirAcasalamento(2, { dtAcasalamento: '2026-09-28' }, 4)

    await corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-26' }), 4)

    expect(banco.partos.get(1)?.dtPartoReal).toEqual(d('2026-09-26'))
    expect(banco.partos.get(2)?.dtAcasalamento).toEqual(d('2026-09-28'))
  })

  it('o acasalamento que o sistema abriu acompanha a data nova, e o historico diz', async () => {
    nascido()
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })

    // depois do acasalamento de antes tambem pode: ele vai junto
    await corrigirNascimento(1, correcao({ dtPartoReal: '2026-10-01' }), 4)

    expect(banco.partos.get(1)?.dtPartoReal).toEqual(d('2026-10-01'))
    expect(banco.partos.get(2)?.dtAcasalamento).toEqual(d('2026-10-07'))
    expect(banco.historicos.find((h) => h.acao === 'correcao_acasalamento')).toEqual({
      idUsuario: 4,
      dtHora: expect.any(Date),
      entidade: 'parto',
      idEntidade: 2,
      acao: 'correcao_acasalamento',
      descricao: 'Correção do acasalamento do 2º parto (de 30/09/2026 para 07/10/2026): acompanha a correção do 1º parto',
      dados: {
        motivo: 'contagem errada',
        antes: { dtAcasalamento: '2026-09-30' },
        depois: { dtAcasalamento: '2026-10-07' },
        automatico: true,
      },
    })
  })

  it('o parto seguinte que ja nasceu nao acompanha', async () => {
    nascido()
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30'), dtPartoReal: d('2026-10-23') })

    await corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-22' }), 4)

    expect(banco.partos.get(2)?.dtAcasalamento).toEqual(d('2026-09-30'))
  })

  it('o acasalamento que acompanha nao passa do encerramento do casal', async () => {
    nascido()
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-09-30') })
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-10-03') })

    await expect(corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-28' }), 4)).rejects.toEqual(
      noCampo('dtPartoReal', 'passaria do encerramento do casal (03/10/2026)'),
    )
    expect(banco.partos.get(2)?.dtAcasalamento).toEqual(d('2026-09-30'))

    await corrigirNascimento(1, correcao({ dtPartoReal: '2026-09-27' }), 4)
    expect(banco.partos.get(2)?.dtAcasalamento).toEqual(d('2026-10-03'))
  })

  it('macho registrado como femea: troca o sexo de um vivo livre na caixa do casal', async () => {
    nascido(5, 5)

    await corrigirNascimento(1, correcao({ nascidoM: 6, nascidoF: 4 }), 4)

    expect(contar(doParto(1))).toEqual({ m: 6, f: 4 })
    expect(banco.animais).toHaveLength(10)
    expect(banco.ocorrencias.at(-1)).toMatchObject({ tipo: 'correcao', motivo: 'contagem errada' })
  })

  it('a troca de sexo nao mexe em reservado: recusa com o porque', async () => {
    nascido(5, 1)
    for (const a of doParto(1)) if (a.sexo === 'F') a.idPedido = 7

    await expect(corrigirNascimento(1, correcao({ nascidoM: 6, nascidoF: 0 }), 4)).rejects.toEqual(
      expect.objectContaining({
        codigo: 'SEQUENCIA_INVALIDA',
        message: expect.stringContaining('Só troca de sexo o animal vivo, livre e na caixa do casal (nunca numa caixa de estoque): a correção troca 1 fêmea, e só há 0 assim.'),
      }),
    )
  })

  it('animais a mais entram na caixa do casal', async () => {
    nascido(5, 5)

    await corrigirNascimento(1, correcao({ nascidoM: 6, nascidoF: 7 }), 4)

    expect(contar(doParto(1))).toEqual({ m: 6, f: 7 })
    expect(doParto(1).every((a) => a.idCaixa === 1)).toBe(true)
  })

  it('com a ninhada de outro parto na caixa do casal, os a mais pedem a caixa de estoque: duas ninhadas nao dividem a caixa', async () => {
    const ids = nascido(2, 0)
    for (const a of animaisCom(ids)) Object.assign(a, { idCaixa: 6, dtMovimento: d('2026-10-16') })
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    parto({ id: 2, ordem: 2, dtAcasalamento: d('2026-10-01'), dtPartoReal: d('2026-10-22') })
    criarAnimais(2, 1, 3, 3)

    await expect(corrigirNascimento(1, correcao({ nascidoM: 3, nascidoF: 0 }), 4)).rejects.toEqual(
      noCampo('idCaixa', 'ninhada do 2º parto'),
    )
    expect(banco.animais.filter((a) => a.idParto === 1)).toHaveLength(2)

    await corrigirNascimento(1, correcao({ nascidoM: 3, nascidoF: 0, idCaixa: 6 }), 4)

    expect(banco.animais.at(-1)).toMatchObject({ idParto: 1, idCaixa: 6, dtMovimento: d('2026-10-16'), sexo: 'M' })
  })

  it('na caixa do casal que virou estoque, os a mais do sexo dela ficam onde nasceram, e o sexo nao se troca', async () => {
    nascido(2, 0)
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-10-20') })
    Object.assign(banco.caixas.get(1) as Caixa, { tipo: 'estoque', sexo: 'M', idLinhagem: 3 })

    await expect(corrigirNascimento(1, correcao({ nascidoM: 2, nascidoF: 1 }), 4)).rejects.toEqual(
      noCampo('idCaixa', 'outro sexo'),
    )
    await expect(corrigirNascimento(1, correcao({ nascidoM: 1, nascidoF: 1 }), 4)).rejects.toEqual(
      expect.objectContaining({ codigo: 'SEQUENCIA_INVALIDA', message: expect.stringContaining('caixa de estoque') }),
    )

    await corrigirNascimento(1, correcao({ nascidoM: 3, nascidoF: 0 }), 4)

    expect(banco.animais.at(-1)).toMatchObject({ idCaixa: 1, dtMovimento: null, sexo: 'M' })
  })

  it('com a caixa do casal liberada, os a mais pedem a caixa; na de estoque chegam com a ninhada', async () => {
    const ids = nascido(2, 0)
    for (const a of animaisCom(ids)) Object.assign(a, { idCaixa: 6, dtMovimento: d('2026-10-20') })
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    Object.assign(banco.caixas.get(1) as Caixa, { ativa: false })
    // a caixa F2C so passou a existir com a chegada da ninhada
    banco.primeiraChegada.set(6, d('2026-10-20'))

    await expect(corrigirNascimento(1, correcao({ nascidoM: 3, nascidoF: 0 }), 4)).rejects.toEqual(
      noCampo('idCaixa', 'liberada'),
    )

    await corrigirNascimento(1, correcao({ nascidoM: 3, nascidoF: 0, idCaixa: 6 }), 4)

    // chegam no dia em que a ninhada chegou, e nao no desmame, quando a caixa ainda nao existia; a
    // correcao que os poe la tem a mesma data, e nao a do nascimento (24/09), quando a caixa nao
    // existia: senao a F2C passaria a ter animais desde 24/09
    const novo = banco.animais.at(-1)
    expect(novo).toMatchObject({ idCaixa: 6, dtMovimento: d('2026-10-20'), sexo: 'M' })
    expect(banco.ocorrencias.filter((o) => o.tipo === 'correcao')).toEqual([
      expect.objectContaining({ dtFato: d('2026-10-20'), ids: [novo?.id] }),
    ])
  })

  it('troca de sexo na caixa do casal e a mais numa caixa de estoque: uma correcao em cada data', async () => {
    const ids = nascido(2, 2)
    const [vivo] = ids
    // as femeas desmamaram para a F3C; um macho morreu e o outro ficou na caixa do casal
    for (const a of animaisCom(ids)) {
      if (a.sexo === 'F') Object.assign(a, { idCaixa: 7, dtMovimento: d('2026-10-20') })
      else if (a.id !== vivo) Object.assign(a, { situacao: 'morto', dtSaida: d('2026-10-01') })
    }
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    banco.primeiraChegada.set(7, d('2026-10-20'))

    // de 2 machos e 2 femeas para 1 macho e 4 femeas: o macho vivo vira femea na caixa do casal, e mais 1 femea na F3C
    await corrigirNascimento(1, correcao({ nascidoM: 1, nascidoF: 4, idCaixa: 7 }), 4)

    const nova = banco.animais.at(-1)
    expect(nova).toMatchObject({ idCaixa: 7, dtMovimento: d('2026-10-20'), sexo: 'F' })
    expect(banco.ocorrencias.filter((o) => o.tipo === 'correcao')).toEqual([
      expect.objectContaining({ dtFato: d('2026-09-24'), ids: [vivo] }),
      expect.objectContaining({ dtFato: d('2026-10-20'), ids: [nova?.id] }),
    ])
  })

  it('sem animal da ninhada na caixa indicada, os a mais chegam no desmame, e a caixa tem de ja existir nesse dia', async () => {
    const ids = nascido(1, 1)
    for (const a of animaisCom(ids)) Object.assign(a, { idCaixa: 6, sexo: 'M', dtMovimento: d('2026-10-20') })
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    Object.assign(banco.caixas.get(1) as Caixa, { ativa: false })
    banco.primeiraChegada.set(7, d('2026-10-18'))

    await expect(corrigirNascimento(1, correcao({ nascidoM: 2, nascidoF: 1, idCaixa: 7 }), 4)).rejects.toEqual(
      expect.objectContaining({
        status: 400,
        extras: {
          campos: {
            idCaixa:
              'A caixa F3C só recebeu os primeiros animais em 18/10/2026, depois do desmame (16/10/2026), quando estes animais chegariam nela.',
          },
        },
      }),
    )
    expect(banco.animais).toHaveLength(2)

    banco.primeiraChegada.set(7, d('2026-10-10'))
    await corrigirNascimento(1, correcao({ nascidoM: 2, nascidoF: 1, idCaixa: 7 }), 4)

    expect(banco.animais.at(-1)).toMatchObject({ idCaixa: 7, dtMovimento: d('2026-10-16'), sexo: 'F' })
  })

  it('a caixa de estoque so recebe os a mais depois do desmame', async () => {
    nascido(2, 0)

    await expect(corrigirNascimento(1, correcao({ nascidoM: 3, nascidoF: 0, idCaixa: 6 }), 4)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
  })

  it('animais a menos: anula vivos, livres primeiro, e a caixa que esvazia libera', async () => {
    const [reservado] = nascido(2, 0)
    for (const a of animaisCom([reservado as number])) a.idPedido = 7

    const { faltas } = await corrigirNascimento(1, correcao({ nascidoM: 1, nascidoF: 0 }), 4)

    const anulado = banco.animais.find((a) => a.situacao === 'anulado')
    expect(anulado?.idPedido).toBeNull()
    expect(faltas).toEqual([])
  })

  it('morto e entregue continuam contando: o nascido nao fica abaixo deles', async () => {
    nascido(2, 0)
    await registrarSelecao(1, { dtSelecao: '2026-09-25', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    for (const a of doParto(1)) Object.assign(a, { situacao: 'entregue', dtSaida: d('2026-11-01') })

    await expect(corrigirNascimento(1, correcao({ nascidoM: 1, nascidoF: 0 }), 4)).rejects.toEqual(
      noCampo('nascidoM', 'o nascido não fica abaixo de 2 machos.'),
    )
  })

  it('troca de sexo e anulacao no mesmo sexo somam: passando dos vivos, a recusa sai no campo', async () => {
    nascido(5, 5)
    await registrarSelecao(1, { dtSelecao: '2026-09-25', eutanasiadoM: 0, eutanasiadoF: 3 }, 4)

    // de 5 F para 1 F: 2 trocam para macho e 2 se anulam, mas so ha 2 F vivas
    await expect(corrigirNascimento(1, correcao({ nascidoM: 7, nascidoF: 1 }), 4)).rejects.toEqual(
      noCampo('nascidoF', 'o nascido não fica abaixo de 3 fêmeas.'),
    )
    expect(banco.ocorrencias.filter((o) => o.tipo === 'correcao')).toEqual([])
  })

  it('com a ninhada no estoque, os a mais dos dois sexos entram um sexo de cada vez', async () => {
    nascido(1, 1)
    for (const a of doParto(1)) Object.assign(a, { idCaixa: a.sexo === 'M' ? 6 : 7, dtMovimento: d('2026-10-16') })
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    Object.assign(banco.caixas.get(1) as Caixa, { ativa: false })

    await expect(corrigirNascimento(1, correcao({ nascidoM: 2, nascidoF: 2, idCaixa: 6 }), 4)).rejects.toEqual(
      noCampo('idCaixa', 'um sexo de cada vez'),
    )
    await expect(corrigirNascimento(1, correcao({ nascidoM: 1, nascidoF: 2, idCaixa: 6 }), 4)).rejects.toEqual(
      noCampo('idCaixa', 'outro sexo'),
    )

    await corrigirNascimento(1, correcao({ nascidoM: 2, nascidoF: 1, idCaixa: 6 }), 4)
    await corrigirNascimento(1, correcao({ nascidoM: 2, nascidoF: 2, idCaixa: 7 }), 4)

    expect(contar(doParto(1).filter((a) => a.idCaixa === 6))).toEqual({ m: 2, f: 0 })
    expect(contar(doParto(1).filter((a) => a.idCaixa === 7))).toEqual({ m: 0, f: 2 })
  })

  it('no 5o parto, o encerramento automatico acompanha a data corrigida', async () => {
    banco.partos.delete(1)
    parto({ id: 5, ordem: 5, dtAcasalamento: d('2026-09-01'), dtPartoReal: d('2026-09-24') })
    Object.assign(banco.casais.get(1) as Casal, { ativo: false, dtEncerramento: d('2026-09-24') })

    await corrigirNascimento(5, correcao({ dtPartoReal: '2026-09-23', nascidoM: 0, nascidoF: 0 }), 4)

    expect(banco.casais.get(1)?.dtEncerramento).toEqual(d('2026-09-23'))
  })
})

describe('correcao da data do desmame', () => {
  it('a baixa "nao chegou ao desmame" acompanha a data: a ocorrencia e a saida dos animais', async () => {
    nascido(3, 3)
    await registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 2, desmamadoF: 3 }, 4)

    await corrigirDesmame(1, { dtDesmameReal: '2026-10-18', motivo: 'data errada' }, 4)

    const baixa = banco.ocorrencias.find((o) => o.tipo === 'baixa')
    expect(baixa?.dtFato).toEqual(d('2026-10-18'))
    expect(animaisCom(baixa?.ids ?? []).map((a) => iso(a.dtSaida))).toEqual(['2026-10-18'])
    expect(banco.ocorrencias.at(-1)).toMatchObject({ tipo: 'correcao', motivo: 'data errada' })
    expect(banco.partos.get(1)?.dtDesmameReal).toEqual(d('2026-10-18'))
    // a ficha mostra o evento pela descricao: ela diz o que mudou
    expect(banco.historicos.at(-1)).toMatchObject({
      acao: 'correcao_desmame',
      descricao: 'Correção do desmame do 1º parto (de 16/10/2026 para 18/10/2026): data errada',
    })
  })

  it('nunca depois da primeira mudanca ou entrega dos animais do parto', async () => {
    const ids = nascido(1, 0)
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    banco.ocorrencias.push({ id: 1, tipo: 'mudanca', dtFato: d('2026-10-17'), idParto: null, motivo: null, ids, anulada: false })

    await expect(corrigirDesmame(1, { dtDesmameReal: '2026-10-18', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtDesmameReal', 'primeira passagem para outra caixa'),
    )
  })

  it('nem antes da ultima selecao', async () => {
    nascido(3, 3)
    await registrarSelecao(1, { dtSelecao: '2026-10-01', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    await registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 2, desmamadoF: 3 }, 4)

    await expect(corrigirDesmame(1, { dtDesmameReal: '2026-09-30', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtDesmameReal', 'seleção'),
    )
  })

  it('segue os limites do registro: depois de uma morte na caixa, volta para antes dela', async () => {
    nascido(3, 3)
    morteNaCaixa(1, '2026-10-23')
    await registrarDesmame(1, { dtDesmameReal: '2026-10-23', desmamadoM: 2, desmamadoF: 3 }, 4)

    const { parto: ciclo } = await corrigirDesmame(1, { dtDesmameReal: '2026-10-21', motivo: 'data errada' }, 4)

    expect(ciclo).toMatchObject({ dtDesmameReal: '2026-10-21', desmamadoM: 3, desmamadoF: 3 })
  })

  it('nunca depois da chegada dos animais a mais na caixa de estoque', async () => {
    nascido(2, 0)
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-16') })
    chegaAMais(6, '2026-10-16')

    await expect(corrigirDesmame(1, { dtDesmameReal: '2026-10-18', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtDesmameReal', 'chegada de animais deste parto numa caixa de estoque'),
    )

    await corrigirDesmame(1, { dtDesmameReal: '2026-10-14', motivo: 'x' }, 4)
    expect(banco.partos.get(1)?.dtDesmameReal).toEqual(d('2026-10-14'))
  })

  it('a primeira chegada ao estoque vem da trilha: o a mais que chegou e mudou de novo nao perde a primeira', async () => {
    nascido(2, 0)
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-14') })
    const [novo] = chegaAMais(6, '2026-10-16')
    // muda da caixa 6 para a 7 em 20/10: a chegada gravada no animal passa a ser a da caixa 7
    Object.assign(banco.animais.find((a) => a.id === novo) as Animal, { idCaixa: 7, dtMovimento: d('2026-10-20') })
    banco.ocorrencias.push({ id: banco.proximoId++, tipo: 'mudanca', dtFato: d('2026-10-20'), idParto: null, motivo: null, ids: [novo as number], anulada: false, idCaixaDestino: 7 })

    // pela chegada gravada no animal, 18/10 passaria; pela trilha, a primeira chegada foi em 16/10
    await expect(corrigirDesmame(1, { dtDesmameReal: '2026-10-18', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtDesmameReal', 'chegada de animais deste parto numa caixa de estoque (16/10/2026)'),
    )
    expect((await cicloFicha(1)).dtPrimeiraSaida).toBe('2026-10-16')
  })

  it('o registro anulado que chegou ao estoque nao limita o desmame', async () => {
    nascido(2, 0)
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-14') })
    const [novo] = chegaAMais(6, '2026-10-16')
    Object.assign(banco.animais.find((a) => a.id === novo) as Animal, { situacao: 'anulado' })

    expect((await cicloFicha(1)).dtPrimeiraSaida).toBeNull()
    await corrigirDesmame(1, { dtDesmameReal: '2026-10-18', motivo: 'x' }, 4)
    expect(banco.partos.get(1)?.dtDesmameReal).toEqual(d('2026-10-18'))
  })

  it('a dtPrimeiraSaida da ficha e o limite da correcao: no dia passa, no dia seguinte recusa', async () => {
    const ids = nascido(2, 0)
    Object.assign(banco.partos.get(1) as Parto, { dtDesmameReal: d('2026-10-14') })
    banco.ocorrencias.push({ id: banco.proximoId++, tipo: 'mudanca', dtFato: d('2026-10-20'), idParto: null, motivo: null, ids: ids.slice(0, 1), anulada: false, idCaixaDestino: 6 })
    chegaAMais(7, '2026-10-17')

    const { dtPrimeiraSaida } = await cicloFicha(1)
    expect(dtPrimeiraSaida).toBe('2026-10-17')

    await expect(corrigirDesmame(1, { dtDesmameReal: '2026-10-18', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtDesmameReal', 'chegada de animais deste parto numa caixa de estoque'),
    )
    await corrigirDesmame(1, { dtDesmameReal: dtPrimeiraSaida ?? '', motivo: 'x' }, 4)
    expect(iso(banco.partos.get(1)?.dtDesmameReal ?? null)).toBe('2026-10-17')
  })

  it('a dtUltimaSelecao da ficha e o limite da correcao: no dia passa, na vespera recusa; a selecao anulada nao conta', async () => {
    nascido(3, 3)
    await registrarSelecao(1, { dtSelecao: '2026-10-01', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    await registrarSelecao(1, { dtSelecao: '2026-10-05', eutanasiadoM: 1, eutanasiadoF: 0 }, 4)
    await registrarDesmame(1, { dtDesmameReal: '2026-10-16', desmamadoM: 1, desmamadoF: 3 }, 4)

    const { dtUltimaSelecao } = await cicloFicha(1)
    expect(dtUltimaSelecao).toBe('2026-10-05')

    await expect(corrigirDesmame(1, { dtDesmameReal: '2026-10-04', motivo: 'x' }, 4)).rejects.toEqual(
      noCampo('dtDesmameReal', 'última eutanásia de seleção'),
    )
    await corrigirDesmame(1, { dtDesmameReal: dtUltimaSelecao ?? '', motivo: 'x' }, 4)
    expect(iso(banco.partos.get(1)?.dtDesmameReal ?? null)).toBe('2026-10-05')

    // a selecao de 05/10 anulada: a ultima passa a ser a de 01/10
    const anulada = banco.ocorrencias.find((o) => o.tipo === 'baixa' && iso(o.dtFato) === '2026-10-05') as Ocorrencia
    anulada.anulada = true
    expect((await cicloFicha(1)).dtUltimaSelecao).toBe('2026-10-01')
  })

  it('so corrige desmame registrado', async () => {
    nascido()

    await expect(corrigirDesmame(1, { dtDesmameReal: '2026-10-18', motivo: 'x' }, 4)).rejects.toEqual(
      recusa(409, 'SEQUENCIA_INVALIDA'),
    )
  })
})
