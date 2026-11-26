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
 * nome da constraint, entao a mensagem para o usuario e esta.
 *
 * So entra aqui o que um usuario consegue provocar: unicidade (duplo clique, corrida) e ordem de
 * datas, que vem digitadas. Os CHECKs de dominio e de coerencia da linha (caixa_estoque_completo,
 * caixa_liberacao_coerente, casal_ativo_coerente, animal_saida_coerente, pedido_entregue_tem_data,
 * parto_sem_ninhada_tem_motivo, as quantidades do pedido) ficam de fora de proposito: os valores
 * deles sao o codigo que calcula, ou o zod da rota que confere antes. Se um deles recusar, e bug
 * nosso, e o 500 com log e o que avisa a equipe
 */
const POR_CONSTRAINT: Record<string, Traducao> = {
  // unicidade parcial
  caixa_uma_por_posicao: {
    codigo: 'POSICAO_OCUPADA',
    mensagem: 'Esta posição da estante já tem uma caixa ativa.',
  },
  // unicidade parcial
  casal_um_ativo_por_caixa: {
    codigo: 'CAIXA_JA_TEM_CASAL_ATIVO',
    mensagem: 'Esta caixa já tem um casal ativo. Encerre o casal atual antes de formar outro.',
  },
  parto_id_casal_ordem_key: {
    codigo: 'SEQUENCIA_INVALIDA',
    mensagem: 'Este parto já foi aberto por outro registro de acasalamento. Atualize a tela e tente de novo.',
  },
  // CHECK
  parto_ordem_ciclo: {
    codigo: 'LIMITE_PARTOS_ATINGIDO',
    mensagem: 'O casal já atingiu o limite de 5 partos.',
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
    mensagem: 'O encerramento do casal não pode ser antes da formação.',
  },
  animal_sai_depois_de_chegar: {
    codigo: 'DATA_FORA_DA_ORDEM',
    mensagem: 'A data é anterior à chegada dos animais nesta caixa.',
  },
  usuario_email_key: {
    codigo: 'EMAIL_EM_USO',
    mensagem: 'Já existe uma conta com este e-mail.',
  },
  projeto_numero_key: {
    codigo: 'PROJETO_DUPLICADO',
    mensagem: 'Já existe um projeto com este número.',
  },
  linhagem_id_especie_nome_key: {
    codigo: 'LINHAGEM_DUPLICADA',
    mensagem: 'Já existe uma linhagem com este nome nesta espécie.',
  },
  // unicidade parcial: dois cadastros do mesmo nome ao mesmo tempo. O servico confere antes, com o nome
  formato_nome_unico: {
    codigo: 'FORMATO_DUPLICADO',
    mensagem: 'Já existe um formato com este nome.',
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
  // demanda.pedido_coerente (o teto visto do pedido tambem sai como PEDIDO_EXCEDIDO)
  PEDIDO_INCOMPLETO: 'PEDIDO_INCOMPLETO',
  PEDIDO_COM_RESERVA: 'PEDIDO_COM_RESERVA',
  PEDIDO_ENTREGUE: 'PEDIDO_ENTREGUE',
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

  // 23505 unique_violation | 23514 check_violation (inclui RAISE de trigger). FK quebrada (23503)
  // e bug de programacao: nenhuma e traduzida
  if (causa.originalCode !== '23505' && causa.originalCode !== '23514') {
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
