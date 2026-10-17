// Cadeia temporal dos partos (spec do cliente, secao 1.13): as datas previstas sao
// derivadas, nunca digitadas

/** Soma dias a uma data 'aaaa-mm-dd', em UTC, devolvendo 'aaaa-mm-dd' */
export function somarDias(data: string, dias: number): string {
  const calendario = new Date(`${data}T00:00:00.000Z`)
  calendario.setUTCDate(calendario.getUTCDate() + dias)
  return calendario.toISOString().slice(0, 10)
}

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

/** O primeiro ciclo do casal, a partir do acasalamento digitado */
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

/** O ciclo seguinte, a partir do parto REAL do anterior. */
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
