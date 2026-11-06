// Pedido aceito cuja reserva ficou em falta: o desmame ou a correcao gravaram o que aconteceu
// de verdade, com menos animais do que o reservado. A equipe devolve o pedido para analise e
// aloca de novo. O pesquisador nao e avisado

import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { statusSolicitacao } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { compromissosAtivosComPedido, faltaNaReserva } from '../reproducao/disponibilidade.ts'
import type { PorSexo } from '../reproducao/disponibilidade.ts'

/** A acao no historico. A devolucao recomeca o prazo de resposta do pedido */
export const ACAO_DEVOLUCAO = 'devolucao'

const MOTIVO_DO_CANCELAMENTO = 'Pedido devolvido para analise: a reserva ficou em falta'

/** As reservas ativas dos pedidos, cada uma com o parto e tudo o que esta reservado nele */
function reservasDos(idsSolicitacao: number[]) {
  return prisma.compromisso.findMany({
    where: { dtCancelamento: null, remessa: { idSolicitacao: { in: idsSolicitacao } } },
    select: {
      id: true,
      qtdM: true,
      qtdF: true,
      remessa: { select: { idSolicitacao: true } },
      parto: {
        select: {
          ordem: true,
          nascidoM: true,
          nascidoF: true,
          eutanasiadoM: true,
          eutanasiadoF: true,
          desmamadoM: true,
          desmamadoF: true,
          compromissos: compromissosAtivosComPedido,
          casal: { select: { idCaixa: true, caixa: { select: { codigo: true } } } },
        },
      },
    },
  })
}

type Reserva = Awaited<ReturnType<typeof reservasDos>>[number]

/**
 * Numa ninhada em falta, cada pedido com reserva nela pode ficar sem ate o que reservou ali, e
 * nunca mais do que falta na ninhada. Pedido sem falta nao entra
 */
function faltaPorPedido(reservas: Reserva[]): Map<number, PorSexo> {
  const porPedido = new Map<number, PorSexo>()

  for (const reserva of reservas) {
    const falta = faltaNaReserva(reserva.parto)
    if (falta === null) continue

    const id = reserva.remessa.idSolicitacao
    const somado = porPedido.get(id) ?? { m: 0, f: 0 }
    porPedido.set(id, {
      m: somado.m + Math.min(falta.m, reserva.qtdM),
      f: somado.f + Math.min(falta.f, reserva.qtdF),
    })
  }

  return new Map([...porPedido].filter(([, falta]) => falta.m + falta.f > 0))
}

/** Quanto falta de cada pedido, para a lista de solicitacoes marcar a reserva em falta */
export async function faltaDosPedidos(idsSolicitacao: number[]): Promise<Map<number, PorSexo>> {
  if (idsSolicitacao.length === 0) return new Map()

  return faltaPorPedido(await reservasDos(idsSolicitacao))
}

/** Os pedidos devolvidos para analise depois de 'desde': o prazo de resposta deles recomecou */
export async function devolvidosDesde(idsSolicitacao: number[], desde: Date): Promise<Set<number>> {
  if (idsSolicitacao.length === 0) return new Set()

  const devolucoes = await prisma.historico.findMany({
    where: {
      entidade: 'solicitacao',
      acao: ACAO_DEVOLUCAO,
      idEntidade: { in: idsSolicitacao },
      dtHora: { gt: desde },
    },
    select: { idEntidade: true },
  })

  return new Set(devolucoes.map((devolucao) => devolucao.idEntidade))
}

/**
 * POST /api/solicitacoes/:id/devolucao - o pedido aceito com reserva em falta volta para
 * "Aguardando analise": as reservas dele sao canceladas (nada se apaga) e a caixa que ficou sem
 * reserva volta de Pre-reserva para Livres, o inverso da alocacao
 */
export async function devolverParaAnalise(idSolicitacao: number, usuario: UsuarioDaSessao) {
  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id: idSolicitacao },
    select: { id: true, status: true },
  })

  if (solicitacao === null) {
    throw naoEncontrado('Solicitacao')
  }

  if (solicitacao.status !== 'AP') {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A solicitacao #${idSolicitacao} nao esta aceita: so o pedido aceito volta para analise.`,
    )
  }

  const reservas = await reservasDos([idSolicitacao])
  const falta = faltaPorPedido(reservas).get(idSolicitacao)

  if (falta === undefined) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A reserva da solicitacao #${idSolicitacao} nao esta em falta: nao ha o que devolver.`,
    )
  }

  // O trigger compromisso_respeita_oferta roda tambem no cancelamento e recusa a ninhada que
  // continua com mais reserva do que animais. Confere antes, para dar a mensagem certa
  for (const reserva of reservas) {
    const outros = reserva.parto.compromissos.filter(
      (c) => c.remessa.idSolicitacao !== idSolicitacao,
    )

    if (faltaNaReserva({ ...reserva.parto, compromissos: outros }) !== null) {
      const pedidos = [...new Set(outros.map((c) => `#${c.remessa.idSolicitacao}`))].join(', ')

      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `A ninhada do ${reserva.parto.ordem}o parto da caixa ${reserva.parto.casal.caixa.codigo} tambem esta reservada para ${pedidos}, e essa reserva sozinha ja passa do que a ninhada tem. Por enquanto o sistema nao devolve um pedido so nesse caso.`,
      )
    }
  }

  const caixas = [...new Set(reservas.map((reserva) => reserva.parto.casal.idCaixa))]

  await prisma.$transaction(async (tx) => {
    const devolvida = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: 'AP' },
      data: { status: 'EN' },
    })

    if (devolvida.count === 0) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `A solicitacao #${idSolicitacao} nao esta mais aceita.`)
    }

    await tx.compromisso.updateMany({
      where: { id: { in: reservas.map((reserva) => reserva.id) }, dtCancelamento: null },
      data: { dtCancelamento: new Date(), motivoCancelamento: MOTIVO_DO_CANCELAMENTO },
    })

    const aindaReservadas = await tx.compromisso.findMany({
      where: { dtCancelamento: null, parto: { casal: { idCaixa: { in: caixas } } } },
      select: { parto: { select: { casal: { select: { idCaixa: true } } } } },
    })
    const semReserva = caixas.filter(
      (idCaixa) => !aindaReservadas.some((c) => c.parto.casal.idCaixa === idCaixa),
    )

    if (semReserva.length > 0) {
      await tx.caixa.updateMany({
        where: { id: { in: semReserva }, estado: 'P' },
        data: { estado: 'R' },
      })
    }

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'solicitacao',
      idEntidade: idSolicitacao,
      acao: ACAO_DEVOLUCAO,
      descricao: `Solicitacao #${idSolicitacao} devolvida para analise: a reserva ficou em falta (${falta.m} M, ${falta.f} F)`,
      dados: {
        falta,
        reservasCanceladas: reservas.map((reserva) => ({
          idCompromisso: reserva.id,
          qtdM: reserva.qtdM,
          qtdF: reserva.qtdF,
        })),
      },
    })
  })

  return { idSolicitacao, status: statusSolicitacao.paraApi('EN') }
}
