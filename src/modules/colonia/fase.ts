// A fase de cada caixa (a cor dela na grade e na ficha), calculada do que ela tem. Nada e gravado:
// a caixa muda de fase quando os animais nascem, desmamam ou saem, e quando o acasalamento abre
// o parto seguinte. A caixa de casal segue o que esta dentro dela, que e onde esta o trabalho

import { ALEITAMENTO_DIAS } from '../../shared/parametros.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { diasEntre } from '../reproducao/cadeiaTemporal.ts'

/** As fases, na ordem do ciclo da caixa de casal, e a da caixa de estoque */
export const FASES = ['acasalado', 'mamando', 'pronto_estoque', 'estoque'] as const

export type Fase = (typeof FASES)[number]

export type CaixaParaFase = {
  tipo: 'casal' | 'estoque'
  ativa: boolean
  /** os vivos da caixa por parto: se o parto ja desmamou e quando nasceu ('aaaa-mm-dd') */
  ninhadas: { desmamado: boolean; dtNascimento: string }[]
  /** a previsao do parto pendente do casal da caixa ('aaaa-mm-dd'), ou null sem parto pendente */
  partoPrevisto: string | null
}

export type FaseDaCaixa = {
  /** null na caixa liberada e na de casal sem ciclo aberto e sem animais */
  fase: Fase | null
  /** o parto previsto passou sem nascimento, ou um filhote passou da idade de desmamar */
  atrasado: boolean
}

/**
 * A fase da caixa. A de casal ativa, nesta ordem: desmamados ainda nela -> pronto para o estoque;
 * filhotes mamando -> mamando; parto pendente -> acasalado. A de estoque ativa fica em estoque. A
 * caixa liberada nao tem fase. Atrasado: o parto previsto ficou para tras (antes de hoje) sem
 * nascimento, ou um filhote ainda mama com mais de ALEITAMENTO_DIAS de idade
 */
export function faseDaCaixa(caixa: CaixaParaFase, hoje: string = hojeISO()): FaseDaCaixa {
  if (!caixa.ativa) return { fase: null, atrasado: false }
  if (caixa.tipo === 'estoque') return { fase: 'estoque', atrasado: false }

  const mamando = caixa.ninhadas.filter((ninhada) => !ninhada.desmamado)
  const desmameAtrasado = mamando.some((ninhada) => diasEntre(ninhada.dtNascimento, hoje) > ALEITAMENTO_DIAS)
  const partoAtrasado = caixa.partoPrevisto !== null && caixa.partoPrevisto < hoje
  const atrasado = desmameAtrasado || partoAtrasado

  if (caixa.ninhadas.some((ninhada) => ninhada.desmamado)) return { fase: 'pronto_estoque', atrasado }
  if (mamando.length > 0) return { fase: 'mamando', atrasado }
  if (caixa.partoPrevisto !== null) return { fase: 'acasalado', atrasado }

  return { fase: null, atrasado }
}
