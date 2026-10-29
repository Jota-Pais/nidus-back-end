// Motor de busca de atendimento (spec do cliente, secao 6.1): o plantel primeiro, por
// proximidade de idade, e o acasalamento novo como ultima alternativa. Aqui so a regra, sem
// banco - quem le o banco e 'motor.service.ts'

import { ESPERADOS_POR_CASAL, FAIXAS_IDADE } from '../../shared/parametros.ts'
import type { PorSexo } from '../reproducao/disponibilidade.ts'

/** De onde vem o animal: ja desmamado, ja nascido, ou parto ainda previsto */
export type Origem = 'de_fato' | 'previsao' | 'previsao_parto'

const PRIORIDADE: Record<Origem, number> = { de_fato: 0, previsao: 1, previsao_parto: 2 }

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

export type Candidata = {
  idCaixa: number
  idParto: number
  origem: Origem
  idadeNaEntrega: number
  disponivel: PorSexo
}

/** de fato, depois previsao, depois previsao de parto; dentro de cada grupo, idade mais proxima e mais animais */
export function ordenar<T extends Candidata>(candidatas: T[], idadePedida: number): T[] {
  return [...candidatas].sort(
    (a, b) =>
      PRIORIDADE[a.origem] - PRIORIDADE[b.origem] ||
      Math.abs(a.idadeNaEntrega - idadePedida) - Math.abs(b.idadeNaEntrega - idadePedida) ||
      b.disponivel.m + b.disponivel.f - (a.disponivel.m + a.disponivel.f),
  )
}

/** Vai pegando das candidatas, na ordem, ate cobrir o pedido. O que faltar e deficit */
export function sugerirAlocacao<T extends Candidata>(
  candidatas: T[],
  pedido: PorSexo,
): { itens: (T & { alocar: PorSexo; sugerida: boolean })[]; deficit: PorSexo } {
  const falta = { ...pedido }

  const itens = candidatas.map((candidata) => {
    const alocar = {
      m: Math.min(candidata.disponivel.m, falta.m),
      f: Math.min(candidata.disponivel.f, falta.f),
    }
    falta.m -= alocar.m
    falta.f -= alocar.f
    return { ...candidata, alocar, sugerida: alocar.m + alocar.f > 0 }
  })

  return { itens, deficit: falta }
}

/** Casais a formar para cobrir o deficit, pelo esperado de cada casal (4M/4F na colonia) */
export function casaisParaODeficit(deficit: PorSexo): number {
  const porMacho = Math.ceil(deficit.m / ESPERADOS_POR_CASAL.m)
  const porFemea = Math.ceil(deficit.f / ESPERADOS_POR_CASAL.f)
  return Math.max(porMacho, porFemea)
}
