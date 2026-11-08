// Pedido com animais reservados cuja reserva ficou em falta: o desmame ou a correcao gravaram o
// que aconteceu de verdade, com menos animais do que o reservado. A equipe desfaz a reserva e o
// pedido, que continua aprovado, volta a aguardar animais para reservar de novo. O pesquisador
// nao e avisado

import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { statusSolicitacao } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { compromissosAtivosComPedido, faltaNaReserva } from '../reproducao/disponibilidade.ts'
import type { PorSexo } from '../reproducao/disponibilidade.ts'

/**
 * A acao no historico quando a reserva em falta e desfeita. Antes da aprovacao separada, essa
 * devolucao voltava o pedido para analise e recomecava o prazo de resposta (devolvidosDesde)
 */
export const ACAO_DEVOLUCAO = 'devolucao'

const MOTIVO_DO_CANCELAMENTO = 'Reserva desfeita: a ninhada ficou com menos animais do que o reservado'

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

/**
 * Os pedidos devolvidos para analise depois de 'desde': o prazo de resposta deles recomecou. So a
 * devolucao de antes da aprovacao separada deixava o pedido enviado
 */
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
 * POST /api/solicitacoes/:id/devolucao - desfaz a reserva em falta: as reservas do pedido sao
 * canceladas (nada se apaga), o inverso da alocacao, e o pedido continua aprovado, aguardando
 * animais
 */
export async function desfazerReserva(idSolicitacao: number, usuario: UsuarioDaSessao) {
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
      `A solicitacao #${idSolicitacao} nao tem animais reservados: nao ha reserva para desfazer.`,
    )
  }

  const reservas = await reservasDos([idSolicitacao])
  const falta = faltaPorPedido(reservas).get(idSolicitacao)

  if (falta === undefined) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A reserva da solicitacao #${idSolicitacao} nao esta em falta: nao ha o que desfazer.`,
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
        `A ninhada do ${reserva.parto.ordem}o parto da caixa ${reserva.parto.casal.caixa.codigo} tambem esta reservada para ${pedidos}, e essa reserva sozinha ja passa do que a ninhada tem. Por enquanto o sistema nao desfaz a reserva de um pedido so nesse caso.`,
      )
    }
  }

  await prisma.$transaction(async (tx) => {
    const desfeita = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: 'AP' },
      data: { status: 'AT' },
    })

    if (desfeita.count === 0) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        `A solicitacao #${idSolicitacao} nao esta mais com os animais reservados.`,
      )
    }

    await tx.compromisso.updateMany({
      where: { id: { in: reservas.map((reserva) => reserva.id) }, dtCancelamento: null },
      data: { dtCancelamento: new Date(), motivoCancelamento: MOTIVO_DO_CANCELAMENTO },
    })

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'solicitacao',
      idEntidade: idSolicitacao,
      acao: ACAO_DEVOLUCAO,
      descricao: `Reserva da solicitacao #${idSolicitacao} desfeita: a reserva ficou em falta (${falta.m} M, ${falta.f} F)`,
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

  return { idSolicitacao, status: statusSolicitacao.paraApi('AT') }
}
