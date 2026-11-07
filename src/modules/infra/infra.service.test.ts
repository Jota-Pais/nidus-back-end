import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alterarEstante, cadastrarEstante, removerEstante } from './infra.service.ts'
import type { NovaEstante } from './infra.service.ts'

// Cadastro, edicao e remocao de estante, com o banco de mentira: o que importa e o que cada
// regra consulta e grava

type Linha = Record<string, unknown>

const banco = vi.hoisted(() => ({
  salas: [] as { id: number; nome: string; ativa: boolean }[],
  estante: null as Linha | null,
  mesmoNumero: null as Linha | null,
  caixas: 0,
  numeroConsultado: null as Linha | null,
  caixasConsultadas: null as Linha | null,
  gravado: null as Linha | null,
  historico: [] as Linha[],
}))

vi.mock('../../shared/prisma.ts', () => {
  const nomeDaSala = (idSala: unknown) => ({
    nome: banco.salas.find((sala) => sala.id === idSala)?.nome ?? '?',
  })

  return {
    prisma: {
      sala: {
        findFirst: async ({ where }: { where: { id: number } }) =>
          banco.salas.find((sala) => sala.id === where.id && sala.ativa) ?? null,
      },
      estante: {
        // a mesma consulta serve a "estante ativa pelo id" e a "numero ja usado na sala"
        findFirst: async ({ where }: { where: Linha }) => {
          if ('numeroVisivel' in where) {
            banco.numeroConsultado = where
            return banco.mesmoNumero
          }
          return banco.estante
        },
      },
      caixa: {
        count: async ({ where }: { where: Linha }) => {
          banco.caixasConsultadas = where
          return banco.caixas
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          estante: {
            create: async ({ data }: { data: Linha }) => {
              banco.gravado = data
              return { id: 9, ...data, sala: nomeDaSala(data.idSala) }
            },
            update: async ({ data }: { data: Linha }) => {
              banco.gravado = data
              const linha = { ...banco.estante, ...data }
              return { ...linha, sala: nomeDaSala(linha.idSala) }
            },
          },
          historico: {
            create: async ({ data }: { data: Linha }) => {
              banco.historico.push(data)
              return {}
            },
          },
        }),
    },
  }
})

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

const nova: NovaEstante = {
  idSala: 2,
  fabricante: 'ALESCO',
  modelo: 'Modelo 2',
  numeroVisivel: 'E-05',
  faces: 2,
  linhas: 5,
  colunas: 5,
}

beforeEach(() => {
  banco.salas = [
    { id: 1, nome: 'Sala 1', ativa: true },
    { id: 2, nome: 'Sala 2', ativa: true },
    { id: 3, nome: 'Sala velha', ativa: false },
  ]
  banco.estante = {
    id: 4,
    idSala: 1,
    sala: { nome: 'Sala 1' },
    fabricante: 'ALESCO',
    modelo: 'Modelo 1',
    numeroVisivel: 'E-01',
    faces: 2,
    linhas: 8,
    colunas: 8,
  }
  banco.mesmoNumero = null
  banco.caixas = 0
  banco.numeroConsultado = null
  banco.caixasConsultadas = null
  banco.gravado = null
  banco.historico = []
})

describe('cadastro de estante', () => {
  it('grava com a capacidade derivada e devolve o nome da sala', async () => {
    await expect(cadastrarEstante(nova, 1)).resolves.toMatchObject({ id: 9, idSala: 2, sala: 'Sala 2' })
    expect(banco.gravado).toMatchObject({ idSala: 2, capacidade: 50 })
    expect(banco.historico).toEqual([
      expect.objectContaining({ entidade: 'estante', acao: 'cadastro', descricao: 'Estante E-05 cadastrada na Sala 2' }),
    ])
  })

  it('sala removida e campo invalido', async () => {
    await expect(cadastrarEstante({ ...nova, idSala: 3 }, 1)).rejects.toEqual(recusa(400, 'VALIDACAO'))
    expect(banco.gravado).toBeNull()
  })

  it('numero ja usado na sala e recusado, com o nome da sala', async () => {
    banco.mesmoNumero = { id: 5 }

    await expect(cadastrarEstante(nova, 1)).rejects.toThrow('Ja existe a estante E-05 na sala Sala 2.')
    expect(banco.numeroConsultado).toEqual({ idSala: 2, numeroVisivel: 'E-05', ativa: true })
  })
})

describe('edicao de estante', () => {
  it('muda numero e sala, e confere o numero na sala de destino sem contar a propria estante', async () => {
    await expect(alterarEstante(4, { numeroVisivel: 'E-09', idSala: 2 }, 1)).resolves.toMatchObject({
      numeroVisivel: 'E-09',
      idSala: 2,
      sala: 'Sala 2',
    })
    expect(banco.numeroConsultado).toEqual({ idSala: 2, numeroVisivel: 'E-09', ativa: true, id: { not: 4 } })
    expect(banco.historico[0]).toMatchObject({
      acao: 'alteracao',
      dados: {
        antes: { numeroVisivel: 'E-01', sala: 'Sala 1' },
        depois: { numeroVisivel: 'E-09', sala: 'Sala 2' },
      },
    })
  })

  it('o modelo nao muda: so numero, sala e a data de manutencao sao gravados', async () => {
    await alterarEstante(4, { numeroVisivel: 'E-07' }, 1)

    expect(Object.keys(banco.gravado ?? {}).sort()).toEqual(['dtManutencao', 'idSala', 'numeroVisivel'])
    expect(banco.gravado).toMatchObject({ numeroVisivel: 'E-07', idSala: 1 })
  })

  it('numero ja usado na sala de destino e recusado', async () => {
    banco.mesmoNumero = { id: 6 }

    await expect(alterarEstante(4, { idSala: 2 }, 1)).rejects.toEqual(recusa(409, 'ESTANTE_DUPLICADA'))
    expect(banco.gravado).toBeNull()
  })

  it('sala de destino removida e campo invalido', async () => {
    await expect(alterarEstante(4, { idSala: 3 }, 1)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('estante removida nao se edita', async () => {
    banco.estante = null

    await expect(alterarEstante(4, { numeroVisivel: 'E-09' }, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})

describe('remocao de estante', () => {
  it('conta como ocupada a posicao com caixa ativa, como a grade', async () => {
    await removerEstante(4, 1)

    expect(banco.caixasConsultadas).toEqual({ idEstante: 4, ativa: true })
  })

  it('estante com caixa nao sai', async () => {
    banco.caixas = 3

    await expect(removerEstante(4, 1)).rejects.toEqual(recusa(409, 'ESTANTE_OCUPADA'))
    await expect(removerEstante(4, 1)).rejects.toThrow('A estante E-01 ainda tem 3 caixas.')
    expect(banco.gravado).toBeNull()
  })

  it('estante vazia fica inativa, nao e apagada, e vai para o historico', async () => {
    await expect(removerEstante(4, 1)).resolves.toBeUndefined()

    expect(banco.gravado).toMatchObject({ ativa: false })
    expect(banco.historico[0]).toMatchObject({
      entidade: 'estante',
      idEntidade: 4,
      acao: 'remocao',
      descricao: 'Estante E-01 removida da Sala 1',
    })
  })

  it('estante ja removida da 404', async () => {
    banco.estante = null

    await expect(removerEstante(4, 1)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
