// O que os animais do parto e a trilha deles dizem sobre as datas do parto: uma data do parto
// nunca deixa um fato dos animais fora de ordem. Aqui ficam os limites do desmame, os mesmos no
// registro e na correcao, e a contagem dos vivos no dia do desmame

import type { Prisma } from '@prisma/client'
import { dataISO } from '../../shared/traducao.ts'
import type { AnimalDoParto } from '../colonia/consultas.ts'
import { MOTIVO_SELECAO, contarPorSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { exigirOrdem } from './ordemDasDatas.ts'

type Transacao = Prisma.TransactionClient

const ROTULO_DO_FATO: Record<string, string> = { baixa: 'baixa', mudanca: 'mudanca de caixa', entrega: 'entrega' }

/**
 * O primeiro fato dos animais do parto entre os tipos pedidos, sem contar baixa anulada (o animal
 * nao morreu). Null quando nao houve nenhum
 */
export function primeiroFato(tx: Transacao, idParto: number, tipos: string[]) {
  return tx.ocorrencia.findFirst({
    where: { tipo: { in: tipos }, anulacoes: { none: {} }, animais: { some: { animal: { idParto } } } },
    orderBy: { dtFato: 'asc' },
    select: { tipo: true, dtFato: true },
  })
}

/** 'da primeira mudanca de caixa dos animais deste parto', para a mensagem da data */
export function rotuloDoFato(fato: { tipo: string } | null): string {
  return `da primeira ${fato === null ? 'saida' : (ROTULO_DO_FATO[fato.tipo] ?? fato.tipo)} dos animais deste parto`
}

/**
 * A baixa do parto com o motivo dado que nao foi anulada, a primeira ou a ultima pela data, com
 * os animais dela. Null quando nao ha
 */
export function baixaDoParto(tx: Transacao, idParto: number, motivo: string, ordem: 'asc' | 'desc') {
  return tx.ocorrencia.findFirst({
    where: { tipo: 'baixa', idParto, motivo, anulacoes: { none: {} } },
    orderBy: { dtFato: ordem },
    select: { id: true, dtFato: true, animais: { select: { idAnimal: true } } },
  })
}

/**
 * Quando o primeiro animal do parto chegou a uma caixa que nao e a do casal: pela mudanca ou como
 * animal a mais da correcao do nascimento, que entra direto no estoque. Null se nenhum saiu
 */
export function primeiraChegadaFora(animais: AnimalDoParto[], idCaixaDoCasal: number): Date | null {
  return animais.reduce<Date | null>(
    (primeira, animal) =>
      animal.situacao !== 'anulado' &&
      animal.idCaixa !== idCaixaDoCasal &&
      animal.dtMovimento !== null &&
      (primeira === null || animal.dtMovimento < primeira)
        ? animal.dtMovimento
        : primeira,
    null,
  )
}

/** O parto como os limites do desmame precisam dele */
type PartoDoDesmame = { id: number; dtPartoReal: Date | null; casal: { idCaixa: number } }

/**
 * A data do desmame fica depois do parto e da ultima eutanasia de selecao (a selecao e antes do
 * desmame), e nunca depois de um animal do parto sair da caixa do casal: pela mudanca, pela
 * entrega ou chegando ao estoque como animal a mais. Morte na caixa nao limita: quem morreu depois
 * da data chegou ao desmame, e quem morreu antes, nao (contarNoDesmame)
 */
export async function exigirDataDoDesmame(
  tx: Transacao,
  parto: PartoDoDesmame,
  dtDesmame: string,
  animais: AnimalDoParto[],
): Promise<void> {
  // uma consulta de cada vez: a transacao e uma conexao so
  const ultimaSelecao = await baixaDoParto(tx, parto.id, MOTIVO_SELECAO, 'desc')
  const saida = await primeiroFato(tx, parto.id, ['mudanca', 'entrega'])

  exigirOrdem('dtDesmameReal', dtDesmame, {
    depoisDe: [
      { evento: 'do parto', data: parto.dtPartoReal },
      { evento: 'da ultima eutanasia de selecao', data: ultimaSelecao?.dtFato },
    ],
    antesDe: [
      { evento: rotuloDoFato(saida), data: saida?.dtFato },
      {
        evento: 'da chegada de animais deste parto numa caixa de estoque',
        data: primeiraChegadaFora(animais, parto.casal.idCaixa),
      },
    ],
  })
}

/** Os animais do parto no dia do desmame, por sexo */
export type NoDesmame = {
  /** Os vivos na caixa do casal naquele dia: os de agora mais os que morreram depois */
  vivos: PorSexo
  /** Os que morreram depois do dia do desmame: chegaram a ele, e o desmamado nao fica abaixo */
  morreramDepois: PorSexo
}

/**
 * Quem estava vivo na caixa do casal no dia do desmame. A morte no proprio dia conta como antes,
 * como na ficha do parto (cicloFicha): o desmame conta quem sobrou no fim do dia
 */
export function contarNoDesmame(animais: AnimalDoParto[], idCaixaDoCasal: number, dtDesmame: string): NoDesmame {
  const naCaixa = animais.filter((animal) => animal.idCaixa === idCaixaDoCasal)
  const agora = contarPorSexo(naCaixa.filter((animal) => animal.situacao === 'vivo'))
  const morreramDepois = contarPorSexo(
    naCaixa.filter(
      (animal) => animal.situacao === 'morto' && animal.dtSaida !== null && dataISO(animal.dtSaida) > dtDesmame,
    ),
  )

  return { vivos: { m: agora.m + morreramDepois.m, f: agora.f + morreramDepois.f }, morreramDepois }
}
