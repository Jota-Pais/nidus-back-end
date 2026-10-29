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

/** null quando a caixa nao tem casal ativo - caixa de estoque, reserva ou ja enviada */
export function casalNoCard(casal: CasalDoCard | undefined) {
  if (casal === undefined || !casal.ativo) return null

  return {
    identificacao: casal.identificacao.trim(),
    partoAtual: partoAtual(casal.partos),
    partoPrevisto: partoPrevisto(casal.partos),
  }
}

/** O select do Prisma que alimenta 'casalNoCard': o casal mais recente e todos os partos dele */
export const selecaoDoCasalNoCard = {
  orderBy: { dtFormacao: 'desc' as const },
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
