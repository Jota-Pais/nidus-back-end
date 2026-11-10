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
  chegadas: [] as unknown[],
  ondeOcorrencias: null as unknown,
  ondeChegadas: null as unknown,
  ondeHistorico: null as unknown,
  /** os animais de cada baixa anulavel (ocorrencia_animal) e a caixa onde ela aconteceu */
  ligacoes: [] as unknown[],
  ondeLigacoes: null as unknown,
  caixasDaBaixa: [] as unknown[],
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    caixa: { findUnique: async () => banco.caixa, findMany: async () => banco.caixasDaBaixa },
    ocorrenciaAnimal: {
      findMany: async ({ where }: { where: unknown }) => {
        banco.ondeLigacoes = where
        return banco.ligacoes
      },
    },
    // a caixa de casal da baixa sem outra ninhada viva
    animal: { groupBy: async () => [] },
    casal: { findMany: async () => banco.casais },
    ocorrencia: {
      // a trilha da caixa filtra o tipo; as chegadas de fora, so o destino
      findMany: async ({ where }: { where: { tipo?: unknown } }) => {
        if (where.tipo === undefined) {
          banco.ondeChegadas = where
          return banco.chegadas
        }
        banco.ondeOcorrencias = where
        return banco.ocorrencias
      },
    },
    historico: {
      findMany: async ({ where }: { where: unknown }) => {
        banco.ondeHistorico = where
        return banco.historico
      },
    },
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
  anulacoes: [],
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

/** A chegada registrada de animais de um parto de casal de outra caixa */
const chegada = (dia: string, idParto: number, casal: string, horas = '15:00') => ({
  dtRegistro: new Date(`${dia}T${horas}:00.000Z`),
  animais: [{ animal: { idParto, parto: { casal: { idCaixa: 3, identificacao: casal } } } }],
})

/** Um animal de baixa anulavel, como a anulacao le: desmamado e da linhagem 3 */
const daBaixa = (idOcorrencia: number, id: number, sexo: string) => ({
  idOcorrencia,
  animal: { id, sexo, idPedido: null, idParto: 10, parto: { dtDesmameReal: d('2026-09-23'), casal: { idLinhagem: 3 } } },
})

/** A caixa 7 hoje: virou de estoque de femeas da linhagem 3 */
const caixa7 = (campos: Record<string, unknown> = {}) => ({ id: 7, codigo: 'F1A', ativa: true, tipo: 'estoque', sexo: 'F', idLinhagem: 3, ...campos })

beforeEach(() => {
  banco.caixa = { dtLiberacao: null }
  banco.ligacoes = [daBaixa(2, 101, 'M'), daBaixa(2, 102, 'F')]
  banco.caixasDaBaixa = [caixa7()]
  banco.chegadas = []
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
      anulacoes: [{ id: 9 }],
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
    historico('parto', 'correcao_desmame', 10, '2026-10-01', { descricao: 'Correção do desmame do 1º parto: digitado errado' }),
    historico('caixa', 'virar_estoque', 7, '2026-10-12', { descricao: 'Caixa F1A virou caixa de estoque com 2 fêmeas' }),
  ]
})

describe('os eventos da ficha', () => {
  it('cada fato uma vez, por data e na ordem do dia, com quem registrou', async () => {
    const eventos = await eventosDaCaixa(7, new Map([[10, { m: 4, f: 3 }]]))

    expect(eventos.map((e) => [e.dataHora.slice(0, 10), e.tipo, e.descricao, e.autor])).toEqual([
      ['2026-08-09', 'acasalamento', 'Acasalamento do 1º parto do casal AB.', 'Bia'],
      ['2026-09-01', 'nascimento', '1º parto do casal AB: 5 machos e 5 fêmeas.', 'Sistema'],
      ['2026-09-05', 'baixa', 'Eutanásia de seleção do 1º parto do casal AB: 1 macho e 1 fêmea.', 'Ana'],
      ['2026-09-23', 'baixa', '1 fêmea do 1º parto do casal AB não chegou ao desmame. (anulada)', 'Ana'],
      ['2026-09-23', 'desmame', 'Desmame do 1º parto do casal AB: 4 machos e 3 fêmeas.', 'Caio'],
      ['2026-09-25', 'mudanca', '4 machos passaram para a caixa F2A.', 'Ana'],
      ['2026-10-01', 'correcao', 'Correção do desmame do 1º parto: digitado errado', 'Bia'],
      ['2026-10-10', 'encerramento', 'Casal AB encerrado: idade', 'Bia'],
      ['2026-10-12', 'virar_estoque', 'Caixa F1A virou caixa de estoque com 2 fêmeas', 'Bia'],
      // a entrega conta so os animais que sairam desta caixa
      ['2026-10-20', 'entrega', '2 fêmeas entregues ao pedido #3.', 'Ana'],
    ])
  })

  it('o acasalamento que o nascimento abriu sozinho diz isso, com o Sistema de autor', async () => {
    const [casal] = banco.casais as { partos: unknown[] }[]
    casal?.partos.push({
      id: 11,
      ordem: 2,
      dtAcasalamento: d('2026-09-07'),
      dtDesmameReal: null,
      dtRegistroDesmame: null,
      dtSemNinhada: null,
      motivoSemNinhada: null,
      usuarioDesmame: null,
    })
    banco.historico.push(
      historico('parto', 'acasalamento', 11, '2026-09-01', {
        usuario: null,
        dados: { dtAcasalamento: '2026-09-07', automatico: true },
      }),
    )

    const eventos = await eventosDaCaixa(7, new Map())

    expect(eventos.find((e) => e.dataHora.startsWith('2026-09-07'))).toMatchObject({
      tipo: 'acasalamento',
      descricao: 'Acasalamento do 2º parto do casal AB, aberto automaticamente 6 dias depois do parto anterior.',
      autor: 'Sistema',
    })
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

  it('a baixa anulavel diz quantos de cada sexo, a linhagem e se a caixa dela ainda os recebe; as outras, null', async () => {
    const eventos = await eventosDaCaixa(7, new Map())
    const daTrilha = eventos.filter((e) => e.idOcorrencia !== null)

    // so a baixa anulavel e lida: a anulada e o resto da trilha nao
    expect(banco.ondeLigacoes).toEqual({ idOcorrencia: { in: [2] } })
    // a caixa virou estoque de femeas: o macho da selecao nao volta para ela
    expect(daTrilha.map((e) => [e.idOcorrencia, e.baixa])).toEqual([
      [1, null],
      [2, { sexos: { m: 1, f: 1 }, idLinhagem: 3, voltaNaOrigem: false }],
      [3, null],
      [4, null],
      [5, null],
    ])
    expect(eventos.find((e) => e.tipo === 'acasalamento')?.baixa).toBeNull()

    // so a femea: o estoque de femeas da linhagem dela a recebe
    banco.ligacoes = [daBaixa(2, 102, 'F')]
    expect((await eventosDaCaixa(7, new Map())).find((e) => e.idOcorrencia === 2)?.baixa).toEqual({
      sexos: { m: 0, f: 1 },
      idLinhagem: 3,
      voltaNaOrigem: true,
    })

    // a caixa liberada nao recebe ninguem
    banco.caixasDaBaixa = [caixa7({ ativa: false })]
    expect((await eventosDaCaixa(7, new Map())).find((e) => e.idOcorrencia === 2)?.baixa?.voltaNaOrigem).toBe(false)

    // a de casal sem outra ninhada viva recebe os dois sexos
    banco.ligacoes = [daBaixa(2, 101, 'M'), daBaixa(2, 102, 'F')]
    banco.caixasDaBaixa = [caixa7({ tipo: 'casal', sexo: null, idLinhagem: null })]
    expect((await eventosDaCaixa(7, new Map())).find((e) => e.idOcorrencia === 2)?.baixa?.voltaNaOrigem).toBe(true)
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
      ['2026-10-02', 'mudanca', '3 fêmeas chegaram da caixa T1B.'],
      ['2026-10-20', 'liberacao', 'Caixa F1A liberada em 2026-10-20'],
    ])
  })

  it('a caixa que nunca foi de casal mostra a correcao do nascimento que criou ou anulou animais nela', async () => {
    banco.casais = []
    banco.chegadas = [chegada('2026-10-02', 30, 'CD ')]
    banco.ocorrencias = [
      ocorrencia(6, 'mudanca', '2026-10-02', {
        idCaixaOrigem: 3,
        idCaixaDestino: 7,
        parto: null,
        caixaOrigem: { codigo: 'T1B' },
        animais: animais(0, 3),
      }),
    ]
    banco.historico = [
      historico('parto', 'correcao_nascimento', 30, '2026-10-05', { descricao: 'Correção do 2º parto: contou 2 a menos' }),
    ]

    const eventos = await eventosDaCaixa(7, new Map())

    expect(eventos.map((e) => [e.dataHora.slice(0, 10), e.tipo, e.descricao, e.autor])).toEqual([
      ['2026-10-02', 'mudanca', '3 fêmeas chegaram da caixa T1B.', 'Ana'],
      ['2026-10-05', 'correcao', 'Casal CD: Correção do 2º parto: contou 2 a menos', 'Bia'],
    ])
  })

  it('os partos de fora sao os dos animais que chegaram na caixa, e deles so a correcao dos animais', async () => {
    banco.chegadas = [chegada('2026-10-02', 30, 'CD')]

    await eventosDaCaixa(7, new Map())

    expect(banco.ondeChegadas).toEqual({
      idCaixaDestino: 7,
      animais: { some: { animal: { parto: { casal: { idCaixa: { not: 7 } } } } } },
    })
    expect((banco.ondeHistorico as { OR: unknown[] }).OR).toContainEqual({
      entidade: 'parto',
      idEntidade: { in: [30] },
      acao: { in: ['correcao_nascimento', 'correcao_desmame'] },
    })
  })

  it('da correcao de um parto de fora, so a registrada depois que os animais dele chegaram aqui', async () => {
    banco.casais = []
    banco.ocorrencias = []
    // os animais do parto 30 chegaram em 02/10 as 15h; os a mais da correcao das 12h de 05/10 vieram
    // na propria correcao, que chegou junto
    banco.chegadas = [chegada('2026-10-02', 30, 'CD'), chegada('2026-10-05', 31, 'DE', '12:00')]
    banco.historico = [
      historico('parto', 'correcao_nascimento', 30, '2026-09-28', { descricao: 'Correção do 1º parto: antes da chegada' }),
      historico('parto', 'correcao_desmame', 30, '2026-10-02', { descricao: 'Correção do desmame: na hora da chegada' }),
      historico('parto', 'correcao_nascimento', 30, '2026-10-04', { descricao: 'Correção do 1º parto: depois da chegada' }),
      historico('parto', 'correcao_nascimento', 31, '2026-10-05', {
        dtHora: new Date('2026-10-05T12:00:00.000Z'),
        descricao: 'Correção do 2º parto: os a mais entraram aqui',
      }),
    ]

    const eventos = await eventosDaCaixa(7, new Map())

    expect(eventos.map((e) => [e.dataHora.slice(0, 10), e.descricao])).toEqual([
      ['2026-10-02', 'Casal CD: Correção do desmame: na hora da chegada'],
      ['2026-10-04', 'Casal CD: Correção do 1º parto: depois da chegada'],
      ['2026-10-05', 'Casal DE: Correção do 2º parto: os a mais entraram aqui'],
    ])
  })

  it('a chegada de animais do proprio casal da caixa nao torna o parto de fora', async () => {
    banco.chegadas = [{ ...chegada('2026-10-02', 10, 'AB'), animais: [{ animal: { idParto: 10, parto: { casal: { idCaixa: 7, identificacao: 'AB' } } } }] }]

    await eventosDaCaixa(7, new Map())

    expect((banco.ondeHistorico as { OR: unknown[] }).OR).toContainEqual({
      entidade: 'parto',
      idEntidade: { in: [] },
      acao: { in: ['correcao_nascimento', 'correcao_desmame'] },
    })
  })

  it('o virar estoque de antes do modelo por rato aparece; a passagem antiga, que a trilha ja conta, nao', async () => {
    banco.casais = []
    banco.ocorrencias = []
    banco.historico = [
      historico('caixa', 'estoque', 7, '2026-09-25', {
        descricao: '4 machos do 1º parto do casal AB (caixa F1A) passaram para a caixa de estoque F2A',
        dados: { idParto: 10, idCaixaDoCasal: 1, sexo: 'M', qtd: 4 },
      }),
      historico('caixa', 'estoque', 7, '2026-10-12', {
        descricao: 'Caixa F1A virou caixa de estoque com 2 fêmeas',
        dados: { sexo: 'F', total: 2 },
      }),
    ]

    const eventos = await eventosDaCaixa(7, new Map())

    expect(eventos.map((e) => [e.dataHora.slice(0, 10), e.tipo, e.descricao])).toEqual([
      ['2026-10-12', 'virar_estoque', 'Caixa F1A virou caixa de estoque com 2 fêmeas'],
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
