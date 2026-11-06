// O fluxo do kanban da caixa de casal. E a secao 1.9 da spec do cliente adaptada ao Nidus, que
// nao tem caixa agrupada: aqui e a propria caixa do casal que passa por Estoque, Reserva e Enviado

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

/**
 * Para onde cada coluna deixa ir. Livres e Pre-reserva alternam e vao para Estoque; Pre-reserva
 * vai para Reserva; Estoque vai para Reserva ou Enviado; Reserva so para Enviado. Estoque e
 * Reserva nao voltam, e Enviado e a ultima coluna
 */
const DESTINOS: Record<string, string[]> = {
  R: ['P', 'E'],
  P: ['R', 'E', 'T'],
  E: ['T', 'X'],
  T: ['X'],
  X: [],
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

function listaDeColunas(estados: string[]): string {
  const rotulos = estados.map((estado) => ROTULO_DA_COLUNA[estado])
  return rotulos.length === 1 ? `${rotulos[0]}` : `${rotulos.slice(0, -1).join(', ')} ou ${rotulos.at(-1)}`
}

/** Recusa, com o motivo, a mudanca de coluna que o fluxo do kanban nao deixa */
export function conferirTransicao(antes: string, depois: string, caixa: SituacaoDaCaixa) {
  if (antes === 'X') {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      'Esta caixa ja foi enviada: Enviado e a ultima coluna do kanban.',
    )
  }

  if (antes === depois) return

  const destinos = DESTINOS[antes] ?? []

  if (!destinos.includes(depois)) {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      `A caixa em ${ROTULO_DA_COLUNA[antes]} nao vai para ${ROTULO_DA_COLUNA[depois]}: de ${ROTULO_DA_COLUNA[antes]} ela so vai para ${listaDeColunas(destinos)}.`,
    )
  }

  if (depois === 'E' && !caixa.temDesmamado) {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      'Esta caixa nao tem ninhada desmamada com animal: so depois do desmame ela vai para Estoque.',
    )
  }

  if (antes === 'P' && depois === 'T' && caixa.livre.m + caixa.livre.f > 0) {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      `Esta caixa ainda tem ${caixa.livre.m} M e ${caixa.livre.f} F livres: de Pre-reserva ela so vai para Reserva com todos os animais comprometidos.`,
    )
  }

  if ((depois === 'T' || depois === 'X') && !caixa.temVinculo) {
    throw erroDeRegra(
      'TRANSICAO_INVALIDA',
      `Esta caixa nao tem animal alocado a uma solicitacao, e sem esse vinculo nao vai para ${ROTULO_DA_COLUNA[depois]}.`,
    )
  }
}

/**
 * A coluna da caixa depois de uma entrega, ou null quando ela fica onde esta. A caixa que a
 * entrega esvaziou (casal encerrado, nenhum animal na caixa e nada a entregar) vai para Enviado.
 * A caixa em Pre-reserva que ficou sem nada a entregar volta para Livres, o inverso da alocacao
 */
export function colunaDepoisDaEntrega(
  estado: string,
  temCasalAtivo: boolean,
  caixa: SituacaoDaCaixa,
): 'X' | 'R' | null {
  const aEntregar = caixa.aEntregar.m + caixa.aEntregar.f
  const vazia = caixa.naCaixa.m + caixa.naCaixa.f === 0

  if (estado !== 'X' && !temCasalAtivo && vazia && aEntregar === 0) return 'X'
  if (estado === 'P' && aEntregar === 0) return 'R'

  return null
}
