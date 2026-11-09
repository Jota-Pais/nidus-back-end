// A caixa de estoque que recebe animais vindos de fora dela sem ser por mudanca: a volta da
// anulacao quando a caixa da baixa nao serve mais, e os animais a mais da correcao do nascimento

import type { Prisma } from '@prisma/client'
import { campoInvalido } from '../../shared/erros.ts'
import type { Sexo } from './tipos.ts'

/**
 * Recusa no campo do formulario a caixa que nao pode receber os animais: inexistente, liberada,
 * que nao e de estoque, do outro sexo ou de outra linhagem. O trigger dos animais cobra o mesmo no
 * banco; aqui a recusa sai com o porque. A caixa ja esta travada
 */
export async function exigirEstoqueQueRecebe(
  tx: Pick<Prisma.TransactionClient, 'caixa'>,
  idCaixa: number,
  campo: string,
  quem: { sexo: Sexo; idLinhagem: number },
): Promise<void> {
  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: { ativa: true, tipo: true, sexo: true, idLinhagem: true },
  })

  if (caixa === null) throw campoInvalido(campo, 'Esta caixa nao existe.')
  if (!caixa.ativa) throw campoInvalido(campo, 'Esta caixa ja foi liberada.')

  if (caixa.tipo !== 'estoque') {
    throw campoInvalido(campo, 'Fora da caixa do casal, os animais so ficam numa caixa de estoque.')
  }

  if (caixa.sexo !== quem.sexo) throw campoInvalido(campo, 'Esta caixa de estoque e do outro sexo.')
  if (caixa.idLinhagem !== quem.idLinhagem) throw campoInvalido(campo, 'Esta caixa de estoque e de outra linhagem.')
}
