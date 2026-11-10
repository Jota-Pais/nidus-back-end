import { beforeEach, describe, expect, it, vi } from 'vitest'
import { baixasDaCaixa } from './baixasDaFicha.ts'

// As baixas lancadas da ficha com o banco de mentira: a caixa 7, que virou de estoque de femeas.
// So a baixa que ainda pode ser anulada entra, da mais recente para a mais antiga

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const registro = (iso: string) => new Date(`${iso}T15:00:00.000Z`)

const banco = vi.hoisted(() => ({
  ocorrencias: [] as unknown[],
  ondeOcorrencias: null as unknown,
  ordemOcorrencias: null as unknown,
  /** os animais de cada baixa anulavel (ocorrencia_animal) e a caixa onde ela aconteceu */
  ligacoes: [] as unknown[],
  ondeLigacoes: null as unknown,
  caixasDaBaixa: [] as unknown[],
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: { findMany: async () => banco.caixasDaBaixa },
    ocorrenciaAnimal: {
      findMany: async ({ where }: { where: unknown }) => {
        banco.ondeLigacoes = where
        return banco.ligacoes
      },
    },
    // a caixa de casal da baixa sem outra ninhada viva
    animal: { groupBy: async () => [] },
    ocorrencia: {
      findMany: async ({ where, orderBy }: { where: unknown; orderBy: unknown }) => {
        banco.ondeOcorrencias = where
        banco.ordemOcorrencias = orderBy
        return banco.ocorrencias
      },
    },
  },
}))

const animais = (m: number, f: number, idCaixa = 7) => [
  ...Array.from({ length: m }, () => ({ animal: { sexo: 'M', idCaixa } })),
  ...Array.from({ length: f }, () => ({ animal: { sexo: 'F', idCaixa } })),
]

const baixa = (id: number, dia: string, campos: Record<string, unknown> = {}) => ({
  id,
  tipo: 'baixa',
  dtFato: d(dia),
  dtRegistro: registro(dia),
  idCaixaOrigem: 7,
  idCaixaDestino: null,
  idPedido: null,
  motivo: 'eutanasia de selecao',
  usuario: { nome: 'Ana' },
  parto: { ordem: 1, casal: { identificacao: 'AB' } },
  caixaOrigem: null,
  caixaDestino: null,
  anulacoes: [],
  animais: animais(1, 1),
  ...campos,
})

/** Um animal de baixa anulavel, como a anulacao le: desmamado e da linhagem 3 */
const daBaixa = (idOcorrencia: number, id: number, sexo: string) => ({
  idOcorrencia,
  animal: { id, sexo, idPedido: null, idParto: 10, parto: { dtDesmameReal: d('2026-09-23'), casal: { idLinhagem: 3 } } },
})

/** A caixa 7 hoje: virou de estoque de femeas da linhagem 3 */
const caixa7 = (campos: Record<string, unknown> = {}) => ({ id: 7, codigo: 'F1A', ativa: true, tipo: 'estoque', sexo: 'F', idLinhagem: 3, ...campos })

beforeEach(() => {
  banco.ligacoes = [daBaixa(2, 101, 'M'), daBaixa(2, 102, 'F')]
  banco.ondeLigacoes = null
  banco.caixasDaBaixa = [caixa7()]
  // da mais recente para a mais antiga, como o banco devolve
  banco.ocorrencias = [
    baixa(3, '2026-09-23', { motivo: 'nao chegou ao desmame', animais: animais(0, 1), anulacoes: [{ id: 9 }] }),
    baixa(2, '2026-09-05'),
  ]
})

describe('as baixas lancadas da ficha', () => {
  it('so a baixa que ainda pode ser anulada, com o formato que o botao Anular usa', async () => {
    const baixas = await baixasDaCaixa(7)

    expect(baixas).toEqual([
      {
        dataHora: '2026-09-05T00:00:00.000Z',
        tipo: 'baixa',
        descricao: 'Eutanásia de seleção do 1º parto do casal AB: 1 macho e 1 fêmea.',
        autor: 'Ana',
        idOcorrencia: 2,
        anulavel: true,
        // a caixa virou estoque de femeas: o macho da selecao nao volta para ela
        baixa: { sexos: { m: 1, f: 1 }, idLinhagem: 3, voltaNaOrigem: false },
      },
    ])
    // so a baixa anulavel e lida
    expect(banco.ondeLigacoes).toEqual({ idOcorrencia: { in: [2] } })
  })

  it('le so as baixas da caixa, da mais recente para a mais antiga', async () => {
    banco.ocorrencias = [baixa(4, '2026-09-30'), baixa(2, '2026-09-05')]
    banco.ligacoes = [daBaixa(4, 103, 'F'), daBaixa(2, 102, 'F')]

    expect((await baixasDaCaixa(7)).map((b) => b.idOcorrencia)).toEqual([4, 2])
    expect(banco.ondeOcorrencias).toEqual({ tipo: 'baixa', OR: [{ idCaixaOrigem: 7 }, { idCaixaDestino: 7 }] })
    expect(banco.ordemOcorrencias).toEqual([{ dtFato: 'desc' }, { id: 'desc' }])
  })

  it('sem baixa a anular, a lista vem vazia e nada mais e lido', async () => {
    banco.ocorrencias = [baixa(3, '2026-09-23', { anulacoes: [{ id: 9 }] })]

    expect(await baixasDaCaixa(7)).toEqual([])
    expect(banco.ondeLigacoes).toBeNull()
  })

  it('diz se a caixa da baixa ainda recebe a volta dos animais', async () => {
    // so a femea: o estoque de femeas da linhagem dela a recebe
    banco.ligacoes = [daBaixa(2, 102, 'F')]
    expect((await baixasDaCaixa(7))[0]?.baixa).toEqual({ sexos: { m: 0, f: 1 }, idLinhagem: 3, voltaNaOrigem: true })

    // a caixa liberada nao recebe ninguem
    banco.caixasDaBaixa = [caixa7({ ativa: false })]
    expect((await baixasDaCaixa(7))[0]?.baixa?.voltaNaOrigem).toBe(false)

    // a de casal sem outra ninhada viva recebe os dois sexos
    banco.ligacoes = [daBaixa(2, 101, 'M'), daBaixa(2, 102, 'F')]
    banco.caixasDaBaixa = [caixa7({ tipo: 'casal', sexo: null, idLinhagem: null })]
    expect((await baixasDaCaixa(7))[0]?.baixa?.voltaNaOrigem).toBe(true)
  })

  it('a baixa lancada pelo sistema tem o Sistema de autor', async () => {
    banco.ocorrencias = [baixa(2, '2026-09-05', { usuario: null })]

    expect((await baixasDaCaixa(7))[0]?.autor).toBe('Sistema')
  })
})
