import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registrarEntrega } from './demanda.service.ts'

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  concluidas: 1,
  remessas: null as Record<string, unknown> | null,
  historicos: [] as Record<string, unknown>[],
  /** as caixas com reserva do pedido, como estao depois de a remessa ganhar a data */
  caixas: [] as Record<string, unknown>[],
  movidas: [] as { id: number; estado: string }[],
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
        caixa: {
          findMany: async () => banco.caixas,
          update: async ({ where, data }: { where: { id: number }; data: { estado: string } }) => {
            banco.movidas.push({ id: where.id, estado: data.estado })
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
  banco.solicitacao = { id: 7, status: 'AP', dtCriacao: new Date('2026-10-01T12:00:00.000Z') }
  banco.concluidas = 1
  banco.remessas = null
  banco.historicos = []
  banco.caixas = []
  banco.movidas = []
})

describe('registro de entrega', () => {
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

// Um parto ja entregue (a remessa ganhou a data) ou ainda reservado para outro pedido
const saiu = new Date('2026-10-30T00:00:00.000Z')
const entregue = (qtdM: number, qtdF: number) => ({ qtdM, qtdF, remessa: { idSolicitacao: 7, dtRealizada: saiu } })
const reservado = (qtdM: number, qtdF: number) => ({ qtdM, qtdF, remessa: { idSolicitacao: 8, dtRealizada: null } })
const desmamado = (m: number, f: number, ...compromissos: unknown[]) => ({
  nascidoM: m,
  nascidoF: f,
  eutanasiadoM: null,
  eutanasiadoF: null,
  desmamadoM: m,
  desmamadoF: f,
  compromissos,
})
const caixa = (estado: string, ativo: boolean, ...partos: unknown[]) => ({
  id: 3,
  codigo: 'F1A',
  estado,
  casais: [{ ativo, partos }],
})

describe('a caixa depois da entrega', () => {
  it('a entrega que esvazia a caixa do casal encerrado manda a caixa para Enviado', async () => {
    banco.caixas = [caixa('T', false, desmamado(2, 1, entregue(2, 1)))]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.movidas).toEqual([{ id: 3, estado: 'X' }])
    expect(banco.historicos).toContainEqual(
      expect.objectContaining({
        entidade: 'caixa',
        idEntidade: 3,
        acao: 'mudanca_de_coluna',
        dados: { antes: 'reserva', depois: 'enviado', entrega: 7 },
      }),
    )
  })

  it('pre-reserva de casal encerrado que a entrega esvazia vai para Enviado, e nao para Livres', async () => {
    banco.caixas = [caixa('P', false, desmamado(2, 1, entregue(2, 1)))]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.movidas).toEqual([{ id: 3, estado: 'X' }])
  })

  it('com casal ativo a caixa nao vai para Enviado; em Pre-reserva sem nada a entregar volta para Livres', async () => {
    banco.caixas = [caixa('P', true, desmamado(3, 3, entregue(2, 1)))]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.movidas).toEqual([{ id: 3, estado: 'R' }])
  })

  it('casal encerrado com animal sobrando na caixa: a caixa fica onde esta', async () => {
    banco.caixas = [caixa('E', false, desmamado(3, 3, entregue(2, 1)))]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.movidas).toEqual([])
  })

  it('caixa com reserva de outro pedido ainda a entregar fica onde esta', async () => {
    banco.caixas = [caixa('P', false, desmamado(2, 2, entregue(1, 1), reservado(1, 1)))]

    await registrarEntrega(7, '2026-10-30', 1, agora)

    expect(banco.movidas).toEqual([])
  })
})
