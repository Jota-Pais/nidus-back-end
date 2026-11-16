// A causa da baixa (colonia.ocorrencia.causa) e o que ela vira no aleitamento. A baixa e morte ou
// eutanasia; a do animal de parto de casal antes do desmame (ou no dia dele, ou sem desmame ainda)
// e do aleitamento, e la a eutanasia e o ajuste de ninhada (a selecao) e a morte e a morte durante o
// aleitamento. Sao indices diferentes para quem cuida da colonia, e a ficha do parto e a visao geral
// os contam separados. A ninhada do cadastro inicial (sem casal) chegou desmamada: nao tem
// aleitamento no Nidus

import { dataISO } from '../../shared/traducao.ts'
import { somarUm, sexoDe } from './tipos.ts'
import type { PorSexo } from './tipos.ts'

export type CausaDaBaixa = 'morte' | 'eutanasia'

export const CAUSAS_DA_BAIXA: CausaDaBaixa[] = ['morte', 'eutanasia']

/** A causa como o banco guarda (varchar com CHECK): o que nao for eutanasia e morte */
export function causaDe(causa: string | null): CausaDaBaixa {
  return causa === 'eutanasia' ? 'eutanasia' : 'morte'
}

/** O parto do animal, como a classificacao le */
export type PartoDaBaixa = { comCasal: boolean; dtDesmameReal: Date | null }

/**
 * A baixa e do aleitamento quando o animal e de parto de casal e morreu ate o dia do desmame, ou
 * antes de o parto desmamar. A morte no proprio dia conta como antes, como na ficha do parto
 * (contarDoParto)
 */
export function baixaNoAleitamento(dtSaida: Date, parto: PartoDaBaixa): boolean {
  if (!parto.comCasal) return false
  return parto.dtDesmameReal === null || dataISO(dtSaida) <= dataISO(parto.dtDesmameReal)
}

/** O que a baixa e: no aleitamento, ajuste de ninhada ou morte no aleitamento; depois, morte ou eutanasia */
export type ClasseDaBaixa = 'ajuste_de_ninhada' | 'morte_no_aleitamento' | 'morte' | 'eutanasia'

export function classificarBaixa(causa: CausaDaBaixa, noAleitamento: boolean): ClasseDaBaixa {
  if (!noAleitamento) return causa
  return causa === 'eutanasia' ? 'ajuste_de_ninhada' : 'morte_no_aleitamento'
}

/** Um animal morto, com a causa da baixa que o matou e o parto dele */
export type MortoDaBaixa = { sexo: string; dtSaida: Date; causa: CausaDaBaixa; parto: PartoDaBaixa }

export type BaixasDoAleitamento = {
  /** a eutanasia no aleitamento: o ajuste de ninhada (a selecao) */
  ajusteDeNinhada: PorSexo
  /** a morte no aleitamento, a 'nao chegou ao desmame' inclusive */
  mortesNoAleitamento: PorSexo
}

/** As baixas do aleitamento entre os mortos, por sexo. As de depois do desmame ficam fora */
export function contarBaixasDoAleitamento(mortos: MortoDaBaixa[]): BaixasDoAleitamento {
  const contagem: BaixasDoAleitamento = { ajusteDeNinhada: { m: 0, f: 0 }, mortesNoAleitamento: { m: 0, f: 0 } }

  for (const morto of mortos) {
    const classe = classificarBaixa(morto.causa, baixaNoAleitamento(morto.dtSaida, morto.parto))
    const sexo = sexoDe(morto)

    if (classe === 'ajuste_de_ninhada') contagem.ajusteDeNinhada = somarUm(contagem.ajusteDeNinhada, sexo)
    if (classe === 'morte_no_aleitamento') contagem.mortesNoAleitamento = somarUm(contagem.mortesNoAleitamento, sexo)
  }

  return contagem
}
