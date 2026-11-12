import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import type { Escolha, Escolhido, Grupo, Reservado } from '../colonia/escolha.ts'
import type { Lancamento } from '../colonia/ocorrencia.ts'
import { passaDoPedido } from '../colonia/reserva.ts'
import { buscarAtendimento } from '../motor/motor.service.ts'
import { registrarEntrega } from './entrega.service.ts'
import {
  MOTIVO_SEM_RESPOSTA,
  aprovarPedido,
  criarPedido,
  listarPedidos,
  recusarPedido,
  recusarSemResposta,
} from './pedido.service.ts'
import { desfazerReserva, reservarAnimais } from './reserva.service.ts'

// Os servicos do pedido contra uma colonia de mentira, em memoria: caixas, partos, os animais (uma
// linha por rato), os pedidos e a trilha. O Prisma e as portas de escrita do modulo colonia (a
// escolha, o lancamento e a liberacao) sao trocados por versoes que leem e escrevem aqui. A de
// mentira cobra o que o banco cobra (o teto do proprio pedido na reserva, a cobertura exata ao
// mudar o status) e desfaz tudo quando a transacao falha. O banco de verdade e o
// pedido.banco.test.ts; aqui ficam as regras do pedido

type Caixa = {
  id: number
  codigo: string
  ativa: boolean
  tipo: 'casal' | 'estoque'
  idEspecie: number
  /** a caixa de casal com o casal ativo ou com parto pendente nao e liberada */
  segura: boolean
}
/** A ninhada do cadastro inicial (sem casal conhecido) tem ordem e casal nulos */
type Parto = { id: number; ordem: number | null; casal: string | null; idLinhagem: number; dtPartoReal: Date; dtDesmameReal: Date | null }
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
type Pedido = {
  id: number
  status: string
  idEspecie: number
  idLinhagem: number
  qtdM: number
  qtdF: number
  qtdQualquer: number
  idadeMinDias: number
  idadeMaxDias: number
  dtDesejada: Date
  dtCriacao: Date
  dtEntrega: Date | null
  protocoloCeua: string
  nomePesquisador: string
  observacoes: string | null
  idUsuarioSolicitante: number
  idProjeto: number | null
}
type Ocorrencia = { id: number; tipo: string; idPedido: number | null; motivo: string | null; ids: number[]; dtFato: Date; dtRegistro: Date }
type Historico = { entidade: string; idEntidade: number; acao: string; dtHora: Date; dados?: unknown; idUsuario: number | null }

const banco = vi.hoisted(() => ({
  caixas: new Map<number, Caixa>(),
  partos: new Map<number, Parto>(),
  animais: [] as Animal[],
  pedidos: new Map<number, Pedido>(),
  ocorrencias: [] as Ocorrencia[],
  historicos: [] as Historico[],
  liberadas: [] as { idCaixa: number; dtFato: string; motivo: string }[],
  avisos: [] as { aviso: string; email: string; motivo?: string | undefined }[],
  /** o servico de e-mail fora do ar: o envio registra a tentativa e falha */
  emailFalha: false,
  proximoId: 1000,
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const iso = (data: Date) => data.toISOString().slice(0, 10)
const LINHAGENS: Record<number, string> = { 3: 'Wistar', 4: 'Kyoto' }

/** O que o banco recusaria: os servicos tem de recusar antes, com a mensagem deles */
function recusaDoBanco(prefixo: string) {
  return Object.assign(new Error(`${prefixo}: o banco recusou`), { prefixo })
}

const contar = (animais: Animal[]) => ({
  m: animais.filter((a) => a.sexo === 'M').length,
  f: animais.filter((a) => a.sexo === 'F').length,
})
const partoDo = (animal: Animal) => banco.partos.get(animal.idParto) as Parto

// ------------------------------------------------------------------ o Prisma de mentira

type OndeAnimal = {
  situacao?: string | { in: string[] }
  idPedido?: number | null | { in: number[] }
  idCaixa?: number
  parto?: { dtPartoReal?: Date; idLinhagem?: number }
  caixa?: { idEspecie: number }
}

function passaNoFiltro(a: Animal, onde: OndeAnimal): boolean {
  const { situacao, idPedido, idCaixa, parto, caixa } = onde
  if (typeof situacao === 'string' && a.situacao !== situacao) return false
  if (typeof situacao === 'object' && !situacao.in.includes(a.situacao)) return false
  if (idPedido === null && a.idPedido !== null) return false
  if (typeof idPedido === 'number' && a.idPedido !== idPedido) return false
  if (typeof idPedido === 'object' && idPedido !== null && (a.idPedido === null || !idPedido.in.includes(a.idPedido))) return false
  if (idCaixa !== undefined && a.idCaixa !== idCaixa) return false
  if (parto?.dtPartoReal !== undefined && partoDo(a).dtPartoReal.getTime() !== parto.dtPartoReal.getTime()) return false
  if (parto?.idLinhagem !== undefined && partoDo(a).idLinhagem !== parto.idLinhagem) return false
  if (caixa !== undefined && banco.caixas.get(a.idCaixa)?.idEspecie !== caixa.idEspecie) return false
  return true
}

function agrupar<T extends Record<string, unknown>>(linhas: T[], por: (keyof T)[]) {
  const grupos = new Map<string, { chave: Partial<T>; n: number }>()
  for (const linha of linhas) {
    const chave = Object.fromEntries(por.map((campo) => [campo, linha[campo]])) as Partial<T>
    const texto = JSON.stringify(chave)
    grupos.set(texto, { chave, n: (grupos.get(texto)?.n ?? 0) + 1 })
  }
  return [...grupos.values()].map(({ chave, n }) => ({ ...chave, _count: { _all: n } }))
}

function comRelacoes(p: Pedido) {
  return {
    ...p,
    linhagem: { id: p.idLinhagem, nome: LINHAGENS[p.idLinhagem] ?? '?' },
    especie: { nome: 'Rato' },
    usuarioSolicitante: { email: `pessoa${p.idUsuarioSolicitante}@ufsc.br` },
  }
}

/** O trigger demanda.pedido_coerente: o status novo tem de ficar coerente com os animais */
function conferirStatus(p: Pedido, status: string) {
  const doPedido = banco.animais.filter((a) => a.idPedido === p.id)
  const vivos = contar(doPedido.filter((a) => a.situacao === 'vivo'))
  const entregues = contar(doPedido.filter((a) => a.situacao === 'entregue'))
  const total = p.qtdM + p.qtdF + p.qtdQualquer
  const exato = (t: { m: number; f: number }) => t.m >= p.qtdM && t.f >= p.qtdF && t.m + t.f === total

  if (status === 'reservado' && !exato(vivos)) throw recusaDoBanco('PEDIDO_INCOMPLETO')
  if (status === 'entregue' && (vivos.m + vivos.f > 0 || !exato(entregues))) throw recusaDoBanco('PEDIDO_INCOMPLETO')
  if (status !== 'reservado' && status !== 'entregue' && vivos.m + vivos.f > 0) throw recusaDoBanco('PEDIDO_COM_RESERVA')
}

/** O trigger colonia.animal_coerente na reserva: pedido aprovado ou reservado, da linhagem, sem passar do teto dele */
function reservarNoBanco(animal: Animal, idPedido: number) {
  const pedido = banco.pedidos.get(idPedido) as Pedido
  if (pedido.status !== 'aprovado' && pedido.status !== 'reservado') throw recusaDoBanco('PEDIDO_RESERVA')
  if (partoDo(animal).idLinhagem !== pedido.idLinhagem) throw recusaDoBanco('PEDIDO_RESERVA')

  const pesam = banco.animais.filter(
    (a) => a.idPedido === idPedido && (a.situacao === 'vivo' || a.situacao === 'entregue') && a.id !== animal.id,
  )
  if (passaDoPedido(pedido, contar([...pesam, animal]))) throw recusaDoBanco('PEDIDO_EXCEDIDO')

  animal.idPedido = idPedido
}

const db = {
  $queryRaw: async () => [],
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const { caixas, animais, pedidos, ocorrencias, historicos, liberadas } = banco
    const antes = structuredClone({ caixas, animais, pedidos, ocorrencias, historicos, liberadas })
    try {
      return await fn(db)
    } catch (erro) {
      Object.assign(banco, antes)
      throw erro
    }
  },
  especie: { findMany: async () => [{ id: 1, nome: 'Rato' }] },
  linhagem: {
    findUnique: async ({ where }: { where: { id: number } }) =>
      LINHAGENS[where.id] === undefined ? null : { id: where.id, idEspecie: 1, nome: LINHAGENS[where.id], ativa: where.id !== 4 },
  },
  projeto: { findUnique: async () => null },
  caixa: {
    findUnique: async ({ where }: { where: { id: number } }) => banco.caixas.get(where.id) ?? null,
    findMany: async ({ where }: { where: { id: { in: number[] } } }) =>
      [...banco.caixas.values()].filter((c) => where.id.in.includes(c.id)).map((c) => ({ ...c, estante: { numeroVisivel: 'E1' } })),
  },
  parto: {
    findMany: async ({ where }: { where: { id: { in: number[] } } }) =>
      [...banco.partos.values()]
        .filter((p) => where.id.in.includes(p.id))
        .map((p) => ({ ...p, casal: p.casal === null ? null : { identificacao: p.casal } })),
  },
  animal: {
    groupBy: async ({ by, where }: { by: (keyof Animal)[]; where: OndeAnimal }) =>
      agrupar(banco.animais.filter((a) => passaNoFiltro(a, where)), by),
    findMany: async ({ where }: { where: OndeAnimal }) => {
      const caixas = [...new Set(banco.animais.filter((a) => passaNoFiltro(a, where)).map((a) => a.idCaixa))]
      return caixas.sort((a, b) => a - b).map((idCaixa) => ({ idCaixa }))
    },
  },
  pedido: {
    findUnique: async ({ where }: { where: { id: number } }) => {
      const p = banco.pedidos.get(where.id)
      return p === undefined ? null : comRelacoes(p)
    },
    findMany: async ({ where = {} }: { where?: { id?: { in: number[] }; status?: string; dtCriacao?: { lte: Date }; idUsuarioSolicitante?: number } }) =>
      [...banco.pedidos.values()]
        .filter(
          (p) =>
            (where.id === undefined || where.id.in.includes(p.id)) &&
            (where.status === undefined || p.status === where.status) &&
            (where.dtCriacao === undefined || p.dtCriacao <= where.dtCriacao.lte) &&
            (where.idUsuarioSolicitante === undefined || p.idUsuarioSolicitante === where.idUsuarioSolicitante),
        )
        .sort((a, b) => b.id - a.id)
        .map(comRelacoes),
    create: async ({ data }: { data: Omit<Pedido, 'id' | 'dtCriacao' | 'dtEntrega'> }) => {
      const pedido: Pedido = { id: banco.proximoId++, dtCriacao: new Date(), dtEntrega: null, ...data }
      banco.pedidos.set(pedido.id, pedido)
      return pedido
    },
    update: async ({ where, data }: { where: { id: number }; data: Partial<Pedido> }) => {
      const pedido = banco.pedidos.get(where.id) as Pedido
      if (data.status !== undefined) conferirStatus(pedido, data.status)
      Object.assign(pedido, data)
      return pedido
    },
  },
  ocorrencia: {
    groupBy: async ({ where }: { where: { tipo: string; idPedido: { in: number[] } } }) => {
      const doTipo = banco.ocorrencias.filter((o) => o.tipo === where.tipo && o.idPedido !== null && where.idPedido.in.includes(o.idPedido))
      return [...new Set(doTipo.map((o) => o.idPedido))].map((idPedido) => ({
        idPedido,
        _min: { dtRegistro: doTipo.filter((o) => o.idPedido === idPedido).map((o) => o.dtRegistro).sort((a, b) => a.getTime() - b.getTime())[0] },
      }))
    },
  },
  historico: {
    create: async ({ data }: { data: Omit<Historico, 'dtHora'> }) => {
      banco.historicos.push({ ...data, dtHora: new Date() })
    },
    findMany: async ({ where }: { where: { entidade: string; acao: { in: string[] }; idEntidade: { in: number[] } } }) =>
      banco.historicos
        .filter((h) => h.entidade === where.entidade && where.acao.in.includes(h.acao) && where.idEntidade.in.includes(h.idEntidade))
        .sort((a, b) => a.dtHora.getTime() - b.dtHora.getTime()),
  },
}

// o vi.mock sobe para o topo do arquivo, antes de 'db' existir: o Prisma le 'db' so na hora do uso
vi.mock('../../shared/prisma.ts', () => ({
  prisma: new Proxy({}, { get: (_prisma, chave) => db[chave as keyof typeof db] }),
}))

vi.mock('../../shared/email.ts', () => ({
  avisarPedidoDecidido: async (email: string, _resumo: unknown, motivo?: string) => {
    banco.avisos.push({ aviso: motivo === undefined ? 'aprovado' : 'recusado', email, motivo })
    if (banco.emailFalha) throw new Error('Brevo fora do ar')
  },
  avisarAnimaisReservados: async (email: string) => {
    banco.avisos.push({ aviso: 'reservados', email })
    if (banco.emailFalha) throw new Error('Brevo fora do ar')
  },
}))

// ------------------------------------------------------------------ o modulo colonia de mentira

function escolhido(a: Animal): Escolhido {
  return { id: a.id, idCaixa: a.idCaixa, idPedido: a.idPedido, dtMovimento: a.dtMovimento, dtNascimento: partoDo(a).dtPartoReal }
}

vi.mock('../colonia/escolha.ts', async (original) => ({
  ...(await original<typeof import('../colonia/escolha.ts')>()),
  escolherAnimais: async (_tx: unknown, grupo: Grupo, qtd: number, escolha: Escolha = {}) => {
    if (qtd === 0) return []
    if (escolha.soLivres !== true) throw new Error('a reserva so escolhe livres')

    const livres = banco.animais
      .filter(
        (a) =>
          a.situacao === 'vivo' &&
          a.idPedido === null &&
          a.sexo === grupo.sexo &&
          (grupo.idCaixa === undefined || a.idCaixa === grupo.idCaixa) &&
          (grupo.dtNascimento === undefined || iso(partoDo(a).dtPartoReal) === grupo.dtNascimento) &&
          !(escolha.excluir ?? []).includes(a.id),
      )
      .sort((a, b) => a.id - b.id)
      .slice(0, qtd)

    if (livres.length < qtd) throw Object.assign(new Error('sem animais'), { status: 409, codigo: 'SEM_ANIMAIS' })
    return livres.map(escolhido)
  },
  travarReservados: async (_tx: unknown, idPedido: number) =>
    banco.animais
      .filter((a) => a.situacao === 'vivo' && a.idPedido === idPedido)
      .sort((a, b) => a.id - b.id)
      .map(
        (a): Reservado => ({
          ...escolhido(a),
          sexo: a.sexo,
          idParto: a.idParto,
          dtDesmameReal: partoDo(a).dtDesmameReal,
          codigo: (banco.caixas.get(a.idCaixa) as Caixa).codigo,
        }),
      ),
}))

vi.mock('../colonia/ocorrencia.ts', () => ({
  lancarOcorrencia: async (_tx: unknown, l: Lancamento) => {
    if (l.tipo !== 'reserva' && l.tipo !== 'reserva_desfeita' && l.tipo !== 'entrega') {
      throw new Error(`o teste do pedido nao lanca ${l.tipo}`)
    }

    const animais = l.ids.map((id) => banco.animais.find((a) => a.id === id) as Animal)

    for (const a of animais) {
      if (l.tipo === 'reserva') {
        if (a.situacao !== 'vivo' || a.idPedido !== null) throw new Error('animal mudou')
        reservarNoBanco(a, l.idPedido)
      } else {
        if (a.situacao !== 'vivo' || a.idPedido !== l.idPedido) throw new Error('animal mudou')
        if (l.tipo === 'reserva_desfeita') a.idPedido = null
        if (l.tipo === 'entrega') {
          if (banco.pedidos.get(l.idPedido)?.status !== 'reservado') throw recusaDoBanco('PEDIDO_RESERVA')
          Object.assign(a, { situacao: 'entregue', dtSaida: d(l.dtFato) })
        }
      }
    }

    const ocorrencia = {
      id: banco.proximoId++,
      tipo: l.tipo,
      idPedido: l.idPedido,
      motivo: l.motivo ?? null,
      ids: l.ids,
      dtFato: d(l.dtFato),
      dtRegistro: new Date(),
    }
    banco.ocorrencias.push(ocorrencia)
    return { idOcorrencia: ocorrencia.id, ids: l.ids }
  },
}))

vi.mock('../colonia/liberacao.ts', async (original) => ({
  ...(await original<typeof import('../colonia/liberacao.ts')>()),
  liberarSeVazia: async (_tx: unknown, idCaixa: number, dtFato: string, motivo: string) => {
    const caixa = banco.caixas.get(idCaixa) as Caixa
    const vivo = banco.animais.some((a) => a.idCaixa === idCaixa && a.situacao === 'vivo')
    if (!caixa.ativa || vivo || caixa.segura) return false

    caixa.ativa = false
    banco.liberadas.push({ idCaixa, dtFato, motivo })
    return true
  },
}))

// ------------------------------------------------------------------ o cenario

function nascer(idParto: number, idCaixa: number, m: number, f: number, dtMovimento: string | null = null) {
  const sexos = [...Array<'M'>(m).fill('M'), ...Array<'F'>(f).fill('F')]
  return sexos.map((sexo) => {
    const animal: Animal = {
      id: banco.proximoId++,
      idParto,
      sexo,
      idCaixa,
      situacao: 'vivo',
      dtSaida: null,
      dtMovimento: dtMovimento === null ? null : d(dtMovimento),
      idPedido: null,
    }
    banco.animais.push(animal)
    return animal.id
  })
}

function pedido(id: number, campos: Partial<Pedido> = {}) {
  banco.pedidos.set(id, {
    id,
    status: 'aprovado',
    idEspecie: 1,
    idLinhagem: 3,
    qtdM: 2,
    qtdF: 2,
    qtdQualquer: 1,
    // 60 a 70 dias: aceita de 53 a 80, com a tolerancia
    idadeMinDias: 60,
    idadeMaxDias: 70,
    dtDesejada: d('2026-11-10'),
    dtCriacao: new Date('2026-11-01T13:00:00.000Z'),
    dtEntrega: null,
    protocoloCeua: '23080.000001/2026-54',
    nomePesquisador: 'Paula',
    observacoes: null,
    idUsuarioSolicitante: 30 + id,
    idProjeto: null,
    ...campos,
  })
}

/**
 * Wistar: o parto 1 (01/09, desmamado em 23/09) com 5 machos na caixa de estoque F2A e 5 femeas na
 * F3A; o parto 2 (20/10, mamando) com 3 M e 3 F na caixa do casal F1A. Kyoto: o parto 3 (01/09,
 * desmamado) com 3 M e 3 F ainda na caixa do casal F1B
 */
function cenario() {
  banco.caixas = new Map<number, Caixa>([
    [1, { id: 1, codigo: 'F1A', ativa: true, tipo: 'casal', idEspecie: 1, segura: true }],
    [2, { id: 2, codigo: 'F2A', ativa: true, tipo: 'estoque', idEspecie: 1, segura: false }],
    [3, { id: 3, codigo: 'F3A', ativa: true, tipo: 'estoque', idEspecie: 1, segura: false }],
    [4, { id: 4, codigo: 'F1B', ativa: true, tipo: 'casal', idEspecie: 1, segura: false }],
  ])
  banco.partos = new Map<number, Parto>([
    [1, { id: 1, ordem: 1, casal: 'AB', idLinhagem: 3, dtPartoReal: d('2026-09-01'), dtDesmameReal: d('2026-09-23') }],
    [2, { id: 2, ordem: 2, casal: 'AB', idLinhagem: 3, dtPartoReal: d('2026-10-20'), dtDesmameReal: null }],
    [3, { id: 3, ordem: 1, casal: 'CD', idLinhagem: 4, dtPartoReal: d('2026-09-01'), dtDesmameReal: d('2026-09-23') }],
  ])
  banco.animais = []
  banco.pedidos = new Map()
  banco.ocorrencias = []
  banco.historicos = []
  banco.liberadas = []
  banco.avisos = []
  banco.emailFalha = false
  banco.proximoId = 1000

  nascer(1, 2, 5, 0, '2026-09-25')
  nascer(1, 3, 0, 5, '2026-09-25')
  nascer(2, 1, 3, 3)
  nascer(3, 4, 3, 3)
}

const tecnica: UsuarioDaSessao = { id: 2, nome: 'Ana', email: 'tecnico@ufsc.br', perfil: 'tecnico' }
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })
const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })
const mensagem = (codigo: string, trecho: string) =>
  expect.objectContaining({ status: 409, codigo, message: expect.stringContaining(trecho) })

const doPedido = (idPedido: number, situacao = 'vivo') =>
  banco.animais.filter((a) => a.idPedido === idPedido && a.situacao === situacao)
const naCaixa = (idCaixa: number) => banco.animais.filter((a) => a.idCaixa === idCaixa && a.situacao === 'vivo')

/** O parto 1 inteiro do pedido: 3 machos da F2A e 2 femeas da F3A (o qualquer vira macho) */
const doParto1 = (machos = 3, femeas = 2) => [
  { idCaixa: 2, dtNascimento: '2026-09-01', machos, femeas: 0 },
  { idCaixa: 3, dtNascimento: '2026-09-01', machos: 0, femeas },
]

/** A baixa de animais reservados, como a baixa da caixa lanca: ficam mortos, com o pedido como registro */
function morrer(ids: number[]) {
  for (const a of banco.animais.filter((animal) => ids.includes(animal.id))) {
    Object.assign(a, { situacao: 'morto', dtSaida: d('2026-11-05') })
  }
}

beforeEach(cenario)

// ------------------------------------------------------------------ pedido novo, aprovacao e lista

describe('pedido novo', () => {
  const novo = {
    nomePesquisador: 'Paula',
    protocoloCeua: '23080.000001/2026-54',
    idLinhagem: 3,
    machos: 2,
    femeas: 1,
    qualquer: 0,
    idadeMin: 28,
    idadeMax: 30,
    dataEntrega: '2026-12-01',
    observacoes: null,
  }
  const pesquisadora: UsuarioDaSessao = { id: 31, nome: 'Paula', email: 'paula@ufsc.br', perfil: 'pesquisador' }

  it('nasce enviado, com a especie da linhagem, e o historico grava a criacao do pedido', async () => {
    const { id } = await criarPedido(novo, pesquisadora, new Date('2026-11-08T12:00:00.000Z'))

    expect(banco.pedidos.get(id)).toMatchObject({ status: 'enviado', idEspecie: 1, idLinhagem: 3, qtdM: 2, qtdF: 1 })
    expect(banco.historicos).toEqual([
      expect.objectContaining({
        entidade: 'pedido',
        idEntidade: id,
        acao: 'criacao',
        descricao: 'Pedido de 2 machos e 1 fêmea de Wistar para 01/12/2026',
      }),
    ])
  })

  it('recusa linhagem inativa e entrega no passado, no campo', async () => {
    await expect(criarPedido({ ...novo, idLinhagem: 4 }, pesquisadora)).rejects.toEqual(noCampo('idLinhagem', 'inativa'))
    await expect(
      criarPedido({ ...novo, dataEntrega: '2026-11-07' }, pesquisadora, new Date('2026-11-08T12:00:00.000Z')),
    ).rejects.toEqual(noCampo('dataEntrega', 'passado'))
  })
})

describe('aprovacao', () => {
  it('passa o enviado a aprovado, sem reservar nada, e avisa quem pediu', async () => {
    pedido(10, { status: 'enviado' })

    expect(await aprovarPedido(10, tecnica)).toEqual({ idPedido: 10, status: 'aprovado' })
    expect(banco.pedidos.get(10)?.status).toBe('aprovado')
    expect(banco.animais.some((a) => a.idPedido !== null)).toBe(false)
    expect(banco.historicos).toEqual([expect.objectContaining({ entidade: 'pedido', acao: 'aprovacao', idUsuario: 2 })])
    expect(banco.avisos).toEqual([{ aviso: 'aprovado', email: 'pessoa40@ufsc.br', motivo: undefined }])
  })

  it('o segundo clique e o pedido ja decidido sao SEQUENCIA_INVALIDA, sem aviso', async () => {
    pedido(10, { status: 'aprovado' })
    pedido(11, { status: 'recusado' })

    await expect(aprovarPedido(10, tecnica)).rejects.toEqual(mensagem('SEQUENCIA_INVALIDA', 'já foi aprovado'))
    await expect(aprovarPedido(11, tecnica)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    await expect(aprovarPedido(99, tecnica)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
    expect(banco.avisos).toEqual([])
  })
})

describe('lista de pedidos', () => {
  it('o status e o do banco, o prazo so no enviado, a data entregue e a da entrega e o motivo e o da recusa', async () => {
    pedido(10, { status: 'enviado' })
    pedido(11, { status: 'entregue', dtEntrega: d('2026-11-08') })
    pedido(12, { status: 'recusado' })
    banco.historicos.push(
      { entidade: 'pedido', idEntidade: 12, acao: 'recusa', dtHora: new Date('2026-11-03T15:00:00.000Z'), dados: { motivo: 'Sem animais' }, idUsuario: 2 },
      { entidade: 'pedido', idEntidade: 11, acao: 'aprovacao', dtHora: new Date('2026-11-02T15:00:00.000Z'), idUsuario: 2 },
    )

    const { pedidos } = await listarPedidos(tecnica)

    expect(pedidos.map((p) => [p.id, p.status, p.prazoResposta, p.dataAceite, p.dataEntregue, p.dataRecusa, p.motivoRecusa])).toEqual([
      [12, 'recusado', null, null, null, '2026-11-03', 'Sem animais'],
      [11, 'entregue', null, '2026-11-02', '2026-11-08', null, null],
      [10, 'enviado', '2026-11-15', null, null, null, null],
    ])
  })

  it('o pesquisador so ve os proprios pedidos', async () => {
    pedido(10)
    pedido(11)

    const { pedidos } = await listarPedidos({ id: 41, nome: 'P', email: 'p@ufsc.br', perfil: 'pesquisador' })

    expect(pedidos.map((p) => p.id)).toEqual([11])
  })

  it('o aceite do pedido convertido sem aprovacao no historico e o dia da primeira reserva', async () => {
    pedido(10, { status: 'entregue', dtEntrega: d('2026-11-08') })
    banco.ocorrencias.push({ id: 1, tipo: 'reserva', idPedido: 10, motivo: null, ids: [], dtFato: d('2026-11-04'), dtRegistro: new Date('2026-11-04T18:00:00.000Z') })

    const [lido] = (await listarPedidos(tecnica)).pedidos

    expect(lido?.dataAceite).toBe('2026-11-04')
  })
})

// ------------------------------------------------------------------ reserva

describe('reservar o pedido aprovado', () => {
  it('reserva o pedido inteiro dos lugares da busca, o qualquer como macho, e passa a reservado', async () => {
    pedido(10)

    const resposta = await reservarAnimais(10, doParto1(), tecnica)

    expect(resposta).toEqual({ idPedido: 10, status: 'reservado', reservados: { m: 3, f: 2 }, falta: null })
    expect(banco.pedidos.get(10)?.status).toBe('reservado')
    expect(contar(doPedido(10))).toEqual({ m: 3, f: 2 })
    // quaisquer vivos do lugar, pela ordem de id
    expect(doPedido(10).every((a) => a.idParto === 1)).toBe(true)
    expect(banco.ocorrencias).toEqual([expect.objectContaining({ tipo: 'reserva', idPedido: 10, ids: doPedido(10).map((a) => a.id) })])
    expect(banco.avisos).toEqual([{ aviso: 'reservados', email: 'pessoa40@ufsc.br' }])
  })

  it('o mesmo lugar duas vezes vira um so', async () => {
    pedido(10, { qtdM: 2, qtdF: 0, qtdQualquer: 0 })

    await reservarAnimais(
      10,
      [
        { idCaixa: 2, dtNascimento: '2026-09-01', machos: 1, femeas: 0 },
        { idCaixa: 2, dtNascimento: '2026-09-01', machos: 1, femeas: 0 },
      ],
      tecnica,
    )

    expect(contar(doPedido(10))).toEqual({ m: 2, f: 0 })
  })

  it('so o pedido inteiro: a reserva que nao cobre e PEDIDO_INCOMPLETO, e nada fica', async () => {
    pedido(10)

    await expect(reservarAnimais(10, doParto1(2, 2), tecnica)).rejects.toEqual(mensagem('PEDIDO_INCOMPLETO', 'falta 1 de qualquer sexo'))
    expect(doPedido(10)).toEqual([])
    expect(banco.pedidos.get(10)?.status).toBe('aprovado')
    expect(banco.avisos).toEqual([])
  })

  it('nunca passa do pedido: o macho pedido nao vira femea, nem o total passa', async () => {
    pedido(10)

    await expect(reservarAnimais(10, doParto1(4, 2), tecnica)).rejects.toEqual(mensagem('PEDIDO_EXCEDIDO', 'ficariam 4 machos e 2 fêmeas'))
    await expect(reservarAnimais(10, doParto1(1, 4), tecnica)).rejects.toEqual(recusa(409, 'PEDIDO_EXCEDIDO'))
    expect(doPedido(10)).toEqual([])
  })

  it('confere a idade na data desejada com a tolerancia da busca, e o desmame ate ela', async () => {
    // o parto 2 nasceu em 20/10: na entrega de 10/11 tem 21 dias, mas so desmama em 11/11
    pedido(11, { qtdM: 1, qtdF: 0, qtdQualquer: 0, idadeMinDias: 21, idadeMaxDias: 21 })
    const doParto2 = [{ idCaixa: 1, dtNascimento: '2026-10-20', machos: 1, femeas: 0 }]

    await expect(reservarAnimais(11, doParto2, tecnica)).rejects.toEqual(mensagem('NAO_DESMAMADO', 'desmamados em 11/11/2026, depois da entrega de 10/11/2026'))

    // no pedido de 60 a 70 dias, os 21 dias ficam fora da faixa aceita (53 a 80)
    pedido(12, { qtdM: 1, qtdF: 0, qtdQualquer: 0 })
    await expect(reservarAnimais(12, doParto2, tecnica)).rejects.toEqual(mensagem('IDADE_FORA_DA_FAIXA', 'terão 21 dias em 10/11/2026'))

    // com entrega em 11/11, 22 dias e desmamado pelo previsto: passa
    pedido(13, { qtdM: 1, qtdF: 0, qtdQualquer: 0, idadeMinDias: 22, idadeMaxDias: 22, dtDesejada: d('2026-11-11') })
    await reservarAnimais(13, doParto2, tecnica)
    expect(contar(doPedido(13))).toEqual({ m: 1, f: 0 })
  })

  it('o lugar tem de ter os livres pedidos, da linhagem do pedido', async () => {
    pedido(10, { qtdM: 6, qtdF: 0, qtdQualquer: 0 })
    pedido(11, { qtdM: 1, qtdF: 0, qtdQualquer: 0 })

    await expect(reservarAnimais(10, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 6, femeas: 0 }], tecnica)).rejects.toEqual(
      mensagem('SEM_ANIMAIS', 'A caixa F2A tem 5 machos livres'),
    )
    await expect(reservarAnimais(11, [{ idCaixa: 2, dtNascimento: '2026-09-02', machos: 1, femeas: 0 }], tecnica)).rejects.toEqual(
      mensagem('SEM_ANIMAIS', 'não tem animais livres do nascimento de 02/09/2026'),
    )
    // a caixa F1B guarda Kyoto
    await expect(reservarAnimais(11, [{ idCaixa: 4, dtNascimento: '2026-09-01', machos: 1, femeas: 0 }], tecnica)).rejects.toEqual(
      mensagem('PEDIDO_RESERVA', 'não são da linhagem do pedido'),
    )
  })

  it('animal reservado para outro pedido nao conta como livre', async () => {
    pedido(10, { qtdM: 4, qtdF: 0, qtdQualquer: 0 })
    pedido(11, { qtdM: 2, qtdF: 0, qtdQualquer: 0 })
    await reservarAnimais(10, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 4, femeas: 0 }], tecnica)

    await expect(reservarAnimais(11, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 2, femeas: 0 }], tecnica)).rejects.toEqual(
      mensagem('SEM_ANIMAIS', 'tem 1 macho livre do nascimento de 01/09/2026, e a reserva pediu 2'),
    )
    expect(contar(doPedido(10))).toEqual({ m: 4, f: 0 })
  })

  it('o pedido enviado ainda nao recebe animais; o reservado completo, entregue ou recusado, nunca', async () => {
    pedido(10, { status: 'enviado' })
    pedido(11, { status: 'recusado' })
    pedido(12, { qtdM: 1, qtdF: 0, qtdQualquer: 0 })
    await reservarAnimais(12, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 1, femeas: 0 }], tecnica)

    await expect(reservarAnimais(10, doParto1(), tecnica)).rejects.toEqual(mensagem('SEQUENCIA_INVALIDA', 'Aprove o pedido'))
    await expect(reservarAnimais(11, doParto1(), tecnica)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    // dois tecnicos, ou dois cliques em Reservar
    await expect(
      reservarAnimais(12, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 1, femeas: 0 }], tecnica),
    ).rejects.toEqual(mensagem('PEDIDO_JA_RESERVADO', 'já estão reservados'))
    await expect(reservarAnimais(99, doParto1(), tecnica)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})

describe('reserva em falta', () => {
  /** o pedido 10 reservado com 3 M e 2 F do parto 1; um dos machos morre */
  async function emFalta() {
    pedido(10)
    await reservarAnimais(10, doParto1(), tecnica)
    const [morto] = doPedido(10).filter((a) => a.sexo === 'M')
    morrer([morto?.id ?? 0])
    banco.avisos = []
    return morto?.id ?? 0
  }

  it('a lista mostra a falta do proprio pedido', async () => {
    await emFalta()

    const [lido] = (await listarPedidos(tecnica)).pedidos

    expect(lido).toMatchObject({ status: 'reservado', reservaEmFalta: { m: 0, f: 0, qualquer: 1 } })
  })

  it('completa com outros livres equivalentes, sem aviso, e a falta some', async () => {
    await emFalta()

    const resposta = await reservarAnimais(10, [{ idCaixa: 3, dtNascimento: '2026-09-01', machos: 0, femeas: 1 }], tecnica)

    expect(resposta).toEqual({ idPedido: 10, status: 'reservado', reservados: { m: 0, f: 1 }, falta: null })
    expect(contar(doPedido(10))).toEqual({ m: 2, f: 3 })
    expect(banco.avisos).toEqual([])
    expect((await listarPedidos(tecnica)).pedidos[0]?.reservaEmFalta).toBeNull()
  })

  it('completa aos poucos, mas nunca passa do pedido', async () => {
    pedido(10, { qtdM: 3, qtdF: 0, qtdQualquer: 0 })
    await reservarAnimais(10, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 3, femeas: 0 }], tecnica)
    morrer(doPedido(10).slice(0, 2).map((a) => a.id))

    const parcial = await reservarAnimais(10, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 1, femeas: 0 }], tecnica)
    expect(parcial.falta).toEqual({ m: 1, f: 0, qualquer: 0 })

    await expect(
      reservarAnimais(10, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 2, femeas: 0 }], tecnica),
    ).rejects.toEqual(recusa(409, 'PEDIDO_EXCEDIDO'))
    expect(contar(doPedido(10))).toEqual({ m: 2, f: 0 })
  })

  it('o morto guarda o pedido como registro e nao pesa nele', async () => {
    const morto = await emFalta()

    await reservarAnimais(10, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 1, femeas: 0 }], tecnica)

    expect(banco.animais.find((a) => a.id === morto)).toMatchObject({ situacao: 'morto', idPedido: 10 })
    expect(contar(doPedido(10))).toEqual({ m: 3, f: 2 })
  })
})

describe('o caso do Arthur: reservar um sexo com o outro em falta noutro pedido', () => {
  /** o pedido A (20) com 2 machos Kyoto reservados da caixa do casal F1B; um sai por baixa */
  async function pedidoAEmFalta() {
    pedido(20, { idLinhagem: 4, qtdM: 2, qtdF: 0, qtdQualquer: 0 })
    await reservarAnimais(20, [{ idCaixa: 4, dtNascimento: '2026-09-01', machos: 2, femeas: 0 }], tecnica)
    morrer([doPedido(20)[0]?.id ?? 0])
  }

  it('reservar 1 femea da mesma ninhada e caixa para o pedido B passa, e a falta continua so com A', async () => {
    await pedidoAEmFalta()
    pedido(21, { idLinhagem: 4, qtdM: 0, qtdF: 1, qtdQualquer: 0 })

    await reservarAnimais(21, [{ idCaixa: 4, dtNascimento: '2026-09-01', machos: 0, femeas: 1 }], tecnica)

    expect(banco.pedidos.get(21)?.status).toBe('reservado')
    expect(contar(doPedido(21))).toEqual({ m: 0, f: 1 })
    const { pedidos } = await listarPedidos(tecnica)
    expect(pedidos.map((p) => [p.id, p.reservaEmFalta])).toEqual([
      [21, null],
      [20, { m: 1, f: 0, qualquer: 0 }],
    ])
  })

  it('a busca sugere essas femeas para B, e a reserva com o que a busca sugeriu passa', async () => {
    await pedidoAEmFalta()
    pedido(21, { idLinhagem: 4, qtdM: 0, qtdF: 1, qtdQualquer: 0 })

    const busca = await buscarAtendimento({
      especie: 'rato',
      idLinhagem: 4,
      machos: 0,
      femeas: 1,
      qualquer: 0,
      idadeMin: 60,
      idadeMax: 70,
      dataEntrega: '2026-11-10',
    })
    const sugeridas = busca.candidatas.filter((c) => c.sugerida)

    expect(sugeridas.map((c) => [c.codigo, c.dtNascimento, c.livres, c.alocar])).toEqual([
      ['F1B', '2026-09-01', { m: 1, f: 3 }, { m: 0, f: 1 }],
    ])
    expect(busca.deficit).toEqual({ m: 0, f: 0, qualquer: 0 })

    await reservarAnimais(
      21,
      sugeridas.map((c) => ({ idCaixa: c.idCaixa, dtNascimento: c.dtNascimento, machos: c.alocar.m, femeas: c.alocar.f })),
      tecnica,
    )

    expect(contar(doPedido(21))).toEqual({ m: 0, f: 1 })
  })
})

describe('desfazer a reserva', () => {
  it('a qualquer momento: os vivos voltam a ficar livres onde estao e o pedido volta a aprovado', async () => {
    pedido(10)
    await reservarAnimais(10, doParto1(), tecnica)
    const reservados = doPedido(10).map((a) => a.id)

    expect(await desfazerReserva(10, tecnica)).toEqual({ idPedido: 10, status: 'aprovado', soltos: { m: 3, f: 2 } })
    expect(banco.pedidos.get(10)?.status).toBe('aprovado')
    expect(banco.animais.filter((a) => reservados.includes(a.id)).every((a) => a.idPedido === null && a.situacao === 'vivo')).toBe(true)
    expect(banco.ocorrencias.at(-1)).toMatchObject({ tipo: 'reserva_desfeita', idPedido: 10, ids: reservados })
    // e reserva de novo
    await reservarAnimais(10, doParto1(), tecnica)
    expect(banco.pedidos.get(10)?.status).toBe('reservado')
  })

  it('com falta tambem; o morto guarda o pedido', async () => {
    pedido(10)
    await reservarAnimais(10, doParto1(), tecnica)
    const [morto] = doPedido(10)
    morrer([morto?.id ?? 0])

    expect((await desfazerReserva(10, tecnica)).soltos).toEqual({ m: 2, f: 2 })
    expect(banco.animais.find((a) => a.id === morto?.id)).toMatchObject({ situacao: 'morto', idPedido: 10 })
  })

  it('so do pedido reservado', async () => {
    pedido(10)
    pedido(11, { status: 'entregue' })

    await expect(desfazerReserva(10, tecnica)).rejects.toEqual(mensagem('SEQUENCIA_INVALIDA', 'não há reserva para desfazer'))
    await expect(desfazerReserva(11, tecnica)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })
})

// ------------------------------------------------------------------ recusa

describe('recusa', () => {
  it('o pedido reservado tambem: os animais voltam a ficar livres, e quem pediu recebe o motivo', async () => {
    pedido(10)
    await reservarAnimais(10, doParto1(), tecnica)
    banco.avisos = []

    const resposta = await recusarPedido(10, 'Pesquisa cancelada', 2)

    expect(resposta).toEqual({ idPedido: 10, status: 'recusado', motivo: 'Pesquisa cancelada', soltos: { m: 3, f: 2 } })
    expect(doPedido(10)).toEqual([])
    expect(banco.ocorrencias.at(-1)).toMatchObject({ tipo: 'reserva_desfeita', motivo: 'Pedido recusado: Pesquisa cancelada' })
    expect(banco.historicos.at(-1)).toMatchObject({ entidade: 'pedido', acao: 'recusa', dados: { motivo: 'Pesquisa cancelada' } })
    expect(banco.avisos).toEqual([{ aviso: 'recusado', email: 'pessoa40@ufsc.br', motivo: 'Pesquisa cancelada' }])
  })

  it('o enviado e o aprovado, sem animal nenhum; o entregue e o recusado, nunca', async () => {
    pedido(10, { status: 'enviado' })
    pedido(11, { status: 'aprovado' })
    pedido(12, { status: 'entregue' })
    pedido(13, { status: 'recusado' })

    expect((await recusarPedido(10, 'x', 2)).soltos).toEqual({ m: 0, f: 0 })
    expect((await recusarPedido(11, 'x', 2)).status).toBe('recusado')
    await expect(recusarPedido(12, 'x', 2)).rejects.toEqual(mensagem('SEQUENCIA_INVALIDA', 'está entregue'))
    await expect(recusarPedido(13, 'x', 2)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.ocorrencias).toEqual([])
  })

  it('a recusa automatica pega so o enviado com 14 dias, sem usuario, e segue quando a equipe decidiu antes', async () => {
    const agora = new Date('2026-11-20T12:00:00.000Z')
    pedido(10, { status: 'enviado', dtCriacao: new Date('2026-11-05T12:00:00.000Z') })
    pedido(11, { status: 'enviado', dtCriacao: new Date('2026-11-07T12:00:00.000Z') })
    pedido(12, { status: 'aprovado', dtCriacao: new Date('2026-10-01T12:00:00.000Z') })

    expect(await recusarSemResposta(agora)).toBe(1)
    expect([10, 11, 12].map((id) => banco.pedidos.get(id)?.status)).toEqual(['recusado', 'enviado', 'aprovado'])
    expect(banco.historicos).toEqual([
      expect.objectContaining({ idEntidade: 10, acao: 'recusa', idUsuario: null, dados: { motivo: MOTIVO_SEM_RESPOSTA } }),
    ])
  })
})

// ------------------------------------------------------------------ entrega

describe('entrega', () => {
  async function reservado() {
    pedido(10)
    await reservarAnimais(10, doParto1(), tecnica)
  }

  it('os reservados saem das caixas onde estao, o pedido grava a data e as caixas que esvaziaram sao liberadas', async () => {
    pedido(10, { qtdM: 5, qtdF: 0, qtdQualquer: 0 })
    await reservarAnimais(10, [{ idCaixa: 2, dtNascimento: '2026-09-01', machos: 5, femeas: 0 }], tecnica)

    const resposta = await registrarEntrega(10, '2026-11-08', 2)

    expect(resposta).toEqual({ idPedido: 10, status: 'entregue', dtEntrega: '2026-11-08', entregues: { m: 5, f: 0 }, caixasLiberadas: ['F2A'] })
    expect(banco.pedidos.get(10)).toMatchObject({ status: 'entregue', dtEntrega: d('2026-11-08') })
    expect(doPedido(10, 'entregue').every((a) => a.idCaixa === 2 && iso(a.dtSaida as Date) === '2026-11-08')).toBe(true)
    expect(banco.liberadas).toEqual([{ idCaixa: 2, dtFato: '2026-11-08', motivo: 'entrega' }])
    expect(banco.ocorrencias.at(-1)).toMatchObject({ tipo: 'entrega', idPedido: 10, dtFato: d('2026-11-08') })
  })

  it('a caixa que ainda tem animal fica ativa', async () => {
    await reservado()

    await registrarEntrega(10, '2026-11-08', 2)

    expect(naCaixa(2)).toHaveLength(2)
    expect(naCaixa(3)).toHaveLength(3)
    expect(banco.liberadas).toEqual([])
  })

  it('a reserva em falta nao entrega: completa ou desfaz antes', async () => {
    await reservado()
    morrer([doPedido(10)[0]?.id ?? 0])

    await expect(registrarEntrega(10, '2026-11-08', 2)).rejects.toEqual(mensagem('PEDIDO_INCOMPLETO', 'está em falta (1 de qualquer sexo)'))
    expect(banco.pedidos.get(10)?.status).toBe('reservado')
  })

  it('a idade de cada animal e conferida na data real, com a tolerancia da busca', async () => {
    await reservado()

    // em 30/11 o parto 1 tem 90 dias, fora dos 53 a 80 aceitos
    await expect(registrarEntrega(10, '2026-11-30', 2)).rejects.toEqual(mensagem('IDADE_FORA_DA_FAIXA', 'Na entrega em 30/11/2026, '))
    expect(doPedido(10)).toHaveLength(5)
    expect(banco.pedidos.get(10)).toMatchObject({ status: 'reservado', dtEntrega: null })

    // em 20/11, 80 dias: a ponta da tolerancia ainda vale
    await registrarEntrega(10, '2026-11-20', 2)
    expect(banco.pedidos.get(10)?.status).toBe('entregue')
  })

  it('sem o desmame registrado, nao entrega', async () => {
    pedido(13, { qtdM: 1, qtdF: 0, qtdQualquer: 0, idadeMinDias: 22, idadeMaxDias: 22, dtDesejada: d('2026-11-11') })
    await reservarAnimais(13, [{ idCaixa: 1, dtNascimento: '2026-10-20', machos: 1, femeas: 0 }], tecnica)

    await expect(registrarEntrega(13, '2026-11-11', 2)).rejects.toEqual(mensagem('NAO_DESMAMADO', 'ainda não foi registrado'))
  })

  it('a data vem depois do pedido e da chegada dos animais na caixa, no campo', async () => {
    await reservado()

    await expect(registrarEntrega(10, '2026-10-31', 2)).rejects.toEqual(noCampo('dtEntrega', 'antes do pedido'))

    ;(banco.pedidos.get(10) as Pedido).dtCriacao = new Date('2026-09-01T12:00:00.000Z')
    await expect(registrarEntrega(10, '2026-09-24', 2)).rejects.toEqual(noCampo('dtEntrega', 'chegada dos animais'))
  })

  it('so o pedido reservado; a segunda entrega e SEQUENCIA_INVALIDA', async () => {
    pedido(11)
    pedido(12, { status: 'recusado' })
    await reservado()
    await registrarEntrega(10, '2026-11-08', 2)

    await expect(registrarEntrega(10, '2026-11-08', 2)).rejects.toEqual(mensagem('SEQUENCIA_INVALIDA', 'já foi registrada'))
    await expect(registrarEntrega(11, '2026-11-08', 2)).rejects.toEqual(mensagem('SEQUENCIA_INVALIDA', 'ainda não tem animais reservados'))
    await expect(registrarEntrega(12, '2026-11-08', 2)).rejects.toEqual(mensagem('SEQUENCIA_INVALIDA', 'foi recusado'))
  })
})

// ------------------------------------------------------------------ o animal do cadastro inicial

describe('o animal do cadastro inicial, sem casal conhecido', () => {
  /**
   * 6 machos Wistar nascidos em 06/10 (35 dias em 10/11) que entraram no cadastro inicial em 01/11
   * na caixa de estoque F4A: a ninhada sem casal, desmamada na entrada, e a chegada na caixa
   */
  function doCadastroInicial() {
    banco.caixas.set(5, { id: 5, codigo: 'F4A', ativa: true, tipo: 'estoque', idEspecie: 1, segura: false })
    banco.partos.set(5, { id: 5, ordem: null, casal: null, idLinhagem: 3, dtPartoReal: d('2026-10-06'), dtDesmameReal: d('2026-11-01') })
    nascer(5, 5, 6, 0, '2026-11-01')
  }

  it('a busca acha, a reserva reserva e a entrega entrega, com ordem e casal nulos na origem', async () => {
    doCadastroInicial()
    pedido(14, { qtdM: 4, qtdF: 0, qtdQualquer: 0, idadeMinDias: 30, idadeMaxDias: 40 })

    const busca = await buscarAtendimento({
      especie: 'rato',
      idLinhagem: 3,
      machos: 4,
      femeas: 0,
      qualquer: 0,
      idadeMin: 30,
      idadeMax: 40,
      dataEntrega: '2026-11-10',
    })
    const sugeridas = busca.candidatas.filter((c) => c.sugerida)

    expect(sugeridas).toEqual([
      expect.objectContaining({
        codigo: 'F4A',
        dtNascimento: '2026-10-06',
        idadeNaEntrega: 35,
        origem: 'de_fato',
        livres: { m: 6, f: 0 },
        alocar: { m: 4, f: 0 },
        partos: [{ ordem: null, casal: null }],
      }),
    ])

    await reservarAnimais(
      14,
      sugeridas.map((c) => ({ idCaixa: c.idCaixa, dtNascimento: c.dtNascimento, machos: c.alocar.m, femeas: c.alocar.f })),
      tecnica,
    )
    expect(banco.pedidos.get(14)?.status).toBe('reservado')
    expect(contar(doPedido(14))).toEqual({ m: 4, f: 0 })

    // antes da entrada no cadastro inicial os animais nao estavam na caixa
    ;(banco.pedidos.get(14) as Pedido).dtCriacao = new Date('2026-10-20T12:00:00.000Z')
    await expect(registrarEntrega(14, '2026-10-31', 2)).rejects.toEqual(noCampo('dtEntrega', 'chegada dos animais'))

    const resposta = await registrarEntrega(14, '2026-11-10', 2)

    expect(resposta).toMatchObject({ status: 'entregue', entregues: { m: 4, f: 0 }, caixasLiberadas: [] })
    expect(naCaixa(5)).toHaveLength(2)
  })
})

// ------------------------------------------------------------------ o aviso que falha

describe('o e-mail que falha nao desfaz a decisao', () => {
  /** O aviso vai depois da resposta: espera o envio falhar e o log registrar */
  const depoisDoEnvio = () => new Promise((pronto) => setTimeout(pronto, 0))

  it('a aprovacao, a reserva e a recusa ficam gravadas, e a falha do envio vai so para o log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    banco.emailFalha = true

    try {
      pedido(10, { status: 'enviado' })
      expect(await aprovarPedido(10, tecnica)).toEqual({ idPedido: 10, status: 'aprovado' })
      expect(banco.pedidos.get(10)?.status).toBe('aprovado')

      expect(await reservarAnimais(10, doParto1(), tecnica)).toMatchObject({ idPedido: 10, status: 'reservado' })
      expect(banco.pedidos.get(10)?.status).toBe('reservado')
      expect(contar(doPedido(10))).toEqual({ m: 3, f: 2 })

      expect(await recusarPedido(10, 'Pesquisa cancelada', 2)).toMatchObject({ idPedido: 10, status: 'recusado' })
      expect(banco.pedidos.get(10)?.status).toBe('recusado')
      expect(doPedido(10)).toEqual([])

      await depoisDoEnvio()

      // os tres envios foram tentados, e cada falha ficou no log com o pedido
      expect(banco.avisos.map((aviso) => aviso.aviso)).toEqual(['aprovado', 'reservados', 'recusado'])
      expect(log).toHaveBeenCalledTimes(3)
      for (const [mensagem, erro] of log.mock.calls) {
        expect(mensagem).toContain('pedido #10')
        expect(erro).toEqual(new Error('Brevo fora do ar'))
      }
    } finally {
      log.mockRestore()
    }
  })
})
