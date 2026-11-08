import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { desfazerReserva, faltaDosPedidos } from './devolucao.service.ts'

// O pedido #12 reservou 4 machos no 5o parto da caixa 3 (A1B), que so desmamou 2

const banco = vi.hoisted(() => ({
  solicitacao: null as Record<string, unknown> | null,
  reservas: [] as Record<string, unknown>[],
  devolvidas: 1,
  mudancaDeStatus: null as Record<string, unknown> | null,
  canceladas: null as Record<string, unknown> | null,
  historico: null as Record<string, unknown> | null,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    solicitacao: { findUnique: async () => banco.solicitacao },
    compromisso: { findMany: async () => banco.reservas },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        solicitacao: {
          updateMany: async (consulta: Record<string, unknown>) => {
            banco.mudancaDeStatus = consulta
            return { count: banco.devolvidas }
          },
        },
        compromisso: {
          updateMany: async (consulta: Record<string, unknown>) => {
            banco.canceladas = consulta
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

const tecnica: UsuarioDaSessao = { id: 9, nome: 'Ana', email: 'ana@ufsc.br', perfil: 'tecnico' }
const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

const pedidoNoParto = (idSolicitacao: number, qtdM: number, qtdF = 0) => ({
  qtdM,
  qtdF,
  remessa: { idSolicitacao },
})

/** a reserva do pedido no parto, com todos os compromissos ativos do parto */
const reserva = (id: number, idSolicitacao: number, qtdM: number, doParto: ReturnType<typeof pedidoNoParto>[]) => ({
  id,
  qtdM,
  qtdF: 0,
  remessa: { idSolicitacao },
  parto: {
    id: 50,
    ordem: 5,
    nascidoM: 5,
    nascidoF: 5,
    eutanasiadoM: 1,
    eutanasiadoF: 1,
    desmamadoM: 2,
    desmamadoF: 4,
    compromissos: doParto,
    casal: { idCaixa: 3, caixa: { codigo: 'A1B' } },
  },
})

beforeEach(() => {
  banco.solicitacao = { id: 12, status: 'AP' }
  banco.reservas = [reserva(70, 12, 4, [pedidoNoParto(12, 4)])]
  banco.devolvidas = 1
  banco.mudancaDeStatus = null
  banco.canceladas = null
  banco.historico = null
})

describe('desfazer a reserva em falta do pedido', () => {
  it('cancela as reservas, volta para aprovado aguardando animais e grava no historico com quem desfez', async () => {
    await expect(desfazerReserva(12, tecnica)).resolves.toEqual({ idSolicitacao: 12, status: 'em_atendimento' })

    // o pedido continua aprovado: nao volta para a analise nem recomeca prazo de resposta
    expect(banco.mudancaDeStatus).toEqual({ where: { id: 12, status: 'AP' }, data: { status: 'AT' } })
    expect(banco.canceladas).toMatchObject({
      where: { id: { in: [70] }, dtCancelamento: null },
      data: { dtCancelamento: expect.any(Date), motivoCancelamento: expect.stringContaining('Reserva desfeita') },
    })
    expect(banco.historico).toMatchObject({
      idUsuario: 9,
      entidade: 'solicitacao',
      idEntidade: 12,
      acao: 'devolucao',
      dados: { falta: { m: 2, f: 0 } },
    })
  })

  it('so o pedido com animais reservados tem reserva para desfazer', async () => {
    banco.solicitacao = { id: 12, status: 'EN' }

    await expect(desfazerReserva(12, tecnica)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.historico).toBeNull()
  })

  it('a reserva que nao esta em falta nao e desfeita', async () => {
    banco.reservas = [reserva(70, 12, 2, [pedidoNoParto(12, 2)])]

    await expect(desfazerReserva(12, tecnica)).rejects.toEqual(recusa(409, 'SEQUENCIA_INVALIDA'))
    expect(banco.canceladas).toBeNull()
  })

  it('recusa com mensagem clara quando a reserva de outro pedido sozinha ja passa da ninhada', async () => {
    // 2 machos desmamados; o #12 reservou 1 e o #15, 3: sem o #12 ainda faltaria 1
    banco.reservas = [reserva(70, 12, 1, [pedidoNoParto(12, 1), pedidoNoParto(15, 3)])]

    await expect(desfazerReserva(12, tecnica)).rejects.toEqual(
      expect.objectContaining({ status: 409, message: expect.stringContaining('#15') }),
    )
    expect(banco.canceladas).toBeNull()
  })
})

describe('quanto falta de cada pedido aceito', () => {
  it('cada pedido pode ficar sem ate o que reservou na ninhada, nunca mais do que falta nela', async () => {
    // 2 machos desmamados, 5 reservados: faltam 3. O #12 reservou 4 e o #15, 1
    const doParto = [pedidoNoParto(12, 4), pedidoNoParto(15, 1)]
    banco.reservas = [reserva(70, 12, 4, doParto), reserva(71, 15, 1, doParto)]

    const falta = await faltaDosPedidos([12, 15, 20])

    expect(falta.get(12)).toEqual({ m: 3, f: 0 })
    expect(falta.get(15)).toEqual({ m: 1, f: 0 })
    expect(falta.has(20)).toBe(false)
  })
})
