import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventosDaCaixa } from './eventos.ts'

// Os eventos da ficha com o banco de mentira: a caixa 7, que foi do casal AB (encerrado) e virou
// de estoque, com a trilha dos animais e o historico. Cada fato tem de aparecer uma vez, na data
// dele e na ordem do dia

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const registro = (iso: string) => new Date(`${iso}T15:00:00.000Z`)

const banco = vi.hoisted(() => ({
  caixa: { dtLiberacao: null as Date | null },
  casais: [] as unknown[],
  ocorrencias: [] as unknown[],
  historico: [] as unknown[],
  ondeOcorrencias: null as unknown,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: { findUnique: async () => banco.caixa },
    casal: { findMany: async () => banco.casais },
    ocorrencia: {
      findMany: async ({ where }: { where: unknown }) => {
        banco.ondeOcorrencias = where
        return banco.ocorrencias
      },
    },
    historico: { findMany: async () => banco.historico },
  },
}))

const animais = (m: number, f: number, idCaixa = 7) => [
  ...Array.from({ length: m }, () => ({ animal: { sexo: 'M', idCaixa } })),
  ...Array.from({ length: f }, () => ({ animal: { sexo: 'F', idCaixa } })),
]

const ocorrencia = (id: number, tipo: string, dia: string, campos: Record<string, unknown> = {}) => ({
  id,
  tipo,
  dtFato: d(dia),
  dtRegistro: registro(dia),
  idCaixaOrigem: null,
  idCaixaDestino: null,
  idPedido: null,
  motivo: null,
  usuario: { nome: 'Ana' },
  parto: { ordem: 1, casal: { identificacao: 'AB' } },
  caixaOrigem: null,
  caixaDestino: null,
  anulacao: null,
  animais: [],
  ...campos,
})

const historico = (entidade: string, acao: string, idEntidade: number, dia: string, campos: Record<string, unknown> = {}) => ({
  entidade,
  acao,
  idEntidade,
  dtHora: registro(dia),
  descricao: `${acao} registrado`,
  usuario: { nome: 'Bia' },
  ...campos,
})

beforeEach(() => {
  banco.caixa = { dtLiberacao: null }
  banco.casais = [
    {
      id: 1,
      identificacao: 'AB',
      dtEncerramento: d('2026-10-10'),
      motivoEncerramento: 'idade',
      partos: [
        {
          id: 10,
          ordem: 1,
          dtAcasalamento: d('2026-08-09'),
          dtDesmameReal: d('2026-09-23'),
          dtRegistroDesmame: registro('2026-09-23'),
          dtSemNinhada: null,
          motivoSemNinhada: null,
          usuarioDesmame: { nome: 'Caio' },
        },
      ],
    },
  ]
  banco.ocorrencias = [
    ocorrencia(1, 'nascimento', '2026-09-01', { idCaixaDestino: 7, animais: animais(5, 5), usuario: null }),
    ocorrencia(2, 'baixa', '2026-09-05', {
      idCaixaOrigem: 7,
      motivo: 'eutanasia de selecao',
      animais: animais(1, 1),
    }),
    ocorrencia(3, 'baixa', '2026-09-23', {
      idCaixaOrigem: 7,
      motivo: 'nao chegou ao desmame',
      animais: animais(0, 1),
      anulacao: { id: 9 },
    }),
    ocorrencia(4, 'mudanca', '2026-09-25', {
      idCaixaOrigem: 7,
      idCaixaDestino: 8,
      parto: null,
      caixaDestino: { codigo: 'F2A' },
      animais: animais(4, 0, 8),
    }),
    ocorrencia(5, 'entrega', '2026-10-20', {
      idPedido: 3,
      parto: null,
      animais: [...animais(0, 2), ...animais(0, 5, 9)],
    }),
  ]
  banco.historico = [
    historico('casal', 'formacao', 1, '2026-08-09'),
    historico('casal', 'encerramento', 1, '2026-10-10'),
    historico('parto', 'correcao_desmame', 10, '2026-10-01', { descricao: 'Correcao do desmame do 1o parto: digitado errado' }),
    historico('caixa', 'virar_estoque', 7, '2026-10-12', { descricao: 'Caixa F1A virou caixa de estoque com 2 femeas' }),
  ]
})

describe('os eventos da ficha', () => {
  it('cada fato uma vez, por data e na ordem do dia, com quem registrou', async () => {
    const eventos = await eventosDaCaixa(7, new Map([[10, { m: 4, f: 3 }]]))

    expect(eventos.map((e) => [e.dataHora.slice(0, 10), e.tipo, e.descricao, e.autor])).toEqual([
      ['2026-08-09', 'acasalamento', 'Acasalamento do 1o parto do casal AB.', 'Bia'],
      ['2026-09-01', 'nascimento', 'Nascimento do 1o parto do casal AB: 5 M, 5 F.', 'Sistema'],
      ['2026-09-05', 'baixa', 'Eutanasia de selecao do 1o parto do casal AB: 1 M, 1 F.', 'Ana'],
      ['2026-09-23', 'baixa', '0 M, 1 F do 1o parto do casal AB nao chegaram ao desmame. (anulada)', 'Ana'],
      ['2026-09-23', 'desmame', 'Desmame do 1o parto do casal AB: 4 M, 3 F.', 'Caio'],
      ['2026-09-25', 'mudanca', '4 M, 0 F mudaram para a caixa F2A.', 'Ana'],
      ['2026-10-01', 'correcao', 'Correcao do desmame do 1o parto: digitado errado', 'Bia'],
      ['2026-10-10', 'encerramento', 'Casal AB encerrado: idade', 'Bia'],
      ['2026-10-12', 'virar_estoque', 'Caixa F1A virou caixa de estoque com 2 femeas', 'Bia'],
      // a entrega conta so os animais que sairam desta caixa
      ['2026-10-20', 'entrega', '0 M, 2 F entregues ao pedido #3.', 'Ana'],
    ])
  })

  it('a baixa traz a ocorrencia e se ainda pode ser anulada; o que nao e da trilha, nao', async () => {
    const eventos = await eventosDaCaixa(7, new Map())
    const daTrilha = eventos.filter((e) => e.idOcorrencia !== null)

    expect(daTrilha.map((e) => [e.idOcorrencia, e.anulavel])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
    ])
    expect(eventos.find((e) => e.tipo === 'acasalamento')).toMatchObject({ idOcorrencia: null, anulavel: false })
  })

  it('le a trilha da caixa sem a correcao, que aparece pelo historico, e com a entrega dos animais dela', async () => {
    await eventosDaCaixa(7, new Map())

    expect(banco.ondeOcorrencias).toEqual({
      tipo: { not: 'correcao' },
      OR: [
        { idCaixaOrigem: 7 },
        { idCaixaDestino: 7 },
        { tipo: 'entrega', animais: { some: { animal: { idCaixa: 7 } } } },
      ],
    })
  })

  it('a chegada de outra caixa e a liberacao com a data do fato que esvaziou a caixa', async () => {
    banco.casais = []
    banco.caixa = { dtLiberacao: d('2026-10-20') }
    banco.ocorrencias = [
      ocorrencia(6, 'mudanca', '2026-10-02', {
        idCaixaOrigem: 3,
        idCaixaDestino: 7,
        parto: null,
        caixaOrigem: { codigo: 'T1B' },
        animais: animais(0, 3),
      }),
    ]
    banco.historico = [historico('caixa', 'liberacao', 7, '2026-10-21', { descricao: 'Caixa F1A liberada em 2026-10-20' })]

    const eventos = await eventosDaCaixa(7, new Map())

    expect(eventos.map((e) => [e.dataHora.slice(0, 10), e.tipo, e.descricao])).toEqual([
      ['2026-10-02', 'mudanca', '0 M, 3 F chegaram da caixa T1B.'],
      ['2026-10-20', 'liberacao', 'Caixa F1A liberada em 2026-10-20'],
    ])
  })

  it('o fato sem registro no historico fica com autor desconhecido', async () => {
    banco.historico = []
    banco.ocorrencias = []

    const eventos = await eventosDaCaixa(7, new Map())

    expect(eventos.find((e) => e.tipo === 'acasalamento')?.autor).toBe('Desconhecido')
    expect(eventos.find((e) => e.tipo === 'encerramento')?.autor).toBe('Desconhecido')
  })
})
