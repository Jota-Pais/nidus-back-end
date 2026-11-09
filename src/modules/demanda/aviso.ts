// O aviso por e-mail a quem pediu: a aprovacao, a reserva dos animais e a recusa do pedido

import type { Prisma } from '@prisma/client'
import type { ResumoDoPedido } from '../../shared/email.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'

/** O que o pedido traz junto para o aviso */
export const PARA_O_AVISO = {
  linhagem: { select: { nome: true } },
  usuarioSolicitante: { select: { email: true } },
} satisfies Prisma.PedidoInclude

export type PedidoDoAviso = Prisma.PedidoGetPayload<{ include: typeof PARA_O_AVISO }>

/**
 * Avisa por e-mail quem pediu, DEPOIS de a decisao estar gravada. Sem 'await': o envio nao segura
 * a resposta do tecnico, e uma falha do servico de e-mail fica so no log, sem desfazer nada.
 * 'enviar' e o aviso da decisao
 */
export function avisarPesquisador(
  pedido: PedidoDoAviso,
  enviar: (email: string, resumo: ResumoDoPedido) => Promise<void>,
): void {
  enviar(pedido.usuarioSolicitante.email, {
    protocoloCeua: pedido.protocoloCeua,
    linhagem: pedido.linhagem.nome,
    machos: pedido.qtdM,
    femeas: pedido.qtdF,
    qualquer: pedido.qtdQualquer,
    idadeMin: pedido.idadeMinDias,
    idadeMax: pedido.idadeMaxDias,
    dataEntrega: dataISO(pedido.dtDesejada),
    dataPedido: hojeISO(pedido.dtCriacao),
  }).catch((erro: unknown) => {
    console.error(`[pedido] o aviso do pedido #${pedido.id} nao foi enviado:`, erro)
  })
}
