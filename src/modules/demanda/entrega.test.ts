import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registrarEntrega } from './demanda.service.ts'

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  concluidas: 1,
  remessas: null as Record<string, unknown> | null,
  historicos: [] as Record<string, unknown>[],
  /** as caixas de onde sairam os animais entregues do pedido */
  caixasDosEntregues: [] as number[],
  liberadas: [] as { idCaixa: number; dtFato: string; motivo: string }[],
  /** se a caixa ficou sem vivo (a regra fica em colonia/liberacao.test.ts) */
  libera: true,
  falta: null as { m: number; f: number } | null,
}))

vi.mock('./devolucao.service.ts', async (original) => ({
  ...(await original<typeof import('./devolucao.service.ts')>()),
  faltaDosPedidos: async () => new Map(banco.falta ? [[7, banco.falta]] : []),
}))

vi.mock('../colonia/liberacao.ts', async (original) => ({
  ...(await original<typeof import('../colonia/liberacao.ts')>()),
  liberarSeVazia: async (_tx: unknown, idCaixa: number, dtFato: string, motivo: string) => {
    if (!banco.libera) return false
    banco.liberadas.push({ idCaixa, dtFato, motivo })
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
          updateMany: async (consulta: Record<string, unknown>) => {
            banco.remessas = consulta
            return { count: 1 }
          },
        },
        animal: { findMany: async () => banco.caixasDosEntregues.map((idCaixa) => ({ idCaixa })) },
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
  banco.caixasDosEntregues = []
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

describe('as caixas depois da entrega', () => {
  it('cada caixa de onde sairam os entregues passa pela liberacao, com a data e o motivo da entrega', async () => {
    banco.caixasDosEntregues = [3, 9]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    // a de estoque fica 7 dias em Enviado contados dessa data
    expect(banco.liberadas).toEqual([
      { idCaixa: 3, dtFato: '2026-10-30', motivo: 'entrega' },
      { idCaixa: 9, dtFato: '2026-10-30', motivo: 'entrega' },
    ])
  })

  it('a caixa que ainda tem vivo, ou o casal ativo, nao libera', async () => {
    banco.caixasDosEntregues = [3]
    banco.libera = false

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.liberadas).toEqual([])
  })
})
