// O que o kanban e a grade mostram do casal de uma caixa, como na spec do cliente
// (secao 1.13): a identificacao, o parto atual (a bolinha colorida) e o proximo parto
// previsto (o "P:dd/mm")

import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { dataISO } from '../../shared/traducao.ts'

type PartoDoCard = { dtPartoPrevisto: Date; dtPartoReal: Date | null }

type CasalDoCard = {
  identificacao: string
  ativo: boolean
  /** em ordem crescente de 'ordem' */
  partos: PartoDoCard[]
}

/** Partos com data real confirmada. Com 0 ou 1 confirmado e 1, e nunca passa de 5 */
export function partoAtual(partos: PartoDoCard[]): number {
  const confirmados = partos.filter((parto) => parto.dtPartoReal !== null).length
  return Math.max(1, Math.min(confirmados, MAX_PARTOS_POR_CASAL))
}

/** A previsao do primeiro parto ainda sem data real, ou null quando nao ha pendente */
export function partoPrevisto(partos: PartoDoCard[]): string | null {
  const pendente = partos.find((parto) => parto.dtPartoReal === null)
  return pendente === undefined ? null : dataISO(pendente.dtPartoPrevisto)
}

/** null sem casal, ou com casal encerrado que nao deixou ninhada ou cuja caixa ja foi enviada */
export function casalNoCard(casal: CasalDoCard | undefined, estado: string) {
  if (casal === undefined) return null

  const temNinhada = casal.partos.some((parto) => parto.dtPartoReal !== null)
  if (!casal.ativo && (!temNinhada || estado === 'X')) return null

  return {
    identificacao: casal.identificacao.trim(),
    partoAtual: partoAtual(casal.partos),
    partoPrevisto: casal.ativo ? partoPrevisto(casal.partos) : null,
    encerrado: !casal.ativo,
  }
}

/** O select do Prisma que alimenta 'casalNoCard': o casal ativo (ou o mais recente) e todos os partos dele */
export const selecaoDoCasalNoCard = {
  orderBy: [{ ativo: 'desc' as const }, { dtFormacao: 'desc' as const }, { id: 'desc' as const }],
  take: 1,
  select: {
    identificacao: true,
    ativo: true,
    linhagem: { select: { nome: true } },
    partos: {
      orderBy: { ordem: 'asc' as const },
      select: { dtPartoPrevisto: true, dtPartoReal: true },
    },
  },
}
