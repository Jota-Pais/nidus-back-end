import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registrarEntrega } from './demanda.service.ts'

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  concluidas: 1,
  remessas: null as Record<string, unknown> | null,
  historicos: [] as Record<string, unknown>[],
  /** a caixa do casal com reserva do pedido: se o casal esta ativo */
  caixa: null as { ativo: boolean } | null,
  /** os partos da caixa do casal, com as reservas e os lotes nas caixas de estoque */
  partos: [] as Parto[],
  movidas: [] as { id: number; estado?: string; ativa?: boolean }[],
  liberadas: [] as number[],
  /** se a caixa do casal sem casal ativo libera (a regra fica em liberacaoDaCaixa.test.ts) */
  libera: true,
  falta: null as { m: number; f: number } | null,
}))

vi.mock('./devolucao.service.ts', async (original) => ({
  ...(await original<typeof import('./devolucao.service.ts')>()),
  faltaDosPedidos: async () => new Map(banco.falta ? [[7, banco.falta]] : []),
}))

type Parto = {
  id: number
  nascidoM: number
  nascidoF: number
  eutanasiadoM: null
  eutanasiadoF: null
  desmamadoM: number
  desmamadoF: number
  compromissos: { id: number; qtdM: number; qtdF: number; remessa: { idSolicitacao: number; dtRealizada: Date | null } }[]
  lotes: { id: number; idCaixa: number; qtd: number; caixa: { sexo: string } }[]
}

vi.mock('../infra/liberacaoDaCaixa.ts', () => ({
  liberarCaixaVazia: async (_tx: unknown, idCaixa: number) => {
    if (!banco.libera) return false
    banco.liberadas.push(idCaixa)
    return true
  },
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    solicitacao: { findUnique: async () => banco.solicitacao },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        solicitacao: { updateMany: async () => ({ count: banco.concluidas }) },
        remessa: {
          updateMany: async (consulta: { data: { dtRealizada: Date } }) => {
            banco.remessas = consulta
            for (const parto of banco.partos) {
              for (const c of parto.compromissos) {
                if (c.remessa.idSolicitacao === 7) c.remessa.dtRealizada = consulta.data.dtRealizada
              }
            }
            return { count: 1 }
          },
        },
        parto: { findMany: async () => banco.partos },
        lote: {
          update: async ({ where, data }: { where: { idCaixa_idParto: { idCaixa: number; idParto: number } }; data: { qtd: { decrement: number } } }) => {
            const { idCaixa, idParto } = where.idCaixa_idParto
            const lote = banco.partos.find((p) => p.id === idParto)?.lotes.find((l) => l.idCaixa === idCaixa)
            if (lote) lote.qtd -= data.qtd.decrement
          },
          aggregate: async ({ where }: { where: { idCaixa: number } }) => ({
            _sum: {
              qtd: banco.partos
                .flatMap((p) => p.lotes)
                .filter((l) => l.idCaixa === where.idCaixa)
                .reduce((soma, l) => soma + l.qtd, 0),
            },
          }),
        },
        caixa: {
          findMany: async () =>
            banco.caixa === null ? [] : [{ id: 3, casais: [{ ativo: banco.caixa.ativo }] }],
          update: async ({ where, data }: { where: { id: number }; data: { estado?: string; ativa?: boolean } }) => {
            banco.movidas.push({ id: where.id, ...data })
            return { codigo: `caixa ${where.id}` }
          },
        },
        historico: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.historicos.push(data)
          },
        },
      }),
  },
}))

const agora = new Date('2026-10-31T15:00:00.000Z')
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.falta = null
  banco.liberadas = []
  banco.solicitacao = { id: 7, status: 'AP', dtCriacao: new Date('2026-10-01T12:00:00.000Z') }
  banco.concluidas = 1
  banco.remessas = null
  banco.historicos = []
  banco.caixa = null
  banco.partos = []
  banco.movidas = []
  banco.libera = true
})

describe('registro de entrega', () => {
  it('pedido com a reserva em falta nao e entregue', async () => {
    banco.falta = { m: 1, f: 0 }

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(
      recusa(409, 'DISPONIBILIDADE_EXCEDIDA'),
    )
    expect(banco.historicos).toEqual([])
  })

  it('solicitacao alocada vira entregue e a remessa ganha a data', async () => {
    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).resolves.toEqual({
      idSolicitacao: 7,
      status: 'concluida',
      dtEntrega: '2026-10-30',
    })
    expect(banco.remessas).toEqual({
      where: { idSolicitacao: 7, dtRealizada: null },
      data: { dtRealizada: new Date('2026-10-30T00:00:00.000Z'), status: 'E' },
    })
    expect(banco.historicos).toContainEqual(
      expect.objectContaining({ idUsuario: 1, entidade: 'solicitacao', idEntidade: 7, acao: 'entrega' }),
    )
  })

  it('solicitacao sem caixas alocadas e recusada', async () => {
    banco.solicitacao = { ...banco.solicitacao, status: 'EN' }

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.remessas).toBeNull()
  })

  it('segunda entrega da mesma solicitacao e recusada', async () => {
    banco.solicitacao = { ...banco.solicitacao, status: 'CO' }

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
  })

  it('dois cliques ao mesmo tempo: o segundo nao grava', async () => {
    banco.concluidas = 0

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.remessas).toBeNull()
  })

  it('entrega no futuro e recusada', async () => {
    await expect(registrarEntrega(7, '2026-11-01', 1, agora)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('entrega antes do pedido e recusada', async () => {
    await expect(registrarEntrega(7, '2026-09-30', 1, agora)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('solicitacao inexistente e 404', async () => {
    banco.solicitacao = null

    await expect(registrarEntrega(7, '2026-10-30', 1, agora)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})

// Os partos da caixa do casal F1A (id 3), com reservas do pedido 7 (o entregue agora) ou do 8
const doPedido = (id: number, qtdM: number, qtdF: number) => ({
  id,
  qtdM,
  qtdF,
  remessa: { idSolicitacao: 7, dtRealizada: null as Date | null },
})
const deOutroPedido = (id: number, qtdM: number, qtdF: number) => ({
  id,
  qtdM,
  qtdF,
  remessa: { idSolicitacao: 8, dtRealizada: null as Date | null },
})
const desmamado = (m: number, f: number, compromissos: Parto['compromissos'], lotes: Parto['lotes'] = []): Parto => ({
  id: 10,
  nascidoM: m,
  nascidoF: f,
  eutanasiadoM: null,
  eutanasiadoF: null,
  desmamadoM: m,
  desmamadoF: f,
  compromissos,
  lotes,
})
/** machos do parto na caixa de estoque 9 */
const naCaixaDeEstoque9 = (qtd: number) => ({ id: 1, idCaixa: 9, qtd, caixa: { sexo: 'M' } })

describe('a caixa do casal depois da entrega', () => {
  it('casal encerrado: a entrega que esvazia a caixa a libera, e ela sai do kanban', async () => {
    banco.caixa = { ativo: false }
    banco.partos = [desmamado(2, 1, [doPedido(1, 2, 1)])]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.liberadas).toEqual([3])
    expect(banco.movidas).toEqual([])
  })

  it('casal ativo: a entrega nao mexe na caixa do casal, que continua em Livres', async () => {
    banco.caixa = { ativo: true }
    banco.partos = [desmamado(3, 3, [doPedido(1, 2, 1), deOutroPedido(2, 1, 1)])]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.liberadas).toEqual([])
    expect(banco.movidas).toEqual([])
  })

  it('casal encerrado com animal sobrando na caixa: ela nao libera e fica em Livres', async () => {
    banco.libera = false
    banco.caixa = { ativo: false }
    banco.partos = [desmamado(3, 3, [doPedido(1, 2, 1)])]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.liberadas).toEqual([])
    expect(banco.movidas).toEqual([])
  })

})

describe('a caixa de estoque na entrega', () => {
  it('os animais do pedido que estao na caixa de estoque saem dela', async () => {
    banco.caixa = { ativo: true }
    banco.partos = [desmamado(3, 0, [doPedido(1, 2, 0)], [naCaixaDeEstoque9(3)])]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.partos[0]?.lotes[0]?.qtd).toBe(1)
    expect(banco.movidas).toEqual([])
  })

  it('primeiro sai o que sobrou na caixa do casal, depois a caixa de estoque', async () => {
    banco.caixa = { ativo: true }
    // 3 machos: 1 ainda na caixa do casal, 2 na caixa de estoque 9
    banco.partos = [desmamado(3, 0, [doPedido(1, 2, 0)], [naCaixaDeEstoque9(2)])]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.partos[0]?.lotes[0]?.qtd).toBe(1)
  })

  it('a caixa de estoque que esvazia vai para Enviado e libera a posicao', async () => {
    banco.caixa = { ativo: true }
    banco.partos = [desmamado(2, 0, [doPedido(1, 2, 0)], [naCaixaDeEstoque9(2)])]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.partos[0]?.lotes[0]?.qtd).toBe(0)
    expect(banco.movidas).toContainEqual(expect.objectContaining({ id: 9, estado: 'X', ativa: false }))
    expect(banco.historicos).toContainEqual(
      expect.objectContaining({ entidade: 'caixa', idEntidade: 9, acao: 'mudanca_de_coluna' }),
    )
  })
})
