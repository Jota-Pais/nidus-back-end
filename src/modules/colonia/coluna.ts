// A coluna do Kanban de cada caixa, calculada do que ela tem. Nada e gravado: a caixa muda de
// coluna quando os animais mudam.

import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { MotivoDaLiberacao } from './tipos.ts'

/** As 4 colunas, na ordem da tela */
export const COLUNAS = ['livres', 'estoque', 'reserva', 'enviado'] as const

export type Coluna = (typeof COLUNAS)[number]

/** Quanto tempo a caixa de estoque esvaziada pela entrega aparece em Enviado, desde a entrega */
export const DIAS_EM_ENVIADO = 7

export type CaixaNoQuadro = {
  tipo: 'casal' | 'estoque'
  ativa: boolean
  motivoLiberacao: MotivoDaLiberacao | null
  /** 'aaaa-mm-dd' */
  dtLiberacao: string | null
  /** os vivos dentro dela */
  vivos: number
  /** quantos desses vivos estao reservados */
  reservados: number
}

/** A entrega mais antiga cuja caixa ainda aparece em Enviado hoje, 'aaaa-mm-dd' */
export function inicioDoEnviado(hoje: string = hojeISO()): string {
  return somarDias(hoje, -DIAS_EM_ENVIADO)
}

/**
 * A coluna da caixa, ou null quando ela nao aparece no Kanban. A de casal ativa fica em Livres
 * (o card diz quantos reservados tem). A de estoque ativa fica em Reserva se tem vivos e todos
 * estao reservados; senao, em Estoque. A de estoque que a entrega esvaziou fica em Enviado por
 * 7 dias contados da data da entrega
 */
export function colunaDaCaixa(caixa: CaixaNoQuadro, hoje: string = hojeISO()): Coluna | null {
  if (caixa.ativa) {
    if (caixa.tipo === 'casal') return 'livres'
    return caixa.vivos > 0 && caixa.reservados === caixa.vivos ? 'reserva' : 'estoque'
  }

  const enviadaHaPouco =
    caixa.tipo === 'estoque' &&
    caixa.motivoLiberacao === 'entrega' &&
    caixa.dtLiberacao !== null &&
    caixa.dtLiberacao >= inicioDoEnviado(hoje)

  return enviadaHaPouco ? 'enviado' : null
}
