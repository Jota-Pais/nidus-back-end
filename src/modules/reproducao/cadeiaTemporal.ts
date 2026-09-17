// RN-05: datas previstas sao derivadas, nunca digitadas.
//
//   Parto previsto      = acasalamento + gestacao
//   Desmame previsto    = parto previsto + aleitamento
//   Acasalamento (n≥2)  = parto REAL do ciclo n-1 + intervalo
//
// So se digita o primeiro acasalamento e as datas reais; o resto e calculado
// aqui. Ciclo n+1 so passa a existir quando o parto real do ciclo n e
// confirmado (`reproducao.service.ts` cria a linha nesse momento) - e por isso
// esta funcao nunca recebe "parto previsto" como base do proximo acasalamento,
// so parto real. A massa de teste da colonia segue a mesma regra: um casal "no
// 3o ciclo" tem os dois anteriores com data real, nunca projetada.
//
// Funcao pura de proposito, como `disponibilidade.ts` e `proximoEvento.ts`: e
// aritmetica de data com regra de negocio, nao consulta.

import { somarDias } from '../infra/proximoEvento.ts'

export type ParametroDoCiclo = {
  gestacaoDias: number
  aleitamentoDias: number
  intervaloCicloDias: number
}

export type CicloCalculado = {
  dtAcasalamento: string
  dtPartoPrevisto: string
  dtDesmamePrevisto: string
}

/** O primeiro ciclo do casal, a partir do acasalamento digitado (`RF-REP-01`). */
export function calcularCicloInicial(
  dtFormacao: string,
  parametro: ParametroDoCiclo,
): CicloCalculado {
  const dtPartoPrevisto = somarDias(dtFormacao, parametro.gestacaoDias)

  return {
    dtAcasalamento: dtFormacao,
    dtPartoPrevisto,
    dtDesmamePrevisto: somarDias(dtPartoPrevisto, parametro.aleitamentoDias),
  }
}

/**
 * O ciclo seguinte, a partir do parto REAL do anterior (`RF-REP-03`).
 *
 * Chamada no momento em que esse parto real e confirmado - nunca antes, e por
 * isso o parametro e uma data, nao um ciclo com data opcional.
 */
export function calcularProximoCiclo(
  dtPartoRealAnterior: string,
  parametro: ParametroDoCiclo,
): CicloCalculado {
  const dtAcasalamento = somarDias(dtPartoRealAnterior, parametro.intervaloCicloDias)
  const dtPartoPrevisto = somarDias(dtAcasalamento, parametro.gestacaoDias)

  return {
    dtAcasalamento,
    dtPartoPrevisto,
    dtDesmamePrevisto: somarDias(dtPartoPrevisto, parametro.aleitamentoDias),
  }
}
