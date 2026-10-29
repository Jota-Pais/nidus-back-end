// Quanto um parto tem para oferecer, e com que confiança

import { ESPERADOS_POR_CASAL } from '../../shared/parametros.ts'

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

/**
 * O grau de certeza sai da mesma cascata da oferta: C confirmado (desmamou), P previsto
 * (nasceu), J projetado (nem nasceu). Devolve o código da coluna
 * demanda.compromisso.grau_certeza, que ainda é NOT NULL e é o único lugar que guarda o grau
 */
export function calcularGrauCerteza(ciclo: ContagemDoCiclo): 'C' | 'P' | 'J' {
  if (ciclo.desmamadoM !== null && ciclo.desmamadoF !== null) {
    return 'C'
  }

  if (ciclo.nascidoM !== null && ciclo.nascidoF !== null) {
    return 'P'
  }

  return 'J'
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
  /** soma dos compromissos ativos */
  comprometido: PorSexo
  /** O que ainda dá para prometer - já líquido. */
  disponivel: PorSexo
}

/**
 * disponibilidade completa de um ciclo, com o comprometido já somado. O teto é a oferta
 * BRUTA, e não o disponível: confundir os dois faz o limite valer metade
 */
export function calcularDisponibilidade(
  ciclo: ContagemDoCiclo,
  comprometido: PorSexo,
): Disponibilidade {
  const oferta = ofertaBruta(ciclo)

  return {
    comprometido,
    disponivel: {
      m: Math.max(0, oferta.m - comprometido.m),
      f: Math.max(0, oferta.f - comprometido.f),
    },
  }
}

/**
 * O 'include'/'select' do Prisma dos compromissos que pesam na conta. Só os ativos: o
 * cancelado fica na tabela, mas não pesa mais no comprometido (mesma regra do trigger do banco)
 */
export const compromissosAtivos = {
  where: { dtCancelamento: null },
  select: { qtdM: true, qtdF: true },
}

/** Um parto lido com 'compromissos: compromissosAtivos' */
export type PartoComCompromissos = ContagemDoCiclo & {
  compromissos: { qtdM: number; qtdF: number }[]
}

/** O que um parto ainda tem livre. É esta a função que a ficha, a alocação e a busca chamam */
export function disponibilidadeDoParto(parto: PartoComCompromissos): Disponibilidade {
  const comprometido = parto.compromissos.reduce(
    (soma, c) => ({ m: soma.m + c.qtdM, f: soma.f + c.qtdF }),
    { m: 0, f: 0 },
  )

  return calcularDisponibilidade(parto, comprometido)
}
