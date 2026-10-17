// Quanto um parto tem para oferecer, e com que confiança

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

/** A oferta BRUTA do parto - o COALESCE de três níveis, sem descontar nada. */
export function ofertaBruta(ciclo: ContagemDoCiclo, expectativa: PorSexo): PorSexo {
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

  return { m: expectativa.m, f: expectativa.f }
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

/** disponibilidade completa de um ciclo. É esta a função que a ficha, o quadro e o motor chamam */
export function calcularDisponibilidade(
  ciclo: ContagemDoCiclo,
  { expectativa, comprometido }: { expectativa: PorSexo; comprometido: PorSexo },
): Disponibilidade {
  const oferta = ofertaBruta(ciclo, expectativa)

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

/** Um 'parametro_biologico' como o cálculo precisa ver. */
export type ParametroVigente = {
  /** Nulo vale para a espécie inteira; preenchido manda na linhagem dela */
  idLinhagem: number | null
  expectativaM: number
  expectativaF: number
  /** 'aaaa-mm-dd' */
  dtVigenciaInicio: string
  /** 'aaaa-mm-dd', ou nulo para vigência aberta. */
  dtVigenciaFim: string | null
}

/** O parâmetro que vale para uma linhagem numa data. */
export function parametroNaData<T extends ParametroVigente>(
  parametros: T[],
  { idLinhagem, em }: { idLinhagem: number | null; em: string },
): T | undefined {
  const candidatos = parametros.filter(
    (parametro) =>
      parametro.dtVigenciaInicio <= em &&
      (parametro.dtVigenciaFim === null || em <= parametro.dtVigenciaFim) &&
      (parametro.idLinhagem === null || parametro.idLinhagem === idLinhagem),
  )

  return (
    candidatos.find((parametro) => parametro.idLinhagem === idLinhagem && idLinhagem !== null) ??
    candidatos.find((parametro) => parametro.idLinhagem === null)
  )
}

/** A expectativa que vale para uma linhagem numa data. */
export function expectativaNaData(
  parametros: ParametroVigente[],
  alvo: { idLinhagem: number | null; em: string },
): PorSexo {
  const parametro = parametroNaData(parametros, alvo)

  if (parametro === undefined) {
    throw new Error(
      `Sem parametro_biologico vigente em ${alvo.em} para a linhagem ${alvo.idLinhagem ?? '(especie)'}.`,
    )
  }

  return { m: parametro.expectativaM, f: parametro.expectativaF }
}
