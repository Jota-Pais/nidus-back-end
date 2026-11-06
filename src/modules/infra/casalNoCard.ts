// O que o kanban e a grade mostram do casal de uma caixa, como na spec do cliente
// (secao 1.13): a identificacao, o parto atual (a bolinha colorida), o proximo parto
// previsto (o "P:dd/mm") e os animais que existem na caixa, por ninhada e com a idade,
// inclusive os que um casal encerrado deixou nela

import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import {
  compromissosAtivosComPedido,
  ofertaBruta,
  separarEntregues,
} from '../reproducao/disponibilidade.ts'
import type { CompromissoComEntrega, ContagemDoCiclo } from '../reproducao/disponibilidade.ts'

type DatasDoParto = { dtPartoPrevisto: Date; dtPartoReal: Date | null }

type PartoDoCard = DatasDoParto &
  ContagemDoCiclo & { ordem: number; compromissos: CompromissoComEntrega[] }

type CasalDoCard = {
  identificacao: string
  ativo: boolean
  /** em ordem crescente de 'ordem' */
  partos: PartoDoCard[]
}

/** Partos com data real confirmada. Com 0 ou 1 confirmado e 1, e nunca passa de 5 */
export function partoAtual(partos: DatasDoParto[]): number {
  const confirmados = partos.filter((parto) => parto.dtPartoReal !== null).length
  return Math.max(1, Math.min(confirmados, MAX_PARTOS_POR_CASAL))
}

/** A previsao do primeiro parto ainda sem data real, ou null quando nao ha pendente */
export function partoPrevisto(partos: DatasDoParto[]): string | null {
  const pendente = partos.find((parto) => parto.dtPartoReal === null)
  return pendente === undefined ? null : dataISO(pendente.dtPartoPrevisto)
}

function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000)
}

/**
 * As ninhadas do casal que ja nasceram, com o que ainda esta na caixa de cada uma e a idade de
 * hoje. O que ja foi entregue saiu da caixa, e a ninhada toda entregue sai do card
 */
export function ninhadas(casal: Pick<CasalDoCard, 'identificacao' | 'partos'>, hoje: string) {
  return casal.partos.flatMap((parto) => {
    if (parto.dtPartoReal === null) return []

    const nascimento = dataISO(parto.dtPartoReal)
    const oferta = ofertaBruta(parto)
    const { entregue } = separarEntregues(parto.compromissos)
    const m = Math.max(0, oferta.m - entregue.m)
    const f = Math.max(0, oferta.f - entregue.f)

    if (m + f === 0 && entregue.m + entregue.f > 0) return []

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
 * o estoque e a busca ja contam. null sem casal, ou sem casal ativo e sem ninhada, ou com a caixa
 * ja enviada
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
    ninhadas: todas,
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
        ordem: true,
        dtPartoPrevisto: true,
        dtPartoReal: true,
        nascidoM: true,
        nascidoF: true,
        eutanasiadoM: true,
        eutanasiadoF: true,
        desmamadoM: true,
        desmamadoF: true,
        compromissos: compromissosAtivosComPedido,
      },
    },
  },
}
