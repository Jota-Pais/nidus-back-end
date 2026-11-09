// A caixa de estoque que ja existe e recebe animais vindos de fora dela: a mudanca, a volta da
// anulacao quando a caixa da baixa nao serve mais, e os animais a mais da correcao do nascimento

import type { Prisma } from '@prisma/client'
import { campoInvalido } from '../../shared/erros.ts'
import { exigirOrdem } from '../reproducao/ordemDasDatas.ts'
import type { Sexo } from './tipos.ts'

/** O que a caixa de estoque confere em quem entra nela */
export type QuemEntra = { sexo: Sexo; idLinhagem: number }

type CaixaQueRecebe = { ativa: boolean; tipo: string; sexo: string | null; idLinhagem: number | null }

/**
 * Por que a caixa nao recebe os animais, ou null se recebe: liberada, que nao e de estoque, do
 * outro sexo ou de outra linhagem. A caixa de estoque guarda um sexo e uma linhagem so
 */
export function recusaDoEstoque(caixa: CaixaQueRecebe, quem: QuemEntra): string | null {
  if (!caixa.ativa) return 'Esta caixa ja foi liberada.'
  if (caixa.tipo !== 'estoque') return 'Fora da caixa do casal, os animais so ficam numa caixa de estoque.'
  if (caixa.sexo !== quem.sexo) return 'Esta caixa de estoque e do outro sexo.'
  if (caixa.idLinhagem !== quem.idLinhagem) return 'Esta caixa de estoque e de outra linhagem.'
  return null
}

/**
 * Recusa no campo do formulario a caixa que nao pode receber os animais (recusaDoEstoque). O
 * trigger dos animais cobra o mesmo no banco; aqui a recusa sai com o porque. A caixa ja esta
 * travada. Com 'chegada' ('aaaa-mm-dd', no campo dtFato), a caixa tem de ja existir nesse dia: a
 * chegada nao e antes dos primeiros animais que entraram nela. Devolve o codigo da caixa, para a
 * resposta dizer para onde os animais foram
 */
export async function exigirEstoqueQueRecebe(
  tx: Pick<Prisma.TransactionClient, 'caixa' | 'ocorrencia'>,
  idCaixa: number,
  campo: string,
  quem: QuemEntra,
  chegada?: string,
): Promise<{ codigo: string }> {
  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: { codigo: true, ativa: true, tipo: true, sexo: true, idLinhagem: true },
  })

  if (caixa === null) throw campoInvalido(campo, 'Esta caixa nao existe.')

  const recusa = recusaDoEstoque(caixa, quem)
  if (recusa !== null) throw campoInvalido(campo, recusa)

  if (chegada !== undefined) {
    // os primeiros animais da caixa: o nascimento, na que foi de casal, ou a mudanca que a criou
    const primeira = await tx.ocorrencia.aggregate({ where: { idCaixaDestino: idCaixa }, _min: { dtFato: true } })

    exigirOrdem('dtFato', chegada, {
      depoisDe: [{ evento: `da chegada dos primeiros animais na caixa ${caixa.codigo}`, data: primeira._min.dtFato }],
    })
  }

  return { codigo: caixa.codigo }
}
