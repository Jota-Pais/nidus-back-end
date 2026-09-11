// Traduz invariante recusada pelo Postgres para o codigo de erro do contrato.
//
// A divisao de responsabilidade da decisao de stack 1.1 poe a invariante no
// banco: `CHECK`, unique parcial e trigger. Isso e certo - a regra fica de pe
// mesmo com dois processos concorrendo -, mas o preco e que a recusa chega como
// SQLSTATE, e o front nao sabe o que fazer com `23514`.
//
// Sem este arquivo toda invariante virava **500 ERRO_INTERNO**, o que e mentira
// duas vezes: nao e erro interno e nao e irrecuperavel. Sao regras de negocio,
// e o contrato ja tem codigo 409 para cada uma.
//
// **Como o erro chega.** O adapter do Prisma 7 embrulha o erro do Postgres em
// `meta.driverAdapterError.cause`, e a forma foi conferida contra o banco de
// verdade, nao suposta:
//
//   - violacao de unique -> Prisma `P2002`, com `originalCode: '23505'` e
//     `constraint.index` com o nome do indice.
//   - violacao de CHECK e `RAISE` de trigger -> Prisma `P2010` (raw) ou `P2039`
//     (ORM), com `originalCode: '23514'`. Nome da constraint so dentro da
//     mensagem; trigger nosso nao tem constraint, tem a mensagem que escrevemos.
//
// `originalCode` e o unico campo presente nos dois caminhos - `cause.code` so
// aparece em parte deles. Usar `originalCode`.

import { type CodigoErro, ErroDeAplicacao } from './erros.ts'

type CausaDoBanco = {
  originalCode?: string
  originalMessage?: string
  constraint?: { index?: string }
}

/** Desembrulha a causa do Postgres, se o erro for de banco. */
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

/**
 * As invariantes que o banco cobra, com o codigo do contrato de cada uma.
 *
 * A chave e o nome da constraint (unique e CHECK) ou o prefixo da mensagem do
 * trigger - que e texto nosso, escrito na migration, e por isso estavel.
 *
 * **Acrescentar linha aqui exige que o codigo exista na tabela 2.1 do
 * contrato.** Inventar codigo novo quebra o front, que decide comportamento
 * pelo `codigo` - e mexer no contrato e nos dois repos, no mesmo PR.
 */
const POR_INVARIANTE: Record<string, Traducao> = {
  // Unicidade parcial - RF-INF-05.
  caixa_uma_por_posicao: {
    codigo: 'POSICAO_OCUPADA',
    requisito: 'RF-INF-05',
    mensagem: 'Esta posicao da estante ja tem uma caixa ativa.',
  },
  // Unicidade parcial - RN-03.
  casal_um_ativo_por_caixa: {
    codigo: 'CAIXA_JA_TEM_CASAL_ATIVO',
    requisito: 'RN-03',
    mensagem: 'Esta caixa ja tem um casal ativo. Encerre o casal atual antes de formar outro.',
  },
  // CHECK - RN-04.
  parto_ordem_ciclo: {
    codigo: 'LIMITE_PARTOS_ATINGIDO',
    requisito: 'RN-04',
    mensagem: 'O casal ja atingiu o limite de 5 partos.',
  },
  // Trigger - RN-09, a invariante que o sistema existe para garantir.
  //
  // A mensagem do banco e melhor que qualquer texto generico que eu escrevesse
  // aqui: ela ja diz o parto, a oferta e o total que ficaria. Por isso
  // `mensagem` abaixo e so o fallback, e `traduzirErroDoBanco` prefere a do
  // banco quando ela vem.
  'RN-09': {
    codigo: 'DISPONIBILIDADE_EXCEDIDA',
    requisito: 'RN-09',
    mensagem: 'A ninhada nao tem animais suficientes para este compromisso.',
  },
}

/** Acha o nome da constraint dentro da mensagem do Postgres. */
function constraintNaMensagem(mensagem: string): string | undefined {
  return /violates (?:check|unique) constraint "([^"]+)"/.exec(mensagem)?.[1]
}

/** Acha o prefixo de requisito de uma mensagem levantada por trigger nosso. */
function requisitoNaMensagem(mensagem: string): string | undefined {
  return /^(R[NF]-[A-Z]*-?\d+):/.exec(mensagem)?.[1]
}

/**
 * O erro do contrato para uma invariante do banco, ou `undefined` se esta nao e
 * uma violacao que a API sabe nomear.
 *
 * `undefined` e de proposito: violacao de invariante que ninguem mapeou e **bug
 * nosso**, e tem de continuar caindo em 500 com log inteiro no servidor. Virar
 * 409 generico esconderia o bug atras de uma mensagem amigavel.
 */
export function traduzirErroDoBanco(erro: unknown): ErroDeAplicacao | undefined {
  const causa = causaDoBanco(erro)

  if (causa?.originalCode === undefined) {
    return undefined
  }

  // 23505 unique_violation | 23514 check_violation (inclui RAISE de trigger).
  if (causa.originalCode !== '23505' && causa.originalCode !== '23514') {
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

  // Mensagem levantada por trigger nosso ja e em portugues e traz os numeros do
  // caso; mensagem gerada pelo Postgres ("duplicate key value violates...") e
  // para log, nao para usuario.
  const doTrigger = requisitoNaMensagem(mensagemDoBanco) !== undefined

  return new ErroDeAplicacao(
    409,
    traducao.codigo,
    doTrigger ? mensagemDoBanco : traducao.mensagem,
    { requisito: traducao.requisito },
  )
}
