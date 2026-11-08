// A caixa de estoque, na conta. Depois do desmame os filhotes saem da caixa do casal para caixas
// de estoque, cada uma com um sexo e uma linhagem. A reserva continua no parto
// (demanda.compromisso) e o motor nao muda: aqui se decide em que caixa estao os animais de cada
// reserva, para o kanban e a grade mostrarem quantos reservados cada caixa tem e para a entrega
// dizer de onde tirar

import { naCaixa } from '../reproducao/disponibilidade.ts'
import type {
  CompromissoComEntrega,
  ContagemDoCiclo,
  PorSexo,
} from '../reproducao/disponibilidade.ts'

export type Sexo = 'M' | 'F'

export const SEXOS: Sexo[] = ['M', 'F']

/** Os desmamados do parto numa caixa de estoque, no sexo dela. `qtd` e o que esta la agora */
export type LoteDoParto = { id: number; idCaixa: number; qtd: number; caixa: { sexo: string | null } }

/** Uma reserva ativa do parto, com o pedido e a data em que saiu (null: ainda a entregar) */
export type ReservaDoParto = {
  id: number
  qtdM: number
  qtdF: number
  remessa: { idSolicitacao: number; dtRealizada: Date | null }
}

export type PartoComLugares = ContagemDoCiclo & {
  id: number
  compromissos: ReservaDoParto[]
  lotes: LoteDoParto[]
}

/** O select do Prisma de 'PartoComLugares' */
export const selecaoDoPartoComLugares = {
  id: true,
  nascidoM: true,
  nascidoF: true,
  eutanasiadoM: true,
  eutanasiadoF: true,
  desmamadoM: true,
  desmamadoF: true,
  compromissos: {
    where: { dtCancelamento: null },
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      qtdM: true,
      qtdF: true,
      remessa: { select: { idSolicitacao: true, dtRealizada: true } },
    },
  },
  lotes: {
    orderBy: { id: 'asc' as const },
    select: { id: true, idCaixa: true, qtd: true, caixa: { select: { sexo: true } } },
  },
}

const deSexo = (sexo: Sexo, porSexo: PorSexo) => (sexo === 'M' ? porSexo.m : porSexo.f)

/** Quantos animais do parto estao nas caixas de estoque, por sexo */
export function noEstoque(parto: { lotes: Pick<LoteDoParto, 'qtd' | 'caixa'>[] }): PorSexo {
  return parto.lotes.reduce(
    (soma, lote) =>
      lote.caixa.sexo === 'M' ? { ...soma, m: soma.m + lote.qtd } : { ...soma, f: soma.f + lote.qtd },
    { m: 0, f: 0 },
  )
}

/**
 * O que do parto ainda esta na caixa do casal: o que existe, menos o entregue, menos o que foi
 * para o estoque. Antes do desmame e a ninhada mamando
 */
export function naCaixaDoCasal(
  parto: ContagemDoCiclo & {
    compromissos: CompromissoComEntrega[]
    lotes: Pick<LoteDoParto, 'qtd' | 'caixa'>[]
  },
): PorSexo {
  const resta = naCaixa(parto)
  const estoque = noEstoque(parto)

  return { m: Math.max(0, resta.m - estoque.m), f: Math.max(0, resta.f - estoque.f) }
}

/** De onde sai parte de uma reserva: a caixa do casal (idCaixa null) ou uma caixa de estoque */
export type Retirada = { idCaixa: number | null; qtd: number }

/**
 * Os lugares dos animais do parto num sexo, na ordem da retirada: primeiro o que sobrou na caixa
 * do casal, que assim fica livre para o parto seguinte, depois as caixas de estoque, da que
 * recebeu primeiro
 */
function lugaresDoParto(parto: PartoComLugares, sexo: Sexo): Retirada[] {
  return [
    { idCaixa: null, qtd: deSexo(sexo, naCaixaDoCasal(parto)) },
    ...parto.lotes
      .filter((lote) => lote.caixa.sexo === sexo && lote.qtd > 0)
      .map((lote) => ({ idCaixa: lote.idCaixa, qtd: lote.qtd })),
  ]
}

/**
 * Em que lugar estao os animais de cada reserva a entregar do parto, num sexo, na ordem da
 * retirada e a reserva mais antiga primeiro. A reserva que passa do que existe fica com menos
 * retirada (e a falta na reserva, ou o parto que ainda nao nasceu)
 */
export function reservasNosLugares(parto: PartoComLugares, sexo: Sexo): Map<number, Retirada[]> {
  return tirarAsReservas(parto, sexo, lugaresDoParto(parto, sexo))
}

/**
 * Onde estao os animais livres do parto num sexo: o que sobra em cada lugar depois das reservas a
 * entregar, tiradas na mesma ordem. E o que a busca de atendimento oferece
 */
export function livresNosLugares(parto: PartoComLugares, sexo: Sexo): Retirada[] {
  const lugares = lugaresDoParto(parto, sexo)
  tirarAsReservas(parto, sexo, lugares)
  return lugares.filter((lugar) => lugar.qtd > 0)
}

/** Tira dos lugares as reservas a entregar do parto, e diz de onde saiu cada uma */
function tirarAsReservas(
  parto: PartoComLugares,
  sexo: Sexo,
  lugares: Retirada[],
): Map<number, Retirada[]> {
  const porReserva = new Map<number, Retirada[]>()

  for (const reserva of parto.compromissos) {
    if (reserva.remessa.dtRealizada !== null) continue

    let falta = sexo === 'M' ? reserva.qtdM : reserva.qtdF
    const retiradas: Retirada[] = []

    for (const lugar of lugares) {
      if (falta === 0) break
      const tira = Math.min(falta, lugar.qtd)
      if (tira === 0) continue

      lugar.qtd -= tira
      falta -= tira
      retiradas.push({ idCaixa: lugar.idCaixa, qtd: tira })
    }

    porReserva.set(reserva.id, retiradas)
  }

  return porReserva
}

/**
 * Quantos animais reservados ha em cada caixa de estoque. Os partos tem de vir com todos os lotes
 * deles, de todas as caixas: a distribuicao depende da ordem entre elas
 */
export function reservadosPorCaixa(partos: PartoComLugares[]): Map<number, number> {
  const porCaixa = new Map<number, number>()

  for (const parto of partos) {
    for (const sexo of SEXOS) {
      for (const retiradas of reservasNosLugares(parto, sexo).values()) {
        for (const { idCaixa, qtd } of retiradas) {
          if (idCaixa !== null) porCaixa.set(idCaixa, (porCaixa.get(idCaixa) ?? 0) + qtd)
        }
      }
    }
  }

  return porCaixa
}

/**
 * Quanto da reserva a entregar dos partos ainda pesa na caixa do casal: o que nao esta em caixa
 * de estoque. Inclui a reserva de ninhada que ainda mama. E o "res." da caixa do casal no kanban e
 * na grade
 */
export function reservadoNaCaixaDoCasal(partos: PartoComLugares[]): number {
  let total = 0

  for (const parto of partos) {
    for (const sexo of SEXOS) {
      const lugares = reservasNosLugares(parto, sexo)

      for (const reserva of parto.compromissos) {
        if (reserva.remessa.dtRealizada !== null) continue

        const pedido = sexo === 'M' ? reserva.qtdM : reserva.qtdF
        const noEstoqueDela = (lugares.get(reserva.id) ?? [])
          .filter((retirada) => retirada.idCaixa !== null)
          .reduce((soma, retirada) => soma + retirada.qtd, 0)

        total += pedido - noEstoqueDela
      }
    }
  }

  return total
}

/** A coluna da caixa de estoque com animal: Reserva quando todos estao reservados, senao Estoque */
export function colunaDoEstoque(total: number, reservados: number): 'E' | 'T' {
  return total > 0 && reservados >= total ? 'T' : 'E'
}
