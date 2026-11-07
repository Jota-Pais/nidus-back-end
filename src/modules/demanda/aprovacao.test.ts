import { beforeEach, describe, expect, it, vi } from 'vitest'
import { avisarAnimaisReservados, avisarPedidoDecidido } from '../../shared/email.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { aprovarSolicitacao } from './demanda.service.ts'

vi.mock('../../shared/email.ts', () => ({
  avisarPedidoDecidido: vi.fn().mockResolvedValue(undefined),
  avisarAnimaisReservados: vi.fn().mockResolvedValue(undefined),
}))

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  aprovadas: 1,
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
            return { count: banco.aprovadas }
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

const tecnica: UsuarioDaSessao = { id: 2, nome: 'Ana', email: 'tecnico@ufsc.br', perfil: 'tecnico' }
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
    dtCriacao: new Date('2026-11-05T13:00:00.000Z'),
    protocoloCeua: '23080.000001/2026-54',
    linhagem: { nome: 'Wistar' },
    usuarioSolicitante: { email: 'paula@ufsc.br' },
  }
  vi.clearAllMocks()
  banco.aprovadas = 1
  banco.atualizacao = null
  banco.historico = null
})

describe('aprovacao de solicitacao', () => {
  it('a enviada vira aprovada sem reserva (em atendimento), so se ainda estiver enviada', async () => {
    await expect(aprovarSolicitacao(7, tecnica)).resolves.toEqual({
      idSolicitacao: 7,
      status: 'em_atendimento',
    })
    expect(banco.atualizacao).toEqual({ where: { id: 7, status: 'EN' }, data: { status: 'AT' } })
  })

  it('grava no historico quem aprovou', async () => {
    await aprovarSolicitacao(7, tecnica)

    expect(banco.historico).toMatchObject({
      idUsuario: 2,
      entidade: 'solicitacao',
      idEntidade: 7,
      acao: 'aprovacao',
    })
  })

  it('manda a quem pediu o e-mail de aprovacao, e nao o de animais reservados', async () => {
    await aprovarSolicitacao(7, tecnica)

    expect(avisarPedidoDecidido).toHaveBeenCalledWith(
      'paula@ufsc.br',
      expect.objectContaining({ linhagem: 'Wistar', dataEntrega: '2026-12-01', dataPedido: '2026-11-05' }),
    )
    expect(avisarAnimaisReservados).not.toHaveBeenCalled()
  })

  it('a falha do envio nao derruba a aprovacao', async () => {
    vi.mocked(avisarPedidoDecidido).mockRejectedValueOnce(new Error('Brevo fora do ar'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(aprovarSolicitacao(7, tecnica)).resolves.toMatchObject({ status: 'em_atendimento' })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    log.mockRestore()
  })

  it.each(['AT', 'AP'])('a ja aprovada (%s) diz que ja foi aprovada, sem gravar nem avisar', async (status) => {
    banco.solicitacao = { ...banco.solicitacao, status }

    const aprovar = aprovarSolicitacao(7, tecnica)

    await expect(aprovar).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    await expect(aprovar).rejects.toThrow('A solicitacao #7 ja foi aprovada.')
    expect(banco.atualizacao).toBeNull()
    expect(avisarPedidoDecidido).not.toHaveBeenCalled()
  })

  it.each(['RE', 'CO'])('a recusada ou entregue (%s) nao pode ser aprovada', async (status) => {
    banco.solicitacao = { ...banco.solicitacao, status }

    await expect(aprovarSolicitacao(7, tecnica)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.historico).toBeNull()
  })

  it('dois cliques ou aprovacao e recusa ao mesmo tempo: quem chegar depois nao grava nem avisa', async () => {
    banco.aprovadas = 0

    await expect(aprovarSolicitacao(7, tecnica)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.historico).toBeNull()
    expect(avisarPedidoDecidido).not.toHaveBeenCalled()
  })

  it('solicitacao inexistente e 404', async () => {
    banco.solicitacao = null

    await expect(aprovarSolicitacao(7, tecnica)).rejects.toEqual(recusa(404, 'NAO_ENCONTRADO'))
  })
})
