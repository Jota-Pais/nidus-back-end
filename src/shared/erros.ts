// Erros de dominio, sempre no envelope { erro: { codigo, mensagem, campos? } }

/** O front trata qualquer 409 mostrando a mensagem, sem precisar conhecer cada codigo */
export type CodigoErro =
  | 'VALIDACAO'
  | 'NAO_AUTENTICADO'
  | 'SEM_PERMISSAO'
  | 'NAO_ENCONTRADO'
  | 'PAR_GENETICO_INVALIDO'
  | 'CAIXA_JA_TEM_CASAL_ATIVO'
  | 'LIMITE_PARTOS_ATINGIDO'
  | 'POSICAO_OCUPADA'
  | 'SEQUENCIA_INVALIDA'
  | 'PEDIDO_JA_RESERVADO'
  | 'PEDIDO_INCOMPLETO'
  | 'PEDIDO_EXCEDIDO'
  | 'PEDIDO_RESERVA'
  | 'PEDIDO_COM_RESERVA'
  | 'PEDIDO_ENTREGUE'
  | 'IDADE_FORA_DA_FAIXA'
  | 'NAO_DESMAMADO'
  | 'ANIMAL_ORIGEM'
  | 'ANIMAL_SITUACAO'
  | 'ANIMAL_CAIXA'
  | 'OCORRENCIA_JA_ANULADA'
  | 'DATA_FORA_DA_ORDEM'
  | 'TOPOLOGIA'
  | 'ESTANTE_DUPLICADA'
  | 'ESTANTE_OCUPADA'
  | 'CAIXA_COM_ANIMAIS'
  | 'CAIXA_LIBERADA'
  | 'SEM_ANIMAIS'
  | 'PEDIDO_NAO_INDICADO'
  | 'CAIXA_DE_ESTOQUE'
  | 'SALA_DUPLICADA'
  | 'SALA_COM_ESTANTE'
  | 'CODIGO_INVALIDO'
  | 'MUITAS_TENTATIVAS'
  | 'EMAIL_EM_USO'
  | 'ALTERACAO_PROPRIA'
  | 'CONTA_INATIVA'
  | 'PROJETO_DUPLICADO'
  | 'LINHAGEM_DUPLICADA'
  | 'ERRO_INTERNO'

export type ExtrasErro = {
  /** Mensagem por campo. Obrigatorio em VALIDACAO. */
  campos?: Record<string, string>
}

export class ErroDeAplicacao extends Error {
  constructor(
    readonly status: number,
    readonly codigo: CodigoErro,
    /** Em portugues, pronta para exibir ao usuario */
    mensagem: string,
    readonly extras: ExtrasErro = {},
  ) {
    super(mensagem)
    this.name = new.target.name
  }
}

/** 400 - campos com problema, todos de uma vez: cada mensagem vai no seu campo, que o formulario destaca */
export const camposInvalidos = (campos: Record<string, string>) =>
  new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', { campos })

/** 400 - um campo com problema: a mensagem vai no campo, que o formulario destaca */
export const campoInvalido = (campo: string, mensagem: string) => camposInvalidos({ [campo]: mensagem })

/** 401 - sem cookie de sessao valido */
export const naoAutenticado = () =>
  new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'Faca login para continuar.')

/** 403 - autenticado mas o perfil nao alcanca o recurso. */
export const semPermissao = () =>
  new ErroDeAplicacao(403, 'SEM_PERMISSAO', 'Seu perfil nao tem acesso a esta operacao.')

/** 404 - inexistente ou fora do alcance do perfil */
export const naoEncontrado = (oQue: string) =>
  new ErroDeAplicacao(404, 'NAO_ENCONTRADO', `${oQue} nao encontrado.`)

/**
 * 409 - regra de negocio violada. Na API todo 409 e regra: o front pode
 * tratar qualquer um deles mostrando a mensagem, sem conhecer cada codigo.
 */
export const erroDeRegra = (codigo: CodigoErro, mensagem: string, extras: ExtrasErro = {}) =>
  new ErroDeAplicacao(409, codigo, mensagem, extras)

/** 429 - pedido demais no intervalo. Sem 'campos': o front mostra no aviso do alto */
export const muitasTentativas = (mensagem: string) =>
  new ErroDeAplicacao(429, 'MUITAS_TENTATIVAS', mensagem)
