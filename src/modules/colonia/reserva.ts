// A conta da reserva de um pedido contra o que ele pede: M machos, F femeas e Q de qualquer sexo.
// Conta os animais que pesam no pedido, vivos reservados mais entregues. E a mesma formula do
// trigger colonia.animal_coerente (o teto) e de demanda.pedido_recusado (a cobertura), vista do
// codigo: o qualquer vira macho ou femea, conforme o que sobrar.

import { somarUm } from './tipos.ts'
import type { PorSexo, Sexo } from './tipos.ts'

export type Pedido = { qtdM: number; qtdF: number; qtdQualquer: number }

export type FaltaDaReserva = PorSexo & { qualquer: number }

/**
 * O que falta para os animais do pedido cobrirem o que ele pede. Os machos e as femeas acima do
 * pedido cobrem o qualquer
 */
export function faltaDaReserva(pedido: Pedido, tem: PorSexo): FaltaDaReserva {
  const sobraM = Math.max(0, tem.m - pedido.qtdM)
  const sobraF = Math.max(0, tem.f - pedido.qtdF)

  return {
    m: Math.max(0, pedido.qtdM - tem.m),
    f: Math.max(0, pedido.qtdF - tem.f),
    qualquer: Math.max(0, pedido.qtdQualquer - sobraM - sobraF),
  }
}

export function temFalta(falta: FaltaDaReserva): boolean {
  return falta.m + falta.f + falta.qualquer > 0
}

/**
 * Se mais um animal do sexo cabe no pedido: M <= qtdM + qualquer, F <= qtdF + qualquer e
 * M + F <= o total pedido. O teto que o trigger do animal cobra
 */
export function cabeNaReserva(pedido: Pedido, tem: PorSexo, sexo: Sexo): boolean {
  const m = tem.m + (sexo === 'M' ? 1 : 0)
  const f = tem.f + (sexo === 'F' ? 1 : 0)

  return (
    m <= pedido.qtdM + pedido.qtdQualquer &&
    f <= pedido.qtdF + pedido.qtdQualquer &&
    m + f <= pedido.qtdM + pedido.qtdF + pedido.qtdQualquer
  )
}

/** Um pedido como a anulacao o le: o status, o que pede e o que ja pesa nele */
export type SituacaoDoPedido = { status: string; pedido: Pedido; tem: PorSexo }

/**
 * Na anulacao da baixa, quais animais voltam sem a reserva que tinham. Volta reservado so o
 * animal de pedido que continua reservado e ainda o comporta (o teto, contando os que ja voltaram
 * nesta anulacao); o pedido aprovado, recusado ou entregue nao segura animal vivo. Os outros
 * voltam livres
 */
export function soltosNaAnulacao(
  animais: { id: number; sexo: Sexo; idPedido: number | null }[],
  pedidos: Map<number, SituacaoDoPedido>,
): number[] {
  const tem = new Map([...pedidos.entries()].map(([id, situacao]) => [id, situacao.tem]))
  const soltos: number[] = []

  for (const animal of [...animais].sort((a, b) => a.id - b.id)) {
    if (animal.idPedido === null) continue

    const situacao = pedidos.get(animal.idPedido)
    const contagem = tem.get(animal.idPedido)

    if (
      situacao !== undefined &&
      contagem !== undefined &&
      situacao.status === 'reservado' &&
      cabeNaReserva(situacao.pedido, contagem, animal.sexo)
    ) {
      tem.set(animal.idPedido, somarUm(contagem, animal.sexo))
    } else {
      soltos.push(animal.id)
    }
  }

  return soltos
}
