// O que vence a seguir num ciclo reprodutivo - 'proximoEvento' da secao 5 do contrato e a
// materia-prima do painel de alertas do RF-REP-07.

export type TipoDeEvento = 'parto_previsto' | 'desmame_previsto' | 'reacasalamento_liberado'

export type ProximoEvento = {
  tipo: TipoDeEvento
  data: string
  /** A data prevista passou sem confirmacao */
  atrasado: boolean
}

export type CicloParaEvento = {
  ordem: number
  dtPartoPrevisto: string
  dtPartoReal: string | null
  dtDesmamePrevisto: string
  dtDesmameReal: string | null
}

export type ContextoDoCiclo = {
  /** RN-04 - 5 no Anexo A mas e parametro, nao constante */
  maxCiclos: number
  /** RN-05 - reacasalamento libera em parto real + intervalo */
  intervaloCicloDias: number
  hoje: string
}

/** Soma dias a uma data 'aaaa-mm-dd', em UTC, devolvendo 'aaaa-mm-dd' */
export function somarDias(data: string, dias: number): string {
  const calendario = new Date(`${data}T00:00:00.000Z`)
  calendario.setUTCDate(calendario.getUTCDate() + dias)
  return calendario.toISOString().slice(0, 10)
}

/** O proximo evento do ciclo corrente, ou null quando nao ha nada pendente */
export function calcularProximoEvento(
  ciclo: CicloParaEvento | undefined,
  { maxCiclos, intervaloCicloDias, hoje }: ContextoDoCiclo,
): ProximoEvento | null {
  if (ciclo === undefined) {
    return null
  }

  if (ciclo.dtPartoReal === null) {
    return {
      tipo: 'parto_previsto',
      data: ciclo.dtPartoPrevisto,
      atrasado: ciclo.dtPartoPrevisto < hoje,
    }
  }

  if (ciclo.dtDesmameReal === null) {
    return {
      tipo: 'desmame_previsto',
      data: ciclo.dtDesmamePrevisto,
      atrasado: ciclo.dtDesmamePrevisto < hoje,
    }
  }

  // Ciclo fechado. RN-04: no 5o parto o casal encerra e o que entra na
  // pauta e planejar reposicao, nao reacasalar - por isso nao ha proximo
  // evento aqui.
  if (ciclo.ordem >= maxCiclos) {
    return null
  }

  return {
    tipo: 'reacasalamento_liberado',
    data: somarDias(ciclo.dtPartoReal, intervaloCicloDias),
    atrasado: false,
  }
}
