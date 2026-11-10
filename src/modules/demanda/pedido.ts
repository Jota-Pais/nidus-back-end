// O pedido de animais, sem banco: os status, quem pode o que em cada um e a conta da reserva contra
// o que ele pede. A conta (falta e teto) e a de colonia/reserva.ts, a mesma do banco

import { erroDeRegra } from '../../shared/erros.ts'
import { faltaDaReserva, passaDoPedido, temFalta } from '../colonia/reserva.ts'
import type { FaltaDaReserva, Pedido } from '../colonia/reserva.ts'
import { quantosDoSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'

/**
 * enviado (aguardando a analise) | aprovado (aceito, aguardando os animais) | reservado (com os
 * animais reservados) | entregue | recusado. Entregue e recusado sao finais
 */
export const STATUS_DO_PEDIDO = ['enviado', 'aprovado', 'reservado', 'entregue', 'recusado'] as const

export type StatusDoPedido = (typeof STATUS_DO_PEDIDO)[number]

/** Os status que a equipe pode recusar. O reservado solta os animais na recusa */
export const RECUSAVEIS: readonly StatusDoPedido[] = ['enviado', 'aprovado', 'reservado']

/** O status como o banco guarda: o CHECK do dominio so deixa entrar estes */
export function statusDo(pedido: { status: string }): StatusDoPedido {
  const status = STATUS_DO_PEDIDO.find((s) => s === pedido.status)
  if (status === undefined) throw new Error(`Status de pedido fora do dominio: ${JSON.stringify(pedido.status)}`)
  return status
}

/** "2 machos, 1 femea e 3 de qualquer sexo", so com o que nao e zero */
export function descreverQuantidade({ m, f, qualquer }: FaltaDaReserva): string {
  const partes = [
    m > 0 ? quantosDoSexo(m, 'M') : '',
    f > 0 ? quantosDoSexo(f, 'F') : '',
    qualquer > 0 ? `${qualquer} de qualquer sexo` : '',
  ].filter((parte) => parte !== '')

  const ultima = partes.pop() ?? 'nenhum animal'
  return partes.length > 0 ? `${partes.join(', ')} e ${ultima}` : ultima
}

/** O que o pedido pede, como descreverQuantidade le */
export function oQuePede(pedido: Pedido): FaltaDaReserva {
  return { m: pedido.qtdM, f: pedido.qtdF, qualquer: pedido.qtdQualquer }
}

/**
 * Confere a reserva nova contra o pedido: o que ja pesa nele ('tem', vivos reservados mais
 * entregues) mais os 'novos'. Nunca passa do pedido (PEDIDO_EXCEDIDO). Com 'inteira', cobre o
 * pedido todo (PEDIDO_INCOMPLETO): o pedido aprovado so passa a reservado assim. A reserva em
 * falta se completa aos poucos, ate cobrir. O 'qualquer' vira macho ou femea, conforme o que sobrar
 */
export function conferirReserva(pedido: Pedido, tem: PorSexo, novos: PorSexo, inteira: boolean): void {
  const depois = { m: tem.m + novos.m, f: tem.f + novos.f }

  if (passaDoPedido(pedido, depois)) {
    // regra, e nao campo: quem reserva pela busca nao tem campo para corrigir e precisa do motivo
    throw erroDeRegra(
      'PEDIDO_EXCEDIDO',
      `A reserva passa do pedido: ficariam ${descreverQuantidade({ ...depois, qualquer: 0 })} para um pedido de ${descreverQuantidade(oQuePede(pedido))}.`,
    )
  }

  const falta = faltaDaReserva(pedido, depois)

  if (inteira && temFalta(falta)) {
    const quantas = falta.m + falta.f + falta.qualquer

    throw erroDeRegra(
      'PEDIDO_INCOMPLETO',
      `A reserva não cobre o pedido: ${quantas === 1 ? 'falta' : 'faltam'} ${descreverQuantidade(falta)}. Sem animais, recuse com o motivo ou aguarde.`,
    )
  }
}

/** O status como a tela o escreve, para as mensagens de erro */
export const NOME_NA_TELA: Record<StatusDoPedido, string> = {
  enviado: 'aguardando análise',
  aprovado: 'aguardando animais',
  reservado: 'com os animais reservados',
  entregue: 'entregue',
  recusado: 'recusado',
}

/**
 * Se o pedido recebe uma reserva agora: o aprovado, inteira; o reservado, so para completar a
 * falta. 'falta' e a do pedido hoje
 */
export function exigirQueRecebeReserva(idPedido: number, status: StatusDoPedido, falta: FaltaDaReserva): void {
  if (status === 'aprovado') return
  if (status === 'reservado' && temFalta(falta)) return

  if (status === 'reservado') {
    // o caso comum: dois tecnicos, ou dois cliques em Reservar
    throw erroDeRegra('PEDIDO_JA_RESERVADO', `Os animais do pedido #${idPedido} já estão reservados.`)
  }

  if (status === 'enviado') {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Aprove o pedido antes de reservar os animais.')
  }

  throw erroDeRegra('SEQUENCIA_INVALIDA', `O pedido #${idPedido} está ${NOME_NA_TELA[status]} e não recebe mais animais.`)
}
