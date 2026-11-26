import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hojeISO } from '../../shared/traducao.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { criarCaixaDeEstoque, exigirIdadeDoEstoque } from './entrada.service.ts'

// O cadastro inicial do estoque contra um banco de mentira: a caixa nova, a ninhada sem casal, os
// animais e a ocorrencia de entrada. O lancamento da ocorrencia e o de verdade (colonia/ocorrencia.ts)

type Caixa = {
  id: number
  codigo: string
  ativa: boolean
  tipo: string
  sexo: string | null
  idEspecie: number
  idLinhagem: number | null
  idEstante?: number
  face?: number
  linha?: number
  coluna?: number
}

const banco = vi.hoisted(() => ({
  caixas: new Map<number, Caixa>(),
  linhagens: new Map<number, { id: number; idEspecie: number; nome: string; ativa: boolean }>(),
  /** a caixa ativa que ocupa a posicao, se houver */
  ocupante: null as { id: number } | null,
  partos: [] as Record<string, unknown>[],
  animais: [] as Record<string, unknown>[],
  ocorrencias: [] as Record<string, unknown>[],
  travadas: [] as unknown[],
  proximoId: 100,
}))

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const db = {
  $queryRaw: async (...args: unknown[]) => {
    banco.travadas.push(args)
    return []
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  linhagem: { findUnique: async ({ where }: { where: { id: number } }) => banco.linhagens.get(where.id) ?? null },
  estante: { findFirst: async () => ({ id: 1, numeroVisivel: 'E1', formato: { faces: 2, linhas: 3, colunas: 3 } }) },
  caixa: {
    findFirst: async () => banco.ocupante,
    findUnique: async ({ where }: { where: { id: number } }) => {
      const caixa = banco.caixas.get(where.id)
      if (caixa === undefined) return null
      return { ...caixa, linhagem: caixa.idLinhagem === null ? null : (banco.linhagens.get(caixa.idLinhagem) ?? null) }
    },
    create: async ({ data }: { data: Omit<Caixa, 'id' | 'codigo' | 'ativa'> }) => {
      // o codigo vem do trigger da posicao
      const caixa = { id: banco.proximoId++, codigo: `F${data.linha}B`, ativa: true, ...data }
      banco.caixas.set(caixa.id, caixa)
      return { id: caixa.id, codigo: caixa.codigo }
    },
  },
  parto: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const parto = { id: banco.proximoId++, ...data }
      banco.partos.push(parto)
      return { id: parto.id }
    },
  },
  animal: {
    createManyAndReturn: async ({ data }: { data: Record<string, unknown>[] }) =>
      data.map((animal) => {
        const criado = { id: banco.proximoId++, ...animal }
        banco.animais.push(criado)
        return { id: criado.id }
      }),
  },
  ocorrencia: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const ocorrencia = { id: banco.proximoId++, ...data }
      banco.ocorrencias.push(ocorrencia)
      return { id: ocorrencia.id }
    },
  },
}

// o vi.mock sobe para o topo do arquivo, antes de 'db' existir: o Prisma le 'db' so na hora do uso
vi.mock('../../shared/prisma.ts', () => ({
  prisma: new Proxy({}, { get: (_prisma, chave) => db[chave as keyof typeof db] }),
}))

/** hoje, em Brasilia, como o servico le */
const hoje = hojeISO()
const nascidoHa = (dias: number) => somarDias(hoje, -dias)

const posicao = { idEstante: 1, face: 'frontal' as const, linha: 2, coluna: 2 }
const nova = { posicao, idLinhagem: 3, sexo: 'M' as const, quantidade: 6, dtNascimento: nascidoHa(35) }

const noCampo = (campo: string, trecho: string) =>
  expect.objectContaining({ status: 400, extras: { campos: { [campo]: expect.stringContaining(trecho) } } })

beforeEach(() => {
  banco.caixas = new Map([
    [7, { id: 7, codigo: 'F3C', ativa: true, tipo: 'estoque', sexo: 'F', idEspecie: 1, idLinhagem: 3 }],
    [8, { id: 8, codigo: 'F1A', ativa: true, tipo: 'casal', sexo: null, idEspecie: 1, idLinhagem: null }],
    [9, { id: 9, codigo: 'F2C', ativa: false, tipo: 'estoque', sexo: 'M', idEspecie: 1, idLinhagem: 3 }],
    [10, { id: 10, codigo: 'T1A', ativa: true, tipo: 'estoque', sexo: 'M', idEspecie: 1, idLinhagem: 4 }],
  ])
  banco.linhagens = new Map([
    [3, { id: 3, idEspecie: 1, nome: 'Wistar', ativa: true }],
    [4, { id: 4, idEspecie: 1, nome: 'Kyoto', ativa: false }],
  ])
  banco.ocupante = null
  banco.partos = []
  banco.animais = []
  banco.ocorrencias = []
  banco.travadas = []
  banco.proximoId = 100
})

describe('a caixa de estoque do cadastro inicial', () => {
  it('nasce na posicao vazia, com a ninhada sem casal, os animais vivos e a ocorrencia de entrada', async () => {
    const resposta = await criarCaixaDeEstoque(nova, 4)

    expect(resposta).toEqual({ idCaixa: 100, codigo: 'F2B' })
    expect(banco.caixas.get(100)).toMatchObject({
      tipo: 'estoque',
      sexo: 'M',
      idLinhagem: 3,
      idEspecie: 1,
      idEstante: 1,
      face: 1,
      linha: 2,
      coluna: 2,
    })

    // a ninhada sem casal: sem casal, ordem e acasalamento, nascida na data e desmamada hoje
    expect(banco.partos).toEqual([
      expect.objectContaining({
        id: 101,
        idLinhagem: 3,
        dtPartoReal: d(nascidoHa(35)),
        dtDesmameReal: d(hoje),
        idUsuarioParto: 4,
        idUsuarioDesmame: 4,
      }),
    ])
    expect(banco.partos[0]).not.toHaveProperty('idCasal')
    expect(banco.partos[0]).not.toHaveProperty('ordem')
    expect(banco.partos[0]).not.toHaveProperty('dtAcasalamento')

    // seis machos vivos na caixa nova, chegados hoje
    expect(banco.animais).toHaveLength(6)
    expect(banco.animais.every((a) => a.idParto === 101 && a.sexo === 'M' && a.idCaixa === 100)).toBe(true)
    expect(banco.animais.every((a) => (a.dtMovimento as Date).getTime() === d(hoje).getTime())).toBe(true)

    expect(banco.ocorrencias).toEqual([
      expect.objectContaining({
        tipo: 'entrada',
        dtFato: d(hoje),
        idUsuario: 4,
        idParto: 101,
        idCaixaDestino: 100,
        animais: { createMany: { data: banco.animais.map((a) => ({ idAnimal: a.id })) } },
      }),
    ])
  })

  it('femeas entram como femeas', async () => {
    await criarCaixaDeEstoque({ ...nova, sexo: 'F', quantidade: 2 }, 4)

    expect(banco.animais.map((a) => a.sexo)).toEqual(['F', 'F'])
    expect(banco.caixas.get(100)).toMatchObject({ sexo: 'F' })
  })

  it('a posicao ocupada e recusada no campo, e nada e criado', async () => {
    banco.ocupante = { id: 7 }

    await expect(criarCaixaDeEstoque(nova, 4)).rejects.toEqual(noCampo('posicao', 'já tem uma caixa ativa'))
    expect(banco.partos).toEqual([])
    expect(banco.animais).toEqual([])
  })

  it('a linhagem inativa nao recebe animais novos, e a que nao existe e 404', async () => {
    await expect(criarCaixaDeEstoque({ ...nova, idLinhagem: 4 }, 4)).rejects.toEqual(noCampo('idLinhagem', 'inativa'))
    await expect(criarCaixaDeEstoque({ ...nova, idLinhagem: 99 }, 4)).rejects.toEqual(expect.objectContaining({ status: 404 }))
  })

  it('animal com menos de 21 dias e recusado: estoque e de desmamados', async () => {
    await expect(criarCaixaDeEstoque({ ...nova, dtNascimento: nascidoHa(20) }, 4)).rejects.toEqual(
      noCampo('dtNascimento', 'os animais têm 20 dias: a caixa de estoque só recebe desmamados, com 21 dias ou mais'),
    )
    expect(banco.caixas.size).toBe(4)
  })
})

describe('a idade do estoque', () => {
  it('21 dias entra; 20 nao, com a data limite na mensagem', () => {
    expect(() => exigirIdadeDoEstoque('2026-10-21', '2026-11-11')).not.toThrow()
    expect(() => exigirIdadeDoEstoque('2026-10-22', '2026-11-11')).toThrow()

    let recusada: unknown = null
    try {
      exigirIdadeDoEstoque('2026-11-10', '2026-11-11')
    } catch (erro) {
      recusada = erro
    }
    expect(recusada).toEqual(
      noCampo(
        'dtNascimento',
        'Nascidos em 10/11/2026, os animais têm 1 dia: a caixa de estoque só recebe desmamados, com 21 dias ou mais (nascidos até 21/10/2026).',
      ),
    )
  })
})
