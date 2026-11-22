import { beforeEach, describe, expect, it, vi } from 'vitest'
import { montarGrade } from './infra.service.ts'

// A grade com o banco de mentira: as caixas que cada teste deixa em 'banco' e os vivos delas. A
// fase de cada caixa sai dos animais, nada vem gravado

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const banco = vi.hoisted(() => ({
  caixas: [] as Record<string, unknown>[],
  linhas: [] as Record<string, unknown>[],
  onde: null as unknown,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    especie: { findMany: async () => [{ id: 1, nome: 'Rato' }] },
    estante: { findFirst: async () => ({ id: 1, faces: 1, linhas: 1, colunas: 3 }) },
    caixa: {
      findMany: async ({ where }: { where: unknown }) => {
        banco.onde = where
        return banco.caixas
      },
    },
    animal: { groupBy: async () => banco.linhas },
    parto: {
      findMany: async () => [
        {
          id: 4,
          ordem: 1,
          dtPartoReal: d('2026-09-01'),
          dtDesmameReal: d('2026-09-23'),
          casal: { identificacao: 'AB', idLinhagem: 3, caixa: { id: 1, codigo: 'F1A', estante: { numeroVisivel: 'E1' } } },
        },
      ],
    },
  },
}))

const caixa = (id: number, campos: Record<string, unknown> = {}) => ({
  id,
  face: 1,
  linha: 1,
  coluna: id,
  codigo: `F1${'ABC'[id - 1]}`,
  tipo: 'estoque',
  sexo: 'F',
  idLinhagem: 3,
  ativa: true,
  dtLiberacao: null,
  motivoLiberacao: null,
  estante: { numeroVisivel: 'E1' },
  linhagem: { nome: 'Wistar' },
  casais: [],
  ...campos,
})

const casal = {
  identificacao: 'AB',
  ativo: true,
  idLinhagem: 5,
  linhagem: { nome: 'Kyoto' },
  partos: [{ ordem: 1, dtAcasalamento: d('2026-08-09'), dtPartoReal: d('2026-09-01'), dtSemNinhada: null }],
}

const vivos = (idCaixa: number, sexo: string, idPedido: number | null, qtd: number) => ({
  idCaixa,
  idParto: 4,
  sexo,
  idPedido,
  _count: { _all: qtd },
})

beforeEach(() => {
  banco.caixas = []
  banco.linhas = []
  banco.onde = null
})

describe('a grade da estante', () => {
  it('cada posicao com o codigo da etiqueta; a ocupada traz a fase, a linhagem e o card da caixa', async () => {
    banco.caixas = [caixa(2)]
    banco.linhas = [vivos(2, 'F', null, 3), vivos(2, 'F', 9, 1)]

    const grade = await montarGrade(1)
    const [face] = grade.faces

    expect(face?.face).toBe('frontal')
    expect(face?.posicoes.map((p) => p.codigo)).toEqual(['F1A', 'F1B', 'F1C'])
    expect(face?.posicoes[0]?.caixa).toBeNull()
    expect(face?.posicoes[1]?.caixa).toEqual({
      id: 2,
      tipo: 'estoque',
      fase: 'estoque',
      atrasado: false,
      idLinhagem: 3,
      linhagem: 'Wistar',
      casal: null,
      // a MiniGrade filtra os destinos da mudanca pelo sexo e pela linhagem
      estoque: expect.objectContaining({ sexo: 'F', idLinhagem: 3, total: 4, reservado: 1 }),
      viuvas: null,
    })
    expect(banco.onde).toEqual({ idEstante: 1, ativa: true })
  })

  it('a caixa do casal traz a linhagem do casal, para a grade filtrar por ela, e a fase dos animais dela', async () => {
    banco.caixas = [caixa(1, { tipo: 'casal', sexo: null, idLinhagem: null, linhagem: null, casais: [casal] })]
    banco.linhas = [vivos(1, 'M', 9, 5)]

    const grade = await montarGrade(1)

    expect(grade.faces[0]?.posicoes[0]?.caixa).toMatchObject({
      // os vivos do parto ja desmamaram e continuam na caixa do casal
      fase: 'pronto_estoque',
      atrasado: false,
      idLinhagem: 5,
      linhagem: 'Kyoto',
      casal: { identificacao: 'AB', reservado: 5 },
      estoque: null,
    })
  })
})
