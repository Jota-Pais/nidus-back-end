// A liberacao da caixa que esvaziou, no fim de toda operacao que tira animal dela

import { agora } from '../../shared/relogio.ts'
import type { Prisma } from '@prisma/client'
import { erroDeRegra } from '../../shared/erros.ts'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { travarCaixas } from './travas.ts'
import type { MotivoDaLiberacao } from './tipos.ts'

type Transacao = Pick<Prisma.TransactionClient, '$queryRaw' | 'caixa' | 'animal' | 'ocorrencia' | 'historico'>

const POR_QUE: Record<MotivoDaLiberacao, string> = {
  entrega: 'a entrega levou os últimos animais',
  baixa: 'a baixa dos últimos animais a esvaziou',
  mudanca: 'os últimos animais passaram para outra caixa',
  casal_encerrado: 'o casal encerrou sem animais nela',
}

/** A caixa liberada nao recebe nem perde animal: a posicao ja pode ter outra caixa */
export function caixaLiberada(codigo: string) {
  return erroDeRegra('CAIXA_LIBERADA', `A caixa ${codigo} já foi liberada. Atualize a tela e tente de novo.`)
}

/** O parto que ainda pode nascer: nem nasceu, nem foi fechado sem ninhada */
export const partoPendente = { dtPartoReal: null, dtSemNinhada: null } satisfies Prisma.PartoWhereInput

/**
 * A data da liberacao: a do fato que esvaziou a caixa, mas nunca antes de outro fato nela. O
 * registro pode ser retroativo (a baixa do ultimo vivo com data anterior a uma morte ja
 * registrada, o encerramento antes da ultima morte na caixa), e a caixa so ficou vazia quando o
 * ultimo animal saiu
 */
export function dataDaLiberacao(dtFato: string, fatosNaCaixa: (Date | null)[]): string {
  return fatosNaCaixa.reduce<string>((maior, data) => {
    if (data === null) return maior
    const iso = dataISO(data)
    return iso > maior ? iso : maior
  }, dtFato)
}

/**
 * As datas dos ultimos fatos dos animais na caixa: a ultima saida (morte ou entrega) e a ultima
 * chegada dos que estao nela, e a ultima ocorrencia que a teve como origem ou destino (o
 * nascimento, a baixa, a mudanca, a anulacao). O registro anulado nao e fato
 */
async function fatosNaCaixa(tx: Transacao, idCaixa: number): Promise<(Date | null)[]> {
  // uma consulta de cada vez: a transacao e uma conexao so
  const animais = await tx.animal.aggregate({
    where: { idCaixa, situacao: { not: 'anulado' } },
    _max: { dtSaida: true, dtMovimento: true },
  })
  const ocorrencias = await tx.ocorrencia.aggregate({
    where: { OR: [{ idCaixaOrigem: idCaixa }, { idCaixaDestino: idCaixa }] },
    _max: { dtFato: true },
  })

  return [animais._max.dtSaida, animais._max.dtMovimento, ocorrencias._max.dtFato]
}

/**
 * Libera a caixa que ficou sem vivo, com a data do fato que a esvaziou (dataDaLiberacao) e o
 * motivo, e devolve se liberou. A de estoque libera na hora. A de casal so com o casal encerrado
 * e sem parto pendente: a femea ainda pode parir a ninhada que carrega. A posicao fica livre e
 * recebe caixa nova; liberada nao volta.
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

  const dtLiberacao = dataDaLiberacao(dtFato, await fatosNaCaixa(tx, idCaixa))

  await tx.caixa.update({
    where: { id: idCaixa },
    data: { ativa: false, dtLiberacao: paraData(dtLiberacao), motivoLiberacao: motivo, dtManutencao: agora() },
  })

  await registrarHistorico(tx, {
    idUsuario,
    entidade: 'caixa',
    idEntidade: idCaixa,
    acao: 'liberacao',
    descricao: `Caixa ${caixa.codigo} liberada em ${dataLegivel(dtLiberacao)}: ${POR_QUE[motivo]}`,
    dados: { dtLiberacao, motivo },
  })

  return true
}
