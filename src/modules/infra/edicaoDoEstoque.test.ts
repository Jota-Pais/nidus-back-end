import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Lancamento } from '../colonia/ocorrencia.ts'
import { editarCaixaDeEstoque, planejarEdicaoDoEstoque } from './edicaoDoEstoque.service.ts'
import type { AnimalDaCaixa, PartoDaCaixa, RetratoDoEstoque } from './edicaoDoEstoque.service.ts'

// A edicao da caixa de estoque pela ficha: o plano (o que muda e o que recusa) contra a caixa lida,
// e a gravacao com o Prisma de mentira. O trigger do animal (o sexo do vivo confere com a caixa, o
// morto nao muda de sexo) e o CHECK do nascimento antes do desmame sao do Postgres, conferidos fora
// desta suite

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

/** A ninhada do cadastro inicial: nascida em 01/09, entrou no estoque em 10/11 */
const cadastro = (id: number, campos: Partial<PartoDaCaixa> = {}): PartoDaCaixa => ({
  id,
  ordem: null,
  casal: null,
  codigoDoCasal: null,
  dtNascimento: d('2026-09-01'),
  dtEntrada: d('2026-11-10'),
  ...campos,
})

/** O 1o parto do casal AB, da caixa T1I */
const doCasal = (id: number): PartoDaCaixa => ({
  id,
  ordem: 1,
  casal: 'AB',
  codigoDoCasal: 'T1I',
  dtNascimento: d('2026-09-24'),
  dtEntrada: null,
})

let proximo = 100
const animais = (idParto: number, qtd: number, campos: Partial<AnimalDaCaixa> = {}): AnimalDaCaixa[] =>
  Array.from({ length: qtd }, () => ({ id: proximo++, idParto, sexo: 'F', situacao: 'vivo', idPedido: null, ...campos }))

/** A caixa F2A de estoque, femeas Wistar (rato), com 3 femeas do cadastro inicial */
function retrato(campos: Partial<RetratoDoEstoque> = {}): RetratoDoEstoque {
  return {
    caixa: { codigo: 'F2A', sexo: 'F', idLinhagem: 3, linhagem: 'Wistar', idEspecie: 1 },
    animais: animais(20, 3),
    partos: [cadastro(20)],
    foraDaCaixa: [],
    linhagem: { nova: { id: 5, nome: 'SHR', idEspecie: 1 }, pedidos: [] },
    ...campos,
  }
}

const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })

beforeEach(() => {
  proximo = 100
})

describe('a linhagem', () => {
  it('do cadastro inicial: muda a caixa e a ninhada sem casal, e o historico diz', () => {
    const plano = planejarEdicaoDoEstoque(retrato(), { idLinhagem: 5 })

    expect(plano).toMatchObject({
      idLinhagem: 5,
      partosDaLinhagem: [20],
      sexo: null,
      trocas: [],
      nascimentos: [],
      descricao: 'Caixa de estoque F2A editada: linhagem Wistar → SHR',
      antes: { idLinhagem: 3 },
      depois: { idLinhagem: 5 },
    })
  })

  it('a mesma linhagem nao muda nada', () => {
    expect(planejarEdicaoDoEstoque(retrato(), { idLinhagem: 3, sexo: 'F' })).toBeNull()
  })

  it('de outra especie ou que nao existe recusa', () => {
    expect(() =>
      planejarEdicaoDoEstoque(retrato({ linhagem: { nova: { id: 5, nome: 'C57', idEspecie: 2 }, pedidos: [] } }), { idLinhagem: 5 }),
    ).toThrow(expect.objectContaining({ extras: { campos: { idLinhagem: 'Esta linhagem não é da espécie da caixa.' } } }))
    expect(() => planejarEdicaoDoEstoque(retrato({ linhagem: { nova: null, pedidos: [] } }), { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', 'não encontrada'),
    )
  })

  it('com animais de casal na caixa recusa, dizendo de onde vieram e onde corrigir', () => {
    const caixa = retrato({ animais: [...animais(20, 2), ...animais(30, 3)], partos: [cadastro(20), doCasal(30)] })

    expect(() => planejarEdicaoDoEstoque(caixa, { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', '3 do 1º parto do casal AB, caixa T1I'),
    )
    expect(() => planejarEdicaoDoEstoque(caixa, { idLinhagem: 5 })).toThrow(noCampo('idLinhagem', 'corrija pela ficha do casal'))
  })

  it('o animal de casal que ja saiu da caixa tambem segura a linhagem: ela era a dele', () => {
    const caixa = retrato({ animais: [...animais(20, 2), ...animais(30, 1, { situacao: 'morto' })], partos: [cadastro(20), doCasal(30)] })

    expect(() => planejarEdicaoDoEstoque(caixa, { idLinhagem: 5 })).toThrow(noCampo('idLinhagem', 'casal AB'))
  })

  it('a ninhada com vivos em outra caixa recusa: a linhagem e da ninhada inteira', () => {
    const caixa = retrato({ foraDaCaixa: [{ idParto: 20, codigo: 'F2B', vivos: 2 }] })

    expect(() => planejarEdicaoDoEstoque(caixa, { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', '2 estão na caixa F2B'),
    )
  })

  it('reservado para pedido de outra linhagem recusa; o do registro (entregue) tambem', () => {
    const reservado = retrato({
      linhagem: { nova: { id: 5, nome: 'SHR', idEspecie: 1 }, pedidos: [{ id: 7, idLinhagem: 3, linhagem: 'Wistar', reservados: 2, total: 2 }] },
    })
    const entregue = retrato({
      linhagem: { nova: { id: 5, nome: 'SHR', idEspecie: 1 }, pedidos: [{ id: 8, idLinhagem: 3, linhagem: 'Wistar', reservados: 0, total: 1 }] },
    })

    expect(() => planejarEdicaoDoEstoque(reservado, { idLinhagem: 5 })).toThrow(
      noCampo('idLinhagem', '2 animais desta caixa estão reservados para o pedido #7, de Wistar. Desfaça a reserva'),
    )
    expect(() => planejarEdicaoDoEstoque(entregue, { idLinhagem: 5 })).toThrow(noCampo('idLinhagem', 'não pode mais mudar'))
  })
})

describe('o sexo', () => {
  it('troca a caixa e os vivos, uma correcao por ninhada, na data do nascimento', () => {
    const caixa = retrato({ animais: [...animais(20, 2), ...animais(21, 1)], partos: [cadastro(20), cadastro(21, { dtNascimento: d('2026-09-10') })] })

    const plano = planejarEdicaoDoEstoque(caixa, { sexo: 'M' })

    expect(plano).toMatchObject({
      sexo: 'M',
      trocas: [
        { idParto: 20, ids: [100, 101], dtNascimento: '2026-09-01' },
        { idParto: 21, ids: [102], dtNascimento: '2026-09-10' },
      ],
      descricao: 'Caixa de estoque F2A editada: fêmeas → machos',
      antes: { sexo: 'F' },
      depois: { sexo: 'M' },
    })
  })

  it('com animal que ja saiu da caixa recusa: o sexo nao muda depois da baixa ou da entrega', () => {
    const caixa = retrato({ animais: [...animais(20, 2), ...animais(20, 1, { situacao: 'morto' })] })

    expect(() => planejarEdicaoDoEstoque(caixa, { sexo: 'M' })).toThrow(
      noCampo('sexo', '1 fêmea desta caixa já saiu dela (baixa ou entrega)'),
    )
  })

  it('com reservado recusa: o pedido conta pelo sexo', () => {
    const caixa = retrato({ animais: [...animais(20, 2), ...animais(20, 2, { idPedido: 7 })] })

    expect(() => planejarEdicaoDoEstoque(caixa, { sexo: 'M' })).toThrow(
      noCampo('sexo', '2 fêmeas desta caixa estão reservadas (pedido #7)'),
    )
  })

  it('com animais de casal recusa', () => {
    const caixa = retrato({ animais: animais(30, 2), partos: [doCasal(30)] })

    expect(() => planejarEdicaoDoEstoque(caixa, { sexo: 'M' })).toThrow(noCampo('sexo', 'o sexo deles vem do casal'))
  })
})

describe('o nascimento do cadastro inicial', () => {
  it('muda a ninhada sem casal, ate o dia da entrada no estoque', () => {
    const plano = planejarEdicaoDoEstoque(retrato(), { nascimentos: [{ idParto: 20, dtNascimento: '2026-11-10' }] })

    expect(plano).toMatchObject({
      nascimentos: [{ idParto: 20, antes: '2026-09-01', depois: '2026-11-10' }],
      descricao: 'Caixa de estoque F2A editada: nascimento do cadastro inicial 01/09/2026 → 10/11/2026',
    })
  })

  it('depois da entrada recusa, no campo da ninhada', () => {
    expect(() => planejarEdicaoDoEstoque(retrato(), { nascimentos: [{ idParto: 20, dtNascimento: '2026-11-11' }] })).toThrow(
      noCampo('nascimentos.0.dtNascimento', 'Não pode ser depois da entrada no estoque (10/11/2026).'),
    )
  })

  it('o parto de casal nao se corrige aqui, e a ninhada de fora da caixa nao existe para ela', () => {
    const caixa = retrato({ animais: [...animais(20, 1), ...animais(30, 3)], partos: [cadastro(20), doCasal(30)] })

    expect(() =>
      planejarEdicaoDoEstoque(caixa, {
        nascimentos: [
          { idParto: 20, dtNascimento: '2026-09-02' },
          { idParto: 30, dtNascimento: '2026-09-20' },
        ],
      }),
    ).toThrow(noCampo('nascimentos.1.dtNascimento', '3 do 1º parto do casal AB, caixa T1I: o nascimento deles é o do parto'))
    expect(() => planejarEdicaoDoEstoque(caixa, { nascimentos: [{ idParto: 99, dtNascimento: '2026-09-02' }] })).toThrow(
      noCampo('nascimentos.0.dtNascimento', 'não tem animais nesta caixa'),
    )
  })

  it('a caixa com animais de casal ainda corrige o nascimento do que veio do cadastro', () => {
    const caixa = retrato({ animais: [...animais(20, 1), ...animais(30, 3)], partos: [cadastro(20), doCasal(30)] })

    expect(planejarEdicaoDoEstoque(caixa, { nascimentos: [{ idParto: 20, dtNascimento: '2026-09-02' }] })).toMatchObject({
      nascimentos: [{ idParto: 20, antes: '2026-09-01', depois: '2026-09-02' }],
    })
  })

  it('o sexo trocado junto com o nascimento leva a data nova na correcao', () => {
    const plano = planejarEdicaoDoEstoque(retrato(), { sexo: 'M', nascimentos: [{ idParto: 20, dtNascimento: '2026-09-03' }] })

    expect(plano?.trocas).toEqual([{ idParto: 20, ids: [100, 101, 102], dtNascimento: '2026-09-03' }])
    expect(plano?.descricao).toBe(
      'Caixa de estoque F2A editada: fêmeas → machos, nascimento do cadastro inicial 01/09/2026 → 03/09/2026',
    )
  })
})

// ------------------------------------------------------------------ a gravacao

const banco = vi.hoisted(() => ({
  ordem: [] as string[],
  lancamentos: [] as unknown[],
  historicos: [] as Record<string, unknown>[],
  caixa: null as Record<string, unknown> | null,
  animais: [] as Record<string, unknown>[],
  partos: [] as Record<string, unknown>[],
}))

const db = {
  $queryRaw: async () => [],
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  caixa: {
    findUnique: async () => banco.caixa,
    findMany: async () => [],
    update: async ({ data }: { data: Record<string, unknown> }) => {
      banco.ordem.push(`caixa ${JSON.stringify({ ...data, dtManutencao: undefined })}`)
    },
  },
  animal: {
    findMany: async () => banco.animais,
    groupBy: async () => [],
  },
  parto: {
    findMany: async () => banco.partos,
    update: async ({ where, data }: { where: { id: number }; data: { dtPartoReal: Date } }) => {
      banco.ordem.push(`parto ${where.id} nascimento ${data.dtPartoReal.toISOString().slice(0, 10)}`)
    },
    updateMany: async ({ where, data }: { where: { id: { in: number[] } }; data: { idLinhagem: number } }) => {
      banco.ordem.push(`partos ${where.id.in.join(',')} linhagem ${data.idLinhagem}`)
    },
  },
  linhagem: { findUnique: async () => ({ id: 5, nome: 'SHR', idEspecie: 1 }) },
  pedido: { findMany: async () => [] },
  historico: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      banco.historicos.push(data)
    },
  },
}

vi.mock('../../shared/prisma.ts', () => ({
  prisma: new Proxy({}, { get: (_prisma, chave) => db[chave as keyof typeof db] }),
}))

vi.mock('../colonia/ocorrencia.ts', () => ({
  lancarOcorrencia: async (_tx: unknown, lancamento: Lancamento) => {
    banco.ordem.push(`correcao ${lancamento.tipo}`)
    banco.lancamentos.push(lancamento)
    return { idOcorrencia: 1, ids: [] }
  },
}))

vi.mock('./ficha.service.ts', () => ({ montarFicha: async (id: number) => ({ tipo: 'estoque', caixa: { id } }) }))

describe('a gravacao', () => {
  beforeEach(() => {
    banco.ordem = []
    banco.lancamentos = []
    banco.historicos = []
    banco.caixa = { codigo: 'F2A', ativa: true, tipo: 'estoque', sexo: 'F', idEspecie: 1, idLinhagem: 3, linhagem: { nome: 'Wistar' } }
    banco.animais = [
      { id: 200, idParto: 20, sexo: 'F', situacao: 'vivo', idPedido: null },
      { id: 201, idParto: 20, sexo: 'F', situacao: 'vivo', idPedido: null },
    ]
    banco.partos = [{ id: 20, ordem: null, dtPartoReal: d('2026-09-01'), dtDesmameReal: d('2026-11-10'), casal: null }]
  })

  it('o nascimento e a linhagem da ninhada, a caixa e por ultimo o sexo dos vivos, que o trigger confere com a caixa', async () => {
    const ficha = await editarCaixaDeEstoque(
      2,
      { idLinhagem: 5, sexo: 'M', nascimentos: [{ idParto: 20, dtNascimento: '2026-09-05' }] },
      4,
    )

    expect(ficha).toEqual({ tipo: 'estoque', caixa: { id: 2 } })
    expect(banco.ordem).toEqual([
      'parto 20 nascimento 2026-09-05',
      'partos 20 linhagem 5',
      'caixa {"idLinhagem":5,"sexo":"M"}',
      'correcao correcao',
    ])
    expect(banco.lancamentos).toEqual([
      expect.objectContaining({
        tipo: 'correcao',
        idParto: 20,
        dtFato: '2026-09-05',
        idUsuario: 4,
        trocaDeSexo: { ids: [200, 201], para: 'M' },
      }),
    ])
    expect(banco.historicos).toEqual([
      expect.objectContaining({
        entidade: 'caixa',
        idEntidade: 2,
        acao: 'edicao_estoque',
        descricao:
          'Caixa de estoque F2A editada: linhagem Wistar → SHR, fêmeas → machos, nascimento do cadastro inicial 01/09/2026 → 05/09/2026',
        dados: {
          antes: { idLinhagem: 3, sexo: 'F', nascimentos: [{ idParto: 20, dtNascimento: '2026-09-01' }] },
          depois: { idLinhagem: 5, sexo: 'M', nascimentos: [{ idParto: 20, dtNascimento: '2026-09-05' }] },
          partos: [20],
        },
      }),
    ])
  })

  it('sem mudanca nao grava nem registra', async () => {
    await editarCaixaDeEstoque(2, { idLinhagem: 3, sexo: 'F' }, 4)

    expect(banco.ordem).toEqual([])
    expect(banco.historicos).toEqual([])
  })

  it('a caixa liberada e a de casal nao se editam aqui', async () => {
    banco.caixa = { ...banco.caixa, ativa: false }
    await expect(editarCaixaDeEstoque(2, { sexo: 'M' }, 4)).rejects.toEqual(expect.objectContaining({ codigo: 'CAIXA_LIBERADA' }))

    banco.caixa = { codigo: 'T1I', ativa: true, tipo: 'casal', sexo: null, idEspecie: 1, idLinhagem: null, linhagem: null }
    await expect(editarCaixaDeEstoque(2, { sexo: 'M' }, 4)).rejects.toEqual(
      expect.objectContaining({ codigo: 'SEQUENCIA_INVALIDA', message: expect.stringContaining('lápis da ficha dele') }),
    )
  })
})
