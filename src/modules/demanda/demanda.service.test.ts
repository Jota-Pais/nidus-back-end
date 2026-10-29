import { describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { alocarSolicitacao } from './demanda.service.ts'

// O banco aqui e de mentira: 'solicitacao.findUnique' devolve a solicitacao que cada teste
// deixou em 'banco', e nao existe parto nem transacao. Nada e gravado

type Solicitacao = { id: number; status: string; remessas: unknown[] }

const banco = vi.hoisted(() => ({ solicitacao: null as Solicitacao | null }))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: { solicitacao: { findUnique: async () => banco.solicitacao } },
}))

const tecnica: UsuarioDaSessao = { id: 2, nome: 'Ana Souza', email: 'tecnico@ufsc.br', perfil: 'tecnico' }
const itens = [{ idParto: 1, machos: 1, femeas: 0 }]

describe('alocacao so de solicitacao enviada', () => {
  it.each(['AP', 'AT', 'CA'])('solicitacao com status %s nao recebe caixas', async (status) => {
    banco.solicitacao = { id: 7, status, remessas: [] }

    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toEqual(
      expect.objectContaining({ status: 409, codigo: 'SOLICITACAO_JA_ALOCADA' }),
    )
  })

  it('a aprovada diz que ja foi alocada; os outros status, que nao aguardam alocacao', async () => {
    banco.solicitacao = { id: 7, status: 'AP', remessas: [] }
    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toThrow(
      'A solicitacao #7 ja foi alocada.',
    )

    banco.solicitacao = { id: 7, status: 'AT', remessas: [] }
    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toThrow(
      'A solicitacao #7 nao esta aguardando alocacao.',
    )
  })

  it('a enviada passa da conferencia do status', async () => {
    // Sem remessa, para no 404 da remessa, que vem depois da conferencia - e antes de
    // qualquer parto ser lido
    banco.solicitacao = { id: 7, status: 'EN', remessas: [] }

    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toEqual(
      expect.objectContaining({ status: 404, codigo: 'NAO_ENCONTRADO' }),
    )
  })
})
