// traduz invariante recusada pelo Postgres para o codigo de erro da API

import { type CodigoErro, ErroDeAplicacao } from './erros.ts'

type CausaDoBanco = {
  originalCode?: string
  originalMessage?: string
  constraint?: { index?: string }
}

/** desembrulha a causa do Postgres, se o erro for de banco */
export function causaDoBanco(erro: unknown): CausaDoBanco | undefined {
  if (typeof erro !== 'object' || erro === null) {
    return undefined
  }

  const meta = (erro as { meta?: { driverAdapterError?: { cause?: unknown } } }).meta
  const causa = meta?.driverAdapterError?.cause

  if (typeof causa !== 'object' || causa === null) {
    return undefined
  }

  return causa as CausaDoBanco
}

type Traducao = {
  codigo: CodigoErro
  requisito: string
  mensagem: string
}

/** As invariantes que o banco cobra, com o codigo de erro da API de cada uma. */
const POR_INVARIANTE: Record<string, Traducao> = {
  // unicidade parcial
  caixa_uma_por_posicao: {
    codigo: 'POSICAO_OCUPADA',
    requisito: 'RF-INF-05',
    mensagem: 'Esta posicao da estante ja tem uma caixa ativa.',
  },
  // unicidade parcial
  casal_um_ativo_por_caixa: {
    codigo: 'CAIXA_JA_TEM_CASAL_ATIVO',
    requisito: 'RN-03',
    mensagem: 'Esta caixa ja tem um casal ativo. Encerre o casal atual antes de formar outro.',
  },
  // CHECK
  parto_ordem_ciclo: {
    codigo: 'LIMITE_PARTOS_ATINGIDO',
    requisito: 'RN-04',
    mensagem: 'O casal ja atingiu o limite de 5 partos.',
  },
  // trigger de disponibilidade, a invariante que o sistema existe para garantir
  'RN-09': {
    codigo: 'DISPONIBILIDADE_EXCEDIDA',
    requisito: 'RN-09',
    mensagem: 'A ninhada nao tem animais suficientes para este compromisso.',
  },
  // FK composta do par genetico. Rede de seguranca: a mensagem rica vem da pre-validacao em
  // 'reproducao.service.ts'
  casal_grupo_macho_grupo_femea_fkey: {
    codigo: 'PAR_GENETICO_INVALIDO',
    requisito: 'RN-02',
    mensagem: 'Este par nao esta na rotacao genetica permitida.',
  },
}

/** Acha o nome da constraint dentro da mensagem do Postgres */
function constraintNaMensagem(mensagem: string): string | undefined {
  return /violates (?:check|unique|foreign key) constraint "([^"]+)"/.exec(mensagem)?.[1]
}

/** Acha o prefixo de requisito de uma mensagem levantada por trigger nosso */
function requisitoNaMensagem(mensagem: string): string | undefined {
  return /^(R[NF]-[A-Z]*-?\d+):/.exec(mensagem)?.[1]
}

/**
 * O erro da API para uma invariante do banco, ou undefined se esta nao e uma
 * violacao que a API sabe nomear
 */
export function traduzirErroDoBanco(erro: unknown): ErroDeAplicacao | undefined {
  const causa = causaDoBanco(erro)

  if (causa?.originalCode === undefined) {
    return undefined
  }

  // 23505 unique_violation | 23514 check_violation (inclui RAISE de
  // trigger) | 23503 foreign_key_violation (FK composta do par genetico).
  if (
    causa.originalCode !== '23505' &&
    causa.originalCode !== '23514' &&
    causa.originalCode !== '23503'
  ) {
    return undefined
  }

  const mensagemDoBanco = causa.originalMessage ?? ''

  const chave =
    causa.constraint?.index ??
    constraintNaMensagem(mensagemDoBanco) ??
    requisitoNaMensagem(mensagemDoBanco)

  const traducao = chave === undefined ? undefined : POR_INVARIANTE[chave]

  if (traducao === undefined) {
    return undefined
  }

  // Mensagem levantada por trigger nosso ja e em portugues e traz os numeros do caso;
  // mensagem gerada pelo Postgres ("duplicate key value violates...") e para log, nao para
  // usuario
  const doTrigger = requisitoNaMensagem(mensagemDoBanco) !== undefined

  return new ErroDeAplicacao(
    409,
    traducao.codigo,
    doTrigger ? mensagemDoBanco : traducao.mensagem,
    { requisito: traducao.requisito },
  )
}
