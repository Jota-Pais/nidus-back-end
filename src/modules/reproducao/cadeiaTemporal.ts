// Cadeia temporal dos partos (spec do cliente, secao 1.13): as datas previstas sao
// derivadas, nunca digitadas

import {
  ALEITAMENTO_DIAS,
  GESTACAO_DIAS,
  INTERVALO_ACASALAMENTO_DIAS,
} from '../../shared/parametros.ts'

/** Soma dias a uma data 'aaaa-mm-dd', em UTC, devolvendo 'aaaa-mm-dd' */
export function somarDias(data: string, dias: number): string {
  const calendario = new Date(`${data}T00:00:00.000Z`)
  calendario.setUTCDate(calendario.getUTCDate() + dias)
  return calendario.toISOString().slice(0, 10)
}

export type CicloCalculado = {
  dtAcasalamento: string
  dtPartoPrevisto: string
  dtDesmamePrevisto: string
}

/** O primeiro ciclo do casal, a partir do acasalamento digitado */
export function calcularCicloInicial(dtFormacao: string): CicloCalculado {
  const dtPartoPrevisto = somarDias(dtFormacao, GESTACAO_DIAS)

  return {
    dtAcasalamento: dtFormacao,
    dtPartoPrevisto,
    dtDesmamePrevisto: somarDias(dtPartoPrevisto, ALEITAMENTO_DIAS),
  }
}

/** O ciclo seguinte, a partir do parto REAL do anterior. */
export function calcularProximoCiclo(dtPartoRealAnterior: string): CicloCalculado {
  const dtAcasalamento = somarDias(dtPartoRealAnterior, INTERVALO_ACASALAMENTO_DIAS)
  const dtPartoPrevisto = somarDias(dtAcasalamento, GESTACAO_DIAS)

  return {
    dtAcasalamento,
    dtPartoPrevisto,
    dtDesmamePrevisto: somarDias(dtPartoPrevisto, ALEITAMENTO_DIAS),
  }
}
