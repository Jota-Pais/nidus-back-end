import { beforeEach, describe, expect, it, vi } from 'vitest'
import { avisarPedidoDecidido } from '../../shared/email.ts'
import { recusarSolicitacao } from './demanda.service.ts'

vi.mock('../../shared/email.ts', () => ({ avisarPedidoDecidido: vi.fn().mockResolvedValue(undefined) }))

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  recusadas: 1,
  atualizacao: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    solicitacao: { findUnique: async () => banco.solicitacao },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        solicitacao: {
          updateMany: async (consulta: Record<string, unknown>) => {
            banco.atualizacao = consulta
            return { count: banco.recusadas }
          },
        },
        historico: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            banco.historico = data
          },
        },
      }),
  },
}))

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  banco.solicitacao = {
    id: 7,
    status: 'EN',
    qtdM: 2,
    qtdF: 2,
    qtdQualquer: 0,
    idadeMinDias: 21,
    idadeMaxDias: 28,
    dtDesejada: new Date('2026-12-01T00:00:00.000Z'),
    protocoloCeua: '23080.000001/2026-54',
    linhagem: { nome: 'Wistar' },
    usuarioSolicitante: { email: 'paula@ufsc.br' },
  }
  vi.clearAllMocks()
  banco.recusadas = 1
  banco.atualizacao = null
  banco.historico = null
})

describe('recusa de solicitacao', () => {
  it('a enviada vira recusada e o motivo fica no historico', async () => {
    await expect(recusarSolicitacao(7, 'Sem animais da linhagem', 2)).resolves.toEqual({
      idSolicitacao: 7,
      status: 'recusada',
      motivo: 'Sem animais da linhagem',
    })
    expect(banco.historico).toMatchObject({
      idUsuario: 2,
      entidade: 'solicitacao',
      idEntidade: 7,
      acao: 'recusa',
      dados: { motivo: 'Sem animais da linhagem' },
    })
  })

  it('avisa quem pediu, com o motivo, e a falha do envio nao derruba a recusa', async () => {
    vi.mocked(avisarPedidoDecidido).mockRejectedValueOnce(new Error('Brevo fora do ar'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(recusarSolicitacao(7, 'Sem Wistar', 2)).resolves.toMatchObject({ status: 'recusada' })
    expect(avisarPedidoDecidido).toHaveBeenCalledWith(
      'paula@ufsc.br',
      expect.objectContaining({ idadeMin: 21, idadeMax: 28, dataEntrega: '2026-12-01' }),
      'Sem Wistar',
    )
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    log.mockRestore()
  })

  it('a recusa que nao grava nao avisa ninguem', async () => {
    banco.recusadas = 0

    await expect(recusarSolicitacao(7, 'teste', 2)).rejects.toBeDefined()
    expect(avisarPedidoDecidido).not.toHaveBeenCalled()
  })

  it('a aprovada que nao deu para produzir (sem reserva) tambem pode ser recusada', async () => {
    banco.solicitacao = { ...banco.solicitacao, status: 'AT' }

    await expect(recusarSolicitacao(7, 'A ninhada nao vingou', 2)).resolves.toMatchObject({ status: 'recusada' })
    expect(banco.atualizacao).toEqual({ where: { id: 7, status: { in: ['EN', 'AT'] } }, data: { status: 'RE' } })
    expect(banco.historico).toMatchObject({ acao: 'recusa', dados: { motivo: 'A ninhada nao vingou' } })
    expect(avisarPedidoDecidido).toHaveBeenCalledWith('paula@ufsc.br', expect.anything(), 'A ninhada nao vingou')
  })

  it.each(['AP', 'CO'])('a com animais reservados ou entregue (%s) nao pode ser recusada', async (status) => {
    banco.solicitacao = { id: 7, status }

    await expect(recusarSolicitacao(7, 'teste', 2)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.historico).toBeNull()
  })

  it('recusa e alocacao ao mesmo tempo: quem chegar depois nao grava', async () => {
    banco.recusadas = 0

    await expect(recusarSolicitacao(7, 'teste', 2)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.historico).toBeNull()
  })

  it('solicitacao inexistente e 404', async () => {
    banco.solicitacao = null

    await expect(recusarSolicitacao(7, 'teste', 2)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
