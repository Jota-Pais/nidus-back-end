// O que os animais do parto e a trilha deles dizem sobre as datas do parto: uma data do parto
// nunca deixa um fato dos animais fora de ordem. Aqui ficam os limites do desmame, os mesmos no
// registro e na correcao, as selecoes que acompanham o desmame e a contagem dos vivos no dia dele

import type { Prisma } from '@prisma/client'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import type { AnimalDoParto } from '../colonia/consultas.ts'
import { MOTIVO_SELECAO, contarPorSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { exigirOrdem } from './ordemDasDatas.ts'

type Transacao = Prisma.TransactionClient

const ROTULO_DO_FATO: Record<string, string> = { baixa: 'baixa', mudanca: 'passagem para outra caixa', entrega: 'entrega' }

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

/** 'da primeira passagem para outra caixa dos animais deste parto', para a mensagem da data */
export function rotuloDoFato(fato: { tipo: string } | null): string {
  return `da primeira ${fato === null ? 'saída' : (ROTULO_DO_FATO[fato.tipo] ?? fato.tipo)} dos animais deste parto`
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
 * Quando o primeiro animal do parto chegou a uma caixa que nao e a do casal, pela trilha: a
 * mudanca, o animal a mais da correcao do nascimento, que entra direto no estoque, e a volta da
 * anulacao para outra caixa. Pela trilha, e nao pela chegada gravada no animal: essa e a da caixa
 * atual, e o animal que chegou ao estoque e mudou de novo perderia a primeira. Registro anulado
 * nao conta (o animal nao existiu). Null se nenhum saiu
 */
export async function primeiraChegadaFora(tx: Transacao, idParto: number, idCaixaDoCasal: number): Promise<Date | null> {
  const chegada = await tx.ocorrencia.findFirst({
    where: {
      tipo: { in: ['mudanca', 'correcao', 'anulacao'] },
      AND: [{ idCaixaDestino: { not: null } }, { idCaixaDestino: { not: idCaixaDoCasal } }],
      animais: { some: { animal: { idParto, situacao: { not: 'anulado' } } } },
    },
    orderBy: { dtFato: 'asc' },
    select: { dtFato: true },
  })

  return chegada?.dtFato ?? null
}

/** O parto como os limites do desmame precisam dele */
type PartoDoDesmame = { id: number; dtPartoReal: Date | null; casal: { idCaixa: number } }

/**
 * O que limita a data do desmame, lido na trilha do parto. A eutanasia de selecao nao limita: a que
 * ficou depois da data vai para ela (levarSelecoesParaODesmame)
 */
export type LimitesDoDesmame = {
  /** a primeira mudanca ou entrega dos animais do parto: o desmame nao passa dela */
  saida: { tipo: string; dtFato: Date } | null
  /** a primeira chegada de animais do parto numa caixa que nao e a do casal (primeiraChegadaFora) */
  chegadaFora: Date | null
}

/** Os limites do desmame do parto, os mesmos no registro, na correcao e na ficha */
export async function limitesDoDesmame(tx: Transacao, parto: PartoDoDesmame): Promise<LimitesDoDesmame> {
  // uma consulta de cada vez: a transacao e uma conexao so
  const saida = await primeiroFato(tx, parto.id, ['mudanca', 'entrega'])
  const chegadaFora = await primeiraChegadaFora(tx, parto.id, parto.casal.idCaixa)

  return { saida, chegadaFora }
}

/**
 * O primeiro dia em que um animal do parto deixou a caixa do casal (a saida ou a chegada fora,
 * a que veio antes): o desmame nao passa dele. Null quando nenhum deixou
 */
export function primeiraSaida(limites: LimitesDoDesmame): Date | null {
  const { saida, chegadaFora } = limites
  if (saida === null) return chegadaFora
  return chegadaFora === null || saida.dtFato <= chegadaFora ? saida.dtFato : chegadaFora
}

/**
 * A data do desmame fica depois do parto, e nunca depois de um animal do parto sair da caixa do
 * casal: pela mudanca, pela entrega ou chegando ao estoque como animal a mais. Morte na caixa nao
 * limita: quem morreu depois da data chegou ao desmame, e quem morreu antes, nao (contarNoDesmame).
 * A eutanasia de selecao tambem nao: a selecao e antes do desmame, e a que ficou depois da data vai
 * para ela (levarSelecoesParaODesmame)
 */
export async function exigirDataDoDesmame(tx: Transacao, parto: PartoDoDesmame, dtDesmame: string): Promise<void> {
  const { saida, chegadaFora } = await limitesDoDesmame(tx, parto)

  exigirOrdem('dtDesmameReal', dtDesmame, {
    depoisDe: [{ evento: 'do parto', data: parto.dtPartoReal }],
    antesDe: [
      { evento: rotuloDoFato(saida), data: saida?.dtFato },
      { evento: 'da chegada de animais deste parto numa caixa de estoque', data: chegadaFora },
    ],
  })
}

/** As selecoes que passaram para a data do desmame: os animais delas e as datas de antes */
export type SelecoesLevadas = {
  /** os animais das selecoes levadas, que ganham a saida nova */
  ids: number[]
  /** as datas de antes, 'aaaa-mm-dd', sem repetir e em ordem */
  datas: string[]
}

/**
 * A eutanasia de selecao e antes do desmame. A que ficou depois da data do desmame (a ninhada
 * antiga lancada com a data de hoje, o desmame corrigido para antes dela) passa para a data do
 * desmame: a ocorrencia aqui, e a saida dos animais dela pela ocorrencia de correcao que quem chama
 * lanca com os 'ids' (a unica porta de escrita no animal). A selecao anulada fica como esta
 */
export async function levarSelecoesParaODesmame(
  tx: Transacao,
  idParto: number,
  dtDesmame: string,
): Promise<SelecoesLevadas> {
  const selecoes = await tx.ocorrencia.findMany({
    where: {
      tipo: 'baixa',
      idParto,
      motivo: MOTIVO_SELECAO,
      anulacoes: { none: {} },
      dtFato: { gt: paraData(dtDesmame) },
    },
    orderBy: { dtFato: 'asc' },
    select: { id: true, dtFato: true, animais: { select: { idAnimal: true } } },
  })

  for (const selecao of selecoes) {
    await tx.ocorrencia.update({ where: { id: selecao.id }, data: { dtFato: paraData(dtDesmame) } })
  }

  return {
    ids: selecoes.flatMap((selecao) => selecao.animais.map((ligacao) => ligacao.idAnimal)),
    datas: [...new Set(selecoes.map((selecao) => dataISO(selecao.dtFato)))],
  }
}

/** 'as eutanásias de seleção de 16/11/2026 passaram para 20/03/2026', ou null sem selecao levada */
export function selecoesQuePassaram(levadas: SelecoesLevadas, dtDesmame: string): string | null {
  if (levadas.datas.length === 0) return null

  const datas = levadas.datas.map(dataLegivel)
  const de = datas.length === 1 ? datas[0] : `${datas.slice(0, -1).join(', ')} e ${datas.at(-1)}`

  return `as eutanásias de seleção de ${de} passaram para ${dataLegivel(dtDesmame)}`
}

/** Os tipos de fato dos animais que a data do nascimento nunca passa */
const FATOS_DEPOIS_DO_NASCIMENTO = ['baixa', 'mudanca', 'entrega']

/**
 * O primeiro fato dos animais do parto que a data do nascimento nao passa: a primeira baixa,
 * mudanca ou entrega nao anulada. O mesmo na correcao do nascimento e na ficha
 */
export function primeiroFatoDoNascimento(tx: Transacao, idParto: number) {
  return primeiroFato(tx, idParto, FATOS_DEPOIS_DO_NASCIMENTO)
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
