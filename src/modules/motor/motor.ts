// Motor de busca de atendimento (spec do cliente, secao 6.1): o plantel primeiro, ordenado
// pela idade, e o acasalamento novo como ultima alternativa. Aqui so a regra, sem banco -
// quem le o banco e 'motor.service.ts'

import { ESPERADOS_POR_CASAL, FAIXAS_IDADE } from '../../shared/parametros.ts'
import type { PorSexo } from '../reproducao/disponibilidade.ts'

/** De onde vem o animal: ja desmamado ou ja nascido */
export type Origem = 'de_fato' | 'previsao'

const PRIORIDADE: Record<Origem, number> = { de_fato: 0, previsao: 1 }

/** O que o pedido quer: machos, femeas e animais de qualquer sexo */
export type Pedido = PorSexo & { qualquer: number }

/** A idade pedida, em dias desde o nascimento. A idade exata e min = max */
export type IdadePedida = { min: number; max: number }

type Faixa = { idadeMinDias: number; idadeMaxDias: number | null; variacaoDias: number }

/** A variacao aceita cresce com a idade pedida (secao 1.6). Fora da tabela, a maior faixa */
export function faixaAceita(idade: number): { min: number; max: number } {
  const faixas: readonly Faixa[] = FAIXAS_IDADE
  const faixa =
    faixas.find((f) => f.idadeMinDias <= idade && (f.idadeMaxDias === null || idade <= f.idadeMaxDias)) ??
    faixas.reduce<Faixa | undefined>((maior, f) => (!maior || f.idadeMinDias > maior.idadeMinDias ? f : maior), undefined)

  const variacao = faixa?.variacaoDias ?? 0
  return { min: Math.max(0, idade - variacao), max: idade + variacao }
}

/**
 * A faixa aceita do pedido: a tolerancia vale nas pontas, do minimo aceito para a menor idade ao
 * maximo aceito para a maior. Na idade exata e a propria 'faixaAceita'
 */
export function faixaDoPedido(idade: IdadePedida): { min: number; max: number } {
  return { min: faixaAceita(idade.min).min, max: faixaAceita(idade.max).max }
}

export type Candidata = {
  idCaixa: number
  idParto: number
  origem: Origem
  idadeNaEntrega: number
  disponivel: PorSexo
}

/**
 * de fato, depois previsao, depois previsao de parto. Dentro de cada grupo, com faixa, primeiro o
 * que esta dentro da faixa pedida (idadeMin..idadeMax) e depois o que so entra pela tolerancia,
 * cada parte do mais velho para o mais novo (secao 1.7, passo 5); com idade exata, a mais proxima
 * da pedida. No empate, a que tem mais animais
 */
export function ordenar<T extends Candidata>(candidatas: T[], idade: IdadePedida): T[] {
  const soPelaTolerancia = (c: T) => (c.idadeNaEntrega < idade.min || c.idadeNaEntrega > idade.max ? 1 : 0)
  const pelaIdade =
    idade.min < idade.max
      ? (a: T, b: T) => soPelaTolerancia(a) - soPelaTolerancia(b) || b.idadeNaEntrega - a.idadeNaEntrega
      : (a: T, b: T) => Math.abs(a.idadeNaEntrega - idade.min) - Math.abs(b.idadeNaEntrega - idade.min)

  return [...candidatas].sort(
    (a, b) =>
      PRIORIDADE[a.origem] - PRIORIDADE[b.origem] ||
      pelaIdade(a, b) ||
      b.disponivel.m + b.disponivel.f - (a.disponivel.m + a.disponivel.f),
  )
}

/**
 * Vai pegando das candidatas, na ordem, ate cobrir o pedido. A primeira passada cobre machos e
 * femeas; a segunda cobre o "qualquer" com a sobra de cada caixa, na mesma ordem, para nunca tirar
 * animal de quem pediu sexo. O que faltar e deficit
 */
export function sugerirAlocacao<T extends Candidata>(
  candidatas: T[],
  pedido: Pedido,
): { itens: (T & { alocar: PorSexo; sugerida: boolean })[]; deficit: Pedido } {
  const falta = { ...pedido }

  const itens = candidatas.map((candidata) => {
    const alocar = {
      m: Math.min(candidata.disponivel.m, falta.m),
      f: Math.min(candidata.disponivel.f, falta.f),
    }
    falta.m -= alocar.m
    falta.f -= alocar.f
    return { ...candidata, alocar, sugerida: false }
  })

  // o "qualquer" entra no 'alocar' da caixa como macho ou femea: primeiro os machos que
  // sobraram, depois as femeas
  for (const item of itens) {
    const machos = Math.min(item.disponivel.m - item.alocar.m, falta.qualquer)
    const femeas = Math.min(item.disponivel.f - item.alocar.f, falta.qualquer - machos)
    item.alocar.m += machos
    item.alocar.f += femeas
    falta.qualquer -= machos + femeas
    item.sugerida = item.alocar.m + item.alocar.f > 0
  }

  return { itens, deficit: falta }
}

/**
 * Casais a formar para cobrir o deficit, pelo esperado de cada casal (4M/4F na colonia). Machos e
 * femeas pedem os proprios casais; o "qualquer" so pesa no total, que cada casal cobre com 8
 */
export function casaisParaODeficit(deficit: Pedido): number {
  const porMacho = Math.ceil(deficit.m / ESPERADOS_POR_CASAL.m)
  const porFemea = Math.ceil(deficit.f / ESPERADOS_POR_CASAL.f)
  const porTotal = Math.ceil(
    (deficit.m + deficit.f + deficit.qualquer) / (ESPERADOS_POR_CASAL.m + ESPERADOS_POR_CASAL.f),
  )
  return Math.max(porMacho, porFemea, porTotal)
}
