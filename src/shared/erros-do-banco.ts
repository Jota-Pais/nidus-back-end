// traduz invariante recusada pelo Postgres para o codigo de erro da API

import { type CodigoErro, ErroDeAplicacao } from './erros.ts'

type CausaDoBanco = {
  originalCode?: string
  originalMessage?: string
  constraint?: { index?: string }
}

/** desembrulha a causa do Postgres, se o erro for de banco */
function causaDoBanco(erro: unknown): CausaDoBanco | undefined {
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
  mensagem: string
}

/**
 * As constraints que o banco cobra, com o codigo de erro da API de cada uma. O Postgres so da o
 * nome da constraint, entao a mensagem para o usuario e esta
 */
const POR_CONSTRAINT: Record<string, Traducao> = {
  // unicidade parcial
  caixa_uma_por_posicao: {
    codigo: 'POSICAO_OCUPADA',
    mensagem: 'Esta posicao da estante ja tem uma caixa ativa.',
  },
  // unicidade parcial
  casal_um_ativo_por_caixa: {
    codigo: 'CAIXA_JA_TEM_CASAL_ATIVO',
    mensagem: 'Esta caixa ja tem um casal ativo. Encerre o casal atual antes de formar outro.',
  },
  parto_id_casal_ordem_key: {
    codigo: 'SEQUENCIA_INVALIDA',
    mensagem: 'Este parto ja foi aberto por outro registro de acasalamento. Atualize a ficha.',
  },
  // uma baixa so se anula uma vez: o duplo clique em Anular cai aqui
  ocorrencia_id_anulada_key: {
    codigo: 'OCORRENCIA_JA_ANULADA',
    mensagem: 'Esta baixa ja foi anulada. Atualize a ficha.',
  },
  // CHECK
  parto_ordem_ciclo: {
    codigo: 'LIMITE_PARTOS_ATINGIDO',
    mensagem: 'O casal ja atingiu o limite de 5 partos.',
  },
  // CHECKs de data. O zod das rotas e os servicos conferem antes, com a mensagem no campo; estes
  // sao a rede de seguranca
  parto_datas_em_ordem: {
    codigo: 'DATA_FORA_DA_ORDEM',
    mensagem:
      'As datas do parto ficariam fora de ordem: o nascimento vem depois do acasalamento e o desmame depois do nascimento (o mesmo dia vale).',
  },
  casal_encerra_depois_de_formar: {
    codigo: 'DATA_FORA_DA_ORDEM',
    mensagem: 'O encerramento do casal nao pode ser antes da formacao.',
  },
  animal_sai_depois_de_chegar: {
    codigo: 'DATA_FORA_DA_ORDEM',
    mensagem: 'A data e anterior a chegada dos animais nesta caixa.',
  },
  // FK composta do par genetico. Rede de seguranca: a mensagem rica vem da pre-validacao em
  // 'reproducao.service.ts'
  casal_grupo_macho_grupo_femea_fkey: {
    codigo: 'PAR_GENETICO_INVALIDO',
    mensagem: 'Este par nao esta na rotacao genetica permitida.',
  },
  usuario_email_key: {
    codigo: 'EMAIL_EM_USO',
    mensagem: 'Ja existe uma conta com este e-mail.',
  },
  projeto_numero_key: {
    codigo: 'PROJETO_DUPLICADO',
    mensagem: 'Ja existe um projeto com este numero.',
  },
  linhagem_id_especie_nome_key: {
    codigo: 'LINHAGEM_DUPLICADA',
    mensagem: 'Ja existe uma linhagem com este nome nesta especie.',
  },
}

/**
 * Os prefixos que os tres triggers poem no RAISE ('ANIMAL_CAIXA: a caixa F2A ...'), com o codigo
 * de erro da API de cada um. O RAISE nao informa o nome do trigger, entao a chave e o prefixo; a
 * mensagem e o proprio texto do trigger, que ja e em portugues e traz os numeros do caso
 */
const POR_PREFIXO: Record<string, CodigoErro> = {
  // infra.caixa_dentro_da_topologia: a posicao nao cabe na estante
  TOPOLOGIA: 'TOPOLOGIA',
  // colonia.animal_coerente
  ANIMAL_ORIGEM: 'ANIMAL_ORIGEM',
  ANIMAL_SITUACAO: 'ANIMAL_SITUACAO',
  ANIMAL_CAIXA: 'ANIMAL_CAIXA',
  PEDIDO_RESERVA: 'PEDIDO_RESERVA',
  PEDIDO_EXCEDIDO: 'PEDIDO_EXCEDIDO',
  // demanda.pedido_coerente
  PEDIDO_INCOMPLETO: 'PEDIDO_INCOMPLETO',
  PEDIDO_COM_RESERVA: 'PEDIDO_COM_RESERVA',
}

/** Acha o nome da constraint dentro da mensagem do Postgres */
function constraintNaMensagem(mensagem: string): string | undefined {
  return /violates (?:check|unique|foreign key) constraint "([^"]+)"/.exec(mensagem)?.[1]
}

/** Acha o prefixo ('ANIMAL_CAIXA') de uma mensagem levantada por trigger nosso */
function prefixoDoTrigger(mensagem: string): string | undefined {
  return /^([A-Z][A-Z_]+):/.exec(mensagem)?.[1]
}

/** O texto do trigger sem o prefixo, que nao diz nada ao usuario */
function semPrefixo(mensagem: string, prefixo: string): string {
  const texto = mensagem.slice(prefixo.length + 1).trim()

  return texto.charAt(0).toUpperCase() + texto.slice(1)
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
  const prefixo = prefixoDoTrigger(mensagemDoBanco)

  if (prefixo !== undefined) {
    const codigo = POR_PREFIXO[prefixo]

    return codigo === undefined
      ? undefined
      : new ErroDeAplicacao(409, codigo, semPrefixo(mensagemDoBanco, prefixo))
  }

  // Mensagem gerada pelo Postgres ("duplicate key value violates...") e para log, nao para
  // usuario: o texto vem da tabela
  const chave = causa.constraint?.index ?? constraintNaMensagem(mensagemDoBanco)
  const traducao = chave === undefined ? undefined : POR_CONSTRAINT[chave]

  return traducao === undefined
    ? undefined
    : new ErroDeAplicacao(409, traducao.codigo, traducao.mensagem)
}
