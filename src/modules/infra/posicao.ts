// Uma posicao da estante escolhida no formulario: onde nasce a caixa nova (do casal ou de
// estoque) e para onde uma caixa muda. O codigo da caixa (F1A) quem escreve e o trigger da
// posicao; aqui so se confere que a posicao existe e quem esta nela

import type { Prisma } from '@prisma/client'
import { campoInvalido, naoEncontrado } from '../../shared/erros.ts'

export type PosicaoNaEstante = {
  idEstante: number
  face: 'frontal' | 'traseira'
  linha: number
  coluna: number
}

type Leitura = Pick<Prisma.TransactionClient, 'estante' | 'caixa'>

/**
 * A estante ativa, a face em numero e a caixa ativa que ocupa a posicao (null se vazia). Recusa
 * a estante removida e a posicao que nao existe nela, com a mensagem no campo
 */
export async function lerPosicao(banco: Leitura, posicao: PosicaoNaEstante, campo: string) {
  const estante = await banco.estante.findFirst({
    where: { id: posicao.idEstante, ativa: true },
    select: { id: true, numeroVisivel: true, faces: true, linhas: true, colunas: true },
  })

  if (estante === null) throw naoEncontrado('Estante')

  const face = posicao.face === 'frontal' ? 1 : 2

  if (face > estante.faces || posicao.linha > estante.linhas || posicao.coluna > estante.colunas) {
    throw campoInvalido(campo, 'Esta posição não existe na estante.')
  }

  const ocupante = await banco.caixa.findFirst({
    where: { idEstante: estante.id, face, linha: posicao.linha, coluna: posicao.coluna, ativa: true },
    select: { id: true },
  })

  return { estante, face, linha: posicao.linha, coluna: posicao.coluna, ocupante }
}

/** A posicao vazia onde a caixa nova vai nascer. A ocupada e recusada no campo */
export async function exigirPosicaoVazia(banco: Leitura, posicao: PosicaoNaEstante, campo: string) {
  const lida = await lerPosicao(banco, posicao, campo)

  if (lida.ocupante !== null) throw campoInvalido(campo, 'Esta posição da estante já tem uma caixa ativa.')

  return lida
}
