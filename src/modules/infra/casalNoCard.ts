// O que o kanban e a grade mostram do casal de uma caixa, como na spec do cliente
// (secao 1.13): a identificacao, o parto atual (a bolinha colorida), o proximo parto
// previsto (o "P:dd/mm") e os animais que existem na caixa, por ninhada e com a idade

import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import { ofertaBruta } from '../reproducao/disponibilidade.ts'
import type { ContagemDoCiclo } from '../reproducao/disponibilidade.ts'

type DatasDoParto = { dtPartoPrevisto: Date; dtPartoReal: Date | null }

type PartoDoCard = DatasDoParto & ContagemDoCiclo & { ordem: number }

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

/** As ninhadas que ja nasceram, com o que existe de cada uma e a idade de hoje */
export function ninhadas(partos: PartoDoCard[], hoje: string) {
  return partos.flatMap((parto) => {
    if (parto.dtPartoReal === null) return []

    const nascimento = dataISO(parto.dtPartoReal)
    const { m, f } = ofertaBruta(parto)

    return [{ parto: parto.ordem, m, f, idadeDias: diasEntre(nascimento, hoje) }]
  })
}

/** null sem casal, ou com casal encerrado que nao deixou ninhada ou cuja caixa ja foi enviada */
export function casalNoCard(
  casal: CasalDoCard | undefined,
  estado: string,
  hoje: string = hojeISO(),
) {
  if (casal === undefined) return null

  const temNinhada = casal.partos.some((parto) => parto.dtPartoReal !== null)
  if (!casal.ativo && (!temNinhada || estado === 'X')) return null

  return {
    identificacao: casal.identificacao.trim(),
    partoAtual: partoAtual(casal.partos),
    partoPrevisto: casal.ativo ? partoPrevisto(casal.partos) : null,
    encerrado: !casal.ativo,
    ninhadas: ninhadas(casal.partos, hoje),
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
      },
    },
  },
}
