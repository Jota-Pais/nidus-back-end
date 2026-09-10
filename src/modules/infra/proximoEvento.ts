// O que vence a seguir num ciclo reprodutivo - `proximoEvento` da secao 5 do
// contrato, e a materia-prima do painel de alertas do `RF-REP-07`.
//
// Funcao pura de proposito: e regra de negocio com tres ramos e uma comparacao
// de data, o tipo de coisa que nao se testa contra o banco. O servico traz as
// linhas, isto decide.
//
// Datas circulam como `aaaa-mm-dd` (contrato secao 1). Comparar string ISO e
// exatamente equivalente a comparar a data e imune a fuso - `new Date()` no
// meio do caminho e que desloca um dia.

import type { GrauCerteza } from '../../shared/traducao.ts'

export type TipoDeEvento = 'parto_previsto' | 'desmame_previsto' | 'reacasalamento_liberado'

export type ProximoEvento = {
  tipo: TipoDeEvento
  data: string
  /**
   * A data prevista passou sem confirmacao.
   *
   * E o alerta mais importante do `RF-REP-07`. Quando alguem deixa de confirmar
   * um parto, a grade, o quadro e o motor passam a mentir juntos, sem avisar
   * ninguem. So evento que ESPERA confirmacao pode estar atrasado -
   * reacasalamento liberado nao tem o que confirmar.
   */
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
  /** `RN-04` - 5 no Anexo A, mas e parametro, nao constante. */
  maxCiclos: number
  /** `RN-05` - reacasalamento libera em parto real + intervalo. */
  intervaloCicloDias: number
  hoje: string
}

/** Soma dias a uma data `aaaa-mm-dd`, em UTC, devolvendo `aaaa-mm-dd`. */
export function somarDias(data: string, dias: number): string {
  const calendario = new Date(`${data}T00:00:00.000Z`)
  calendario.setUTCDate(calendario.getUTCDate() + dias)
  return calendario.toISOString().slice(0, 10)
}

/**
 * O proximo evento do ciclo corrente, ou `null` quando nao ha nada pendente.
 *
 * A ordem dos ramos e a sequencia do proprio ciclo, e nao a data mais proxima -
 * decisao que vale registrar porque as duas leituras divergem: `RN-05` libera o
 * reacasalamento em parto real + 6 dias, o que cai ANTES do desmame previsto
 * (parto + 22). Ordenar por data poria "reacasalamento liberado" na frente e
 * esconderia o desmame a confirmar - justamente a confirmacao que o `RF-REP-07`
 * existe para cobrar. A ordem aqui e a da lista numerada do painel de alertas:
 * parto, desmame, reacasalamento.
 */
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

  // Ciclo fechado. `RN-04`: no 5o parto o casal encerra e o que entra na pauta e
  // planejar reposicao, nao reacasalar - por isso nao ha proximo evento aqui.
  if (ciclo.ordem >= maxCiclos) {
    return null
  }

  return {
    tipo: 'reacasalamento_liberado',
    data: somarDias(ciclo.dtPartoReal, intervaloCicloDias),
    atrasado: false,
  }
}

/**
 * `RN-08` - grau de certeza da oferta, o `COALESCE` de tres niveis da secao 5.1
 * do modelo de dados, na versao lida do ciclo em memoria.
 *
 * O banco guarda `grau_certeza` em coluna, mas quem confirma um evento tem de
 * manter as duas coisas de acordo; esta funcao e a definicao unica de qual
 * deveria ser o valor.
 */
export function calcularGrauCerteza(ciclo: {
  dtPartoReal: string | null
  dtDesmameReal: string | null
}): GrauCerteza {
  if (ciclo.dtDesmameReal !== null) return 'confirmado'
  if (ciclo.dtPartoReal !== null) return 'previsto'
  return 'projetado'
}
