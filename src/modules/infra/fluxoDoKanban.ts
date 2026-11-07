// O fluxo do kanban da caixa de casal: so Livres e Pre-reserva. Os desmamados saem dela para
// caixas de estoque (estoque.service.ts), e e a caixa de estoque que fica em Estoque, Reserva e
// Enviado, sozinha, pelo que tem reservado

import { erroDeRegra } from '../../shared/erros.ts'
import {
  compromissosAtivosComPedido,
  disponibilidadeDoParto,
  naCaixa,
  separarEntregues,
} from '../reproducao/disponibilidade.ts'
import type {
  CompromissoComEntrega,
  ContagemDoCiclo,
  PorSexo,
} from '../reproducao/disponibilidade.ts'

/** Um parto da caixa com os compromissos ativos, cada um com a data em que a remessa saiu */
export type PartoDaCaixa = ContagemDoCiclo & { compromissos: CompromissoComEntrega[] }

/** O select do Prisma de 'PartoDaCaixa' */
export const selecaoDoPartoDaCaixa = {
  nascidoM: true,
  nascidoF: true,
  eutanasiadoM: true,
  eutanasiadoF: true,
  desmamadoM: true,
  desmamadoF: true,
  compromissos: compromissosAtivosComPedido,
}

/** O nome da coluna nas mensagens, como a tela mostra */
const ROTULO_DA_COLUNA: Record<string, string> = {
  R: 'Livres',
  P: 'Pre-reserva',
  E: 'Estoque',
  T: 'Reserva',
  X: 'Enviado',
}

/** A caixa de casal alterna Livres e Pre-reserva, e nada mais */
const DESTINOS: Record<string, string[]> = {
  R: ['P'],
  P: ['R'],
}

const somar = (a: PorSexo, b: PorSexo): PorSexo => ({ m: a.m + b.m, f: a.f + b.f })

export type SituacaoDaCaixa = {
  /** o que ainda esta na caixa: o que existe menos o que ja foi entregue */
  naCaixa: PorSexo
  /** o que ainda da para reservar */
  livre: PorSexo
  /** reservado e ainda nao entregue */
  aEntregar: PorSexo
  /** alguma ninhada desmamada ainda tem animal na caixa */
  temDesmamado: boolean
  /** a caixa tem animal alocado a uma solicitacao, entregue ou nao */
  temVinculo: boolean
}

/** Soma os partos de todos os casais da caixa */
export function situacaoDaCaixa(partos: PartoDaCaixa[]): SituacaoDaCaixa {
  const vazio = { m: 0, f: 0 }
  const situacao: SituacaoDaCaixa = {
    naCaixa: vazio,
    livre: vazio,
    aEntregar: vazio,
    temDesmamado: false,
    temVinculo: false,
  }

  for (const parto of partos) {
    const resta = naCaixa(parto)
    const desmamou = parto.desmamadoM !== null && parto.desmamadoF !== null

    situacao.naCaixa = somar(situacao.naCaixa, resta)
    situacao.livre = somar(situacao.livre, disponibilidadeDoParto(parto).disponivel)
    situacao.aEntregar = somar(situacao.aEntregar, separarEntregues(parto.compromissos).comprometido)
    situacao.temDesmamado ||= desmamou && resta.m + resta.f > 0
    situacao.temVinculo ||= parto.compromissos.length > 0
  }

  return situacao
}

/** Recusa, com o motivo, a mudanca de coluna da caixa de casal que o kanban nao deixa */
export function conferirTransicao(antes: string, depois: string) {
  if (antes === depois) return

  if (['E', 'T', 'X'].includes(depois)) {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      'A caixa de casal fica em Livres ou Pre-reserva. Os desmamados vao para o estoque pela ficha da caixa, em Passar para o estoque.',
    )
  }

  if (!(DESTINOS[antes] ?? []).includes(depois)) {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      `A caixa em ${ROTULO_DA_COLUNA[antes]} nao vai para ${ROTULO_DA_COLUNA[depois]}.`,
    )
  }
}
