// O que o kanban e a grade mostram do casal de uma caixa, como na spec do cliente
// (secao 1.13): a identificacao, o parto atual (a bolinha colorida), o proximo parto
// previsto (o "P:dd/mm") e os animais que existem na caixa, por ninhada e com a idade,
// inclusive os que um casal encerrado deixou nela, e quantos deles estao reservados

import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import type { ContagemDoCiclo } from '../reproducao/disponibilidade.ts'
import { naCaixaDoCasal, reservadoNaCaixaDoCasal, selecaoDoPartoComLugares } from './estoque.ts'
import type { LoteDoParto, ReservaDoParto } from './estoque.ts'

type DatasDoParto = { dtPartoPrevisto: Date; dtPartoReal: Date | null }

type PartoDoCard = DatasDoParto &
  ContagemDoCiclo & {
    id: number
    ordem: number
    compromissos: ReservaDoParto[]
    /** os desmamados que foram para caixas de estoque, que ja nao estao nesta */
    lotes: LoteDoParto[]
  }

type CasalDoCard = {
  identificacao: string
  ativo: boolean
  /** em ordem crescente de 'ordem' */
  partos: PartoDoCard[]
}

/**
 * O parto em curso: o ultimo aberto. O 1o nasce com o casal e cada seguinte no acasalamento dele,
 * entao com o acasalamento do 2o registrado o casal ja esta no 2o, mesmo antes do nascimento.
 * Nunca passa de 5
 */
export function partoAtual(partos: DatasDoParto[]): number {
  return Math.max(1, Math.min(partos.length, MAX_PARTOS_POR_CASAL))
}

/** A previsao do primeiro parto ainda sem data real, ou null quando nao ha pendente */
export function partoPrevisto(partos: DatasDoParto[]): string | null {
  const pendente = partos.find((parto) => parto.dtPartoReal === null)
  return pendente === undefined ? null : dataISO(pendente.dtPartoPrevisto)
}

function mamando(parto: PartoDoCard): boolean {
  if (parto.dtPartoReal === null || parto.desmamadoM !== null) return false
  const { m, f } = naCaixaDoCasal(parto)
  return m + f > 0
}

function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000)
}

/**
 * As ninhadas do casal que ja nasceram, com o que ainda esta na caixa de cada uma e a idade de
 * hoje. O que foi entregue ou foi para uma caixa de estoque saiu desta, e a ninhada que saiu toda
 * sai do card
 */
export function ninhadas(casal: Pick<CasalDoCard, 'identificacao' | 'partos'>, hoje: string) {
  return casal.partos.flatMap((parto) => {
    if (parto.dtPartoReal === null) return []

    const nascimento = dataISO(parto.dtPartoReal)
    const { m, f } = naCaixaDoCasal(parto)
    const saiu = parto.desmamadoM !== null || parto.compromissos.some((c) => c.remessa.dtRealizada !== null)

    if (m + f === 0 && saiu) return []

    return [
      {
        casal: casal.identificacao.trim(),
        parto: parto.ordem,
        m,
        f,
        idadeDias: diasEntre(nascimento, hoje),
      },
    ]
  })
}

/**
 * 'casais' vem na ordem de 'selecaoDoCasalNoCard': o primeiro e o casal da caixa (o ativo, ou o
 * mais recente), e os outros vieram antes dele. As ninhadas sao as de todos, das mais antigas para
 * as mais novas: casal novo na caixa nao esconde a ninhada que o casal encerrado deixou nela, que
 * o estoque e a busca ja contam. 'reservado' e quanto da reserva a entregar ainda esta nesta caixa,
 * e nao em caixa de estoque. null sem casal, ou sem casal ativo e sem ninhada, ou com a caixa ja
 * enviada
 */
export function casalNoCard(casais: CasalDoCard[], estado: string, hoje: string = hojeISO()) {
  const [casal] = casais
  if (casal === undefined) return null

  const todas = [...casais].reverse().flatMap((c) => ninhadas(c, hoje))
  if (!casal.ativo && (todas.length === 0 || estado === 'X')) return null

  return {
    identificacao: casal.identificacao.trim(),
    partoAtual: partoAtual(casal.partos),
    partoPrevisto: casal.ativo ? partoPrevisto(casal.partos) : null,
    encerrado: !casal.ativo,
    aguardandoDesmame: !casal.ativo && casal.partos.some(mamando),
    ninhadas: todas,
    reservado: reservadoNaCaixaDoCasal(casais.flatMap((c) => c.partos)),
  }
}

/** O select do Prisma que alimenta 'casalNoCard': todos os casais da caixa, o ativo (ou o mais recente) primeiro, com os partos */
export const selecaoDoCasalNoCard = {
  orderBy: [{ ativo: 'desc' as const }, { dtFormacao: 'desc' as const }, { id: 'desc' as const }],
  select: {
    identificacao: true,
    ativo: true,
    linhagem: { select: { nome: true } },
    partos: {
      orderBy: { ordem: 'asc' as const },
      select: {
        ...selecaoDoPartoComLugares,
        ordem: true,
        dtPartoPrevisto: true,
        dtPartoReal: true,
      },
    },
  },
}
