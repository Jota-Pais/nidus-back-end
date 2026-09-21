// RN-05: datas previstas sao derivadas, nunca digitadas

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

/** O primeiro ciclo do casal, a partir do acasalamento digitado (RF-REP-01) */
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

/** O ciclo seguinte, a partir do parto REAL do anterior (RF-REP-03). */
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
