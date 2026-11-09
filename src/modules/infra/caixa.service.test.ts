import { beforeEach, describe, expect, it, vi } from 'vitest'
import { montarQuadro } from './caixa.service.ts'
import { montarGrade } from './infra.service.ts'

// O Kanban e a grade com o banco de mentira: as caixas que cada teste deixa em 'banco' e os vivos
// delas. A coluna de cada caixa sai dos animais, nada vem gravado

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const hoje = '2026-11-08'

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
  linhagem: { nome: 'Wistar' },
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

describe('o Kanban', () => {
  it('as quatro colunas sempre aparecem, na ordem da tela, mesmo vazias', async () => {
    const quadro = await montarQuadro('rato', hoje)

    expect(quadro.colunas.map((coluna) => coluna.estado)).toEqual(['livres', 'estoque', 'reserva', 'enviado'])
    expect(quadro.colunas.every((coluna) => coluna.cards.length === 0)).toBe(true)
  })

  it('le as caixas ativas da especie e as que a entrega esvaziou desde o comeco da semana de Enviado', async () => {
    await montarQuadro('rato', hoje)

    expect(banco.onde).toEqual({
      idEspecie: 1,
      OR: [{ ativa: true }, { motivoLiberacao: 'entrega', dtLiberacao: { gte: d('2026-11-01') } }],
    })
  })

  it('cada caixa na coluna que os animais dela dao', async () => {
    banco.caixas = [
      caixa(1, { tipo: 'casal', sexo: null, idLinhagem: null, linhagem: null, casais: [casal] }),
      caixa(2),
      caixa(3, { ativa: false, motivoLiberacao: 'entrega', dtLiberacao: d('2026-11-03') }),
    ]
    banco.linhas = [vivos(1, 'M', 9, 5), vivos(2, 'F', 9, 4)]

    const quadro = await montarQuadro('rato', hoje)
    const porColuna = Object.fromEntries(quadro.colunas.map((c) => [c.estado, c.cards.map((card) => card.codigo)]))

    // a de casal fica em Livres mesmo com todos reservados; a de estoque toda reservada, em Reserva
    expect(porColuna).toEqual({ livres: ['F1A'], estoque: [], reserva: ['F1B'], enviado: ['F1C'] })
    expect(quadro.colunas[0]?.cards[0]).toMatchObject({
      idCaixa: 1,
      numeroVisivel: 'E1',
      linhagem: 'Wistar',
      casal: { identificacao: 'AB', reservado: 5 },
      estoque: null,
    })
    expect(quadro.colunas[2]?.cards[0]).toMatchObject({ casal: null, estoque: { sexo: 'F', total: 4, reservado: 4 } })
  })

  it('a caixa liberada por baixa ou mudanca nao aparece', async () => {
    banco.caixas = [caixa(1, { ativa: false, motivoLiberacao: 'mudanca', dtLiberacao: d('2026-11-07') })]

    const quadro = await montarQuadro('rato', hoje)

    expect(quadro.colunas.flatMap((c) => c.cards)).toEqual([])
  })
})

describe('a grade da estante', () => {
  it('cada posicao com o codigo da etiqueta; a ocupada traz a coluna, a linhagem e o card da caixa', async () => {
    banco.caixas = [caixa(2)]
    banco.linhas = [vivos(2, 'F', null, 3), vivos(2, 'F', 9, 1)]

    const grade = await montarGrade(1)
    const [face] = grade.faces

    expect(face?.face).toBe('frontal')
    expect(face?.posicoes.map((p) => p.codigo)).toEqual(['F1A', 'F1B', 'F1C'])
    expect(face?.posicoes[0]?.caixa).toBeNull()
    expect(face?.posicoes[1]?.caixa).toEqual({
      id: 2,
      estado: 'estoque',
      linhagem: 'Wistar',
      casal: null,
      // a MiniGrade filtra os destinos da mudanca pelo sexo e pela linhagem
      estoque: expect.objectContaining({ sexo: 'F', idLinhagem: 3, total: 4, reservado: 1 }),
    })
    expect(banco.onde).toEqual({ idEstante: 1, ativa: true })
  })
})
