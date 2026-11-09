// O vocabulario da colonia: sexo, contagem por sexo, as situacoes do animal e os motivos que o
// sistema escreve sozinho nas baixas

export type Sexo = 'M' | 'F'

export const SEXOS: Sexo[] = ['M', 'F']

/** Quantidade por sexo. E como a API conta animal em todo lugar */
export type PorSexo = { m: number; f: number }

export const ROTULO_DO_SEXO: Record<Sexo, string> = { M: 'machos', F: 'femeas' }

/** A quantidade de um sexo dentro de um PorSexo */
export function doSexo(contagem: PorSexo, sexo: Sexo): number {
  return sexo === 'M' ? contagem.m : contagem.f
}

/** Soma um animal do sexo a contagem, sem mexer na original */
export function somarUm(contagem: PorSexo, sexo: Sexo): PorSexo {
  return sexo === 'M' ? { ...contagem, m: contagem.m + 1 } : { ...contagem, f: contagem.f + 1 }
}

/** vivo | morto (morte ou eutanasia) | entregue | anulado (registro de animal que nao existiu) */
export type Situacao = 'vivo' | 'morto' | 'entregue' | 'anulado'

/** Por que a caixa foi liberada: o fato que a esvaziou */
export type MotivoDaLiberacao = 'entrega' | 'baixa' | 'mudanca' | 'casal_encerrado'

/** O motivo da baixa que a selecao lanca: a eutanasia dos filhotes a mais, antes do desmame */
export const MOTIVO_SELECAO = 'eutanasia de selecao'

/** O motivo da baixa que o desmame lanca para a diferenca entre os vivos e os desmamados */
export const MOTIVO_NAO_CHEGOU_AO_DESMAME = 'nao chegou ao desmame'

/** O sexo do animal como o banco guarda (char(1)) */
export function sexoDe(animal: { sexo: string }): Sexo {
  return animal.sexo === 'M' ? 'M' : 'F'
}

/** Quantos animais de cada sexo ha na lista */
export function contarPorSexo(animais: { sexo: string }[]): PorSexo {
  return animais.reduce<PorSexo>((soma, animal) => somarUm(soma, sexoDe(animal)), { m: 0, f: 0 })
}
