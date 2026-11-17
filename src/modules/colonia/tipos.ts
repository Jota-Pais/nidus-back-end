// O vocabulario da colonia: sexo, contagem por sexo, as situacoes do animal e os motivos que o
// sistema escreve sozinho nas baixas

export type Sexo = 'M' | 'F'

export const SEXOS: Sexo[] = ['M', 'F']

/** Quantidade por sexo. E como a API conta animal em todo lugar */
export type PorSexo = { m: number; f: number }

export const ROTULO_DO_SEXO: Record<Sexo, string> = { M: 'machos', F: 'fêmeas' }

const UM_DO_SEXO: Record<Sexo, string> = { M: 'macho', F: 'fêmea' }

/** A quantidade de um sexo dentro de um PorSexo */
export function doSexo(contagem: PorSexo, sexo: Sexo): number {
  return sexo === 'M' ? contagem.m : contagem.f
}

// ------------------------------------------------------------ como o texto conta animal
//
// Toda mensagem e descricao que conta animais passa por aqui, para nunca sair "1 machos" nem
// "0 F". Quando o verbo vem depois da quantidade, ele concorda pelo noNumero.

/** "1 macho", "2 machos", "1 femea", "2 femeas" */
export function quantosDoSexo(qtd: number, sexo: Sexo): string {
  return `${qtd} ${qtd === 1 ? UM_DO_SEXO[sexo] : ROTULO_DO_SEXO[sexo]}`
}

/** "2 machos e 1 femea", "3 femeas": so o sexo que tem animal. Sem nenhum, "nenhum animal" */
export function quantosAnimais(contagem: PorSexo): string {
  const partes = SEXOS.filter((sexo) => doSexo(contagem, sexo) > 0).map((sexo) =>
    quantosDoSexo(doSexo(contagem, sexo), sexo),
  )

  return partes.length === 0 ? 'nenhum animal' : partes.join(' e ')
}

/** O verbo concorda com quantos animais: noNumero(1, 'voltou', 'voltaram') e 'voltou' */
export function noNumero(qtd: number, singular: string, plural: string): string {
  return qtd === 1 ? singular : plural
}

/** Soma um animal do sexo a contagem, sem mexer na original */
export function somarUm(contagem: PorSexo, sexo: Sexo): PorSexo {
  return sexo === 'M' ? { ...contagem, m: contagem.m + 1 } : { ...contagem, f: contagem.f + 1 }
}

/** vivo | morto (morte ou eutanasia) | entregue | anulado (registro de animal que nao existiu) */
export type Situacao = 'vivo' | 'morto' | 'entregue' | 'anulado'

/** Por que a caixa foi liberada: o fato que a esvaziou */
export type MotivoDaLiberacao = 'entrega' | 'baixa' | 'mudanca' | 'casal_encerrado'

/** A ninhada como as mensagens a nomeiam: com casal, a ordem do parto e o casal; sem, nulos */
export type OrigemDaNinhada = { ordem: number | null; casal: string | null }

/**
 * De onde veio a ninhada, para o texto: 'do 2º parto do casal AB', ou 'do cadastro inicial' na
 * ninhada sem casal conhecido (os animais que ja estavam na colonia antes do Nidus)
 */
export function origemDaNinhada(ninhada: OrigemDaNinhada): string {
  return ninhada.ordem === null || ninhada.casal === null
    ? 'do cadastro inicial'
    : `do ${ninhada.ordem}º parto do casal ${ninhada.casal}`
}

/** O motivo da baixa que a selecao lanca: a eutanasia dos filhotes a mais, antes do desmame */
export const MOTIVO_SELECAO = 'eutanasia de selecao'

/** O motivo da baixa que o desmame lanca para a diferenca entre os vivos e os desmamados */
export const MOTIVO_NAO_CHEGOU_AO_DESMAME = 'nao chegou ao desmame'

/**
 * O motivo que a anulacao grava quando quem anula nao escreve um. O banco cobra motivo na anulacao
 * e na correcao (a trilha diz por que o fato mudou), e anular nao pede motivo: o texto e do sistema
 */
export const MOTIVO_DA_ANULACAO = 'baixa lançada por engano'

/** O sexo do animal como o banco guarda (char(1)) */
export function sexoDe(animal: { sexo: string }): Sexo {
  return animal.sexo === 'M' ? 'M' : 'F'
}

/** Quantos animais de cada sexo ha na lista */
export function contarPorSexo(animais: { sexo: string }[]): PorSexo {
  return animais.reduce<PorSexo>((soma, animal) => somarUm(soma, sexoDe(animal)), { m: 0, f: 0 })
}
