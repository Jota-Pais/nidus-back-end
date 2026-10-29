// Quanto um parto tem para oferecer, e com que confiança

import { ESPERADOS_POR_CASAL } from '../../shared/parametros.ts'
import type { GrauCerteza } from '../../shared/traducao.ts'

/** Quantidade por sexo. É como a API conta animal em todo lugar. */
export type PorSexo = {
  m: number
  f: number
}

/** O que de um ciclo importa para o cálculo. Nada de datas: só contagem. */
export type ContagemDoCiclo = {
  nascidoM: number | null
  nascidoF: number | null
  eutanasiadoM: number | null
  eutanasiadoF: number | null
  desmamadoM: number | null
  desmamadoF: number | null
}

/** O grau de certeza sai da mesma cascata da oferta. */
export function calcularGrauCerteza(ciclo: ContagemDoCiclo): GrauCerteza {
  if (ciclo.desmamadoM !== null && ciclo.desmamadoF !== null) {
    return 'confirmado'
  }

  if (ciclo.nascidoM !== null && ciclo.nascidoF !== null) {
    return 'previsto'
  }

  return 'projetado'
}

/**
 * A oferta BRUTA do parto - o COALESCE de três níveis, sem descontar nada. Parto que ainda
 * não nasceu oferece o esperado por casal (4M/4F)
 */
export function ofertaBruta(ciclo: ContagemDoCiclo): PorSexo {
  if (ciclo.desmamadoM !== null && ciclo.desmamadoF !== null) {
    return { m: ciclo.desmamadoM, f: ciclo.desmamadoF }
  }

  if (ciclo.nascidoM !== null && ciclo.nascidoF !== null) {
    // Seleção ausente conta zero: nulo em eutanasiado anularia a subtração em SQL
    return {
      m: ciclo.nascidoM - (ciclo.eutanasiadoM ?? 0),
      f: ciclo.nascidoF - (ciclo.eutanasiadoF ?? 0),
    }
  }

  return { m: ESPERADOS_POR_CASAL.m, f: ESPERADOS_POR_CASAL.f }
}

export type Disponibilidade = {
  grauCerteza: GrauCerteza
  /** Oferta bruta: o teto do que se pode comprometer */
  oferta: PorSexo
  /** soma dos compromissos ativos */
  comprometido: PorSexo
  /** O que ainda dá para prometer - já líquido. */
  disponivel: PorSexo
}

/** disponibilidade completa de um ciclo. É esta a função que a ficha, a alocação e a busca chamam */
export function calcularDisponibilidade(
  ciclo: ContagemDoCiclo,
  comprometido: PorSexo,
): Disponibilidade {
  const oferta = ofertaBruta(ciclo)

  return {
    grauCerteza: calcularGrauCerteza(ciclo),
    oferta,
    comprometido,
    disponivel: {
      m: Math.max(0, oferta.m - comprometido.m),
      f: Math.max(0, oferta.f - comprometido.f),
    },
  }
}
