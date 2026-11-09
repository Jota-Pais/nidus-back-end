// A liberacao da caixa que esvaziou, no fim de toda operacao que tira animal dela

import type { Prisma } from '@prisma/client'
import { erroDeRegra } from '../../shared/erros.ts'
import { paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { travarCaixas } from './travas.ts'
import type { MotivoDaLiberacao } from './tipos.ts'

type Transacao = Pick<Prisma.TransactionClient, '$queryRaw' | 'caixa' | 'animal' | 'historico'>

const POR_QUE: Record<MotivoDaLiberacao, string> = {
  entrega: 'a entrega levou os ultimos animais',
  baixa: 'nao sobrou animal vivo nela',
  mudanca: 'os animais foram para outra caixa',
  casal_encerrado: 'o casal encerrou e nao sobrou animal nela',
}

/** A caixa liberada nao recebe nem perde animal: a posicao ja pode ter outra caixa */
export function caixaLiberada(codigo: string) {
  return erroDeRegra('CAIXA_LIBERADA', `A caixa ${codigo} ja foi liberada. Atualize a tela.`)
}

/** O parto que ainda pode nascer: nem nasceu, nem foi fechado sem ninhada */
export const partoPendente = { dtPartoReal: null, dtSemNinhada: null } satisfies Prisma.PartoWhereInput

/**
 * Libera a caixa que ficou sem vivo, com a data do fato que a esvaziou e o motivo, e devolve se
 * liberou. A de estoque libera na hora. A de casal so com o casal encerrado e sem parto pendente:
 * a femea ainda pode parir a ninhada que carrega. A posicao fica livre e recebe caixa nova;
 * liberada nao volta.
 *
 * Trava a caixa antes de contar: quem poe animal nela le a caixa com FOR SHARE (trigger do
 * animal), entao ninguem entra depois da contagem
 */
export async function liberarSeVazia(
  tx: Transacao,
  idCaixa: number,
  dtFato: string,
  motivo: MotivoDaLiberacao,
  idUsuario: number | null,
): Promise<boolean> {
  await travarCaixas(tx, [idCaixa])

  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      id: true,
      codigo: true,
      ativa: true,
      tipo: true,
      casais: { select: { ativo: true, partos: { where: partoPendente, select: { id: true } } } },
    },
  })

  if (caixa === null || !caixa.ativa) return false

  if (caixa.tipo === 'casal') {
    const segura = caixa.casais.some((casal) => casal.ativo || casal.partos.length > 0)
    if (segura) return false
  }

  const vivos = await tx.animal.count({ where: { idCaixa, situacao: 'vivo' } })
  if (vivos > 0) return false

  await tx.caixa.update({
    where: { id: idCaixa },
    data: { ativa: false, dtLiberacao: paraData(dtFato), motivoLiberacao: motivo, dtManutencao: new Date() },
  })

  await registrarHistorico(tx, {
    idUsuario,
    entidade: 'caixa',
    idEntidade: idCaixa,
    acao: 'liberacao',
    descricao: `Caixa ${caixa.codigo} liberada em ${dtFato}: ${POR_QUE[motivo]}`,
    dados: { dtLiberacao: dtFato, motivo },
  })

  return true
}
