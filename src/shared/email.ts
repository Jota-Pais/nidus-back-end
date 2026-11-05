// Envio de e-mail: o codigo de acesso e o aviso de senha alterada. Em production vai pela API HTTP
// de envio transacional da Brevo; em development e test vai para o console do servidor, sem chave
// e sem rede

import { env } from '../env.ts'

/** Envio transacional da Brevo: 201 com { messageId } no sucesso, 400 com { code, message } no erro */
const URL_DA_BREVO = 'https://api.brevo.com/v3/smtp/email'

/** Quanto o envio espera a Brevo antes de desistir. Quem chama nao espera o envio */
export const TEMPO_LIMITE_DO_ENVIO_EM_MS = 10_000

/** O nome que aparece como remetente. O endereco e o EMAIL_REMETENTE, validado na Brevo */
export const NOME_DO_REMETENTE = 'Nidus'

type Mensagem = {
  /** UM destinatario, ja validado pela rota (e-mail da UFSC, sem lista) */
  para: string
  assunto: string
  texto: string
  /** O que nao pode ir para o log se o envio falhar, alem da chave: o codigo */
  segredos?: string[]
}

/** O corpo de erro da Brevo em uma linha: '{ code, message }' quando vem assim */
function resumoDoErro(corpo: string): string {
  try {
    const { code, message } = JSON.parse(corpo) as { code?: unknown; message?: unknown }
    if (code !== undefined || message !== undefined) {
      return `${String(code)}: ${String(message)}`
    }
  } catch {
    // nao era JSON: vai o comeco do texto
  }

  return corpo.slice(0, 200)
}

/**
 * O erro do fetch com a causa: o do Node diz so 'fetch failed', e o motivo (endereco que nao
 * resolve, redirecionamento recusado) vem na causa
 */
function descricaoDoErro(erro: unknown): string {
  if (!(erro instanceof Error)) {
    return String(erro)
  }

  return erro.cause instanceof Error ? `${erro.message}: ${erro.cause.message}` : erro.message
}

/**
 * Manda um e-mail de texto pela Brevo. O destinatario vai num campo proprio do JSON, nunca
 * montado num cabecalho de texto. Qualquer falha vira um Error para o log do servidor, sem a
 * chave e sem o codigo
 */
async function enviarPelaBrevo({ para, assunto, texto, segredos = [] }: Mensagem): Promise<void> {
  const { BREVO_API_KEY: chave, EMAIL_REMETENTE: remetente } = env

  // O env.ts ja derruba o boot de production sem as duas: isto e so para o tipo e para quem
  // chegar aqui por outro caminho
  if (chave === undefined || remetente === undefined) {
    throw new Error('Envio de e-mail sem configuracao: faltam BREVO_API_KEY e EMAIL_REMETENTE.')
  }

  const semSegredos = (mensagem: string) =>
    [chave, ...segredos].reduce((limpa, segredo) => limpa.replaceAll(segredo, '***'), mensagem)

  let resposta: Response
  let corpo: string

  try {
    resposta = await fetch(URL_DA_BREVO, {
      method: 'POST',
      headers: { 'api-key': chave, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: remetente, name: NOME_DO_REMETENTE },
        to: [{ email: para }],
        subject: assunto,
        textContent: texto,
      }),
      // Redirecionamento e erro, nunca seguido: o fetch do Node repassa a api-key, e o corpo com
      // o codigo, a outra origem. A Brevo nao redireciona este POST
      redirect: 'error',
      signal: AbortSignal.timeout(TEMPO_LIMITE_DO_ENVIO_EM_MS),
    })

    // lido sempre, inclusive no sucesso: corpo largado prende a conexao. O tempo limite vale
    // tambem para o corpo que para no meio
    corpo = await resposta.text()
  } catch (erro) {
    const motivo =
      erro instanceof Error && erro.name === 'TimeoutError'
        ? `a API nao respondeu em ${TEMPO_LIMITE_DO_ENVIO_EM_MS / 1000} s`
        : `a chamada a API nao terminou (${descricaoDoErro(erro)})`

    throw new Error(semSegredos(`Envio pela Brevo falhou: ${motivo}.`))
  }

  if (!resposta.ok) {
    throw new Error(
      semSegredos(`Envio pela Brevo recusado: ${resposta.status} ${resumoDoErro(corpo)}`),
    )
  }
}

/**
 * O codigo de acesso. O texto e o mesmo para o primeiro acesso e para a senha esquecida, com
 * conta ou sem: o e-mail nao diz se a conta existe
 */
export async function enviarCodigoDeAcesso(
  email: string,
  codigo: string,
  validadeEmMinutos: number,
): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[acesso] codigo para ${email}: ${codigo}`)
    return
  }

  await enviarPelaBrevo({
    para: email,
    assunto: 'Seu código de acesso ao Nidus',
    texto: [
      'Olá!',
      '',
      `Seu código para definir a senha do Nidus é ${codigo}.`,
      '',
      `Ele vale por ${validadeEmMinutos} minutos e serve uma vez só. Se você não pediu este ` +
        'código, ignore este e-mail: sem ele, ninguém muda a sua senha.',
      '',
      NOME_DO_REMETENTE,
    ].join('\n'),
    segredos: [codigo],
  })
}

/** O horario do aviso, como a pessoa le no relogio dela */
const FUSO_DO_CPMR = 'America/Sao_Paulo'

/**
 * O aviso de que a senha mudou, so para a conta que ja existia. E o que da a quem nao fez a
 * troca um jeito de reagir. Nao leva codigo nenhum
 */
export async function avisarSenhaAlterada(email: string, quando: Date): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    console.log(`[acesso] aviso de senha alterada para ${email}`)
    return
  }

  const dia = quando.toLocaleDateString('pt-BR', { timeZone: FUSO_DO_CPMR })
  const hora = quando.toLocaleTimeString('pt-BR', {
    timeZone: FUSO_DO_CPMR,
    hour: '2-digit',
    minute: '2-digit',
  })

  await enviarPelaBrevo({
    para: email,
    assunto: 'Sua senha do Nidus foi alterada',
    texto: [
      'Olá!',
      '',
      `A senha da sua conta no Nidus foi alterada em ${dia}, às ${hora} (horário de Brasília), ` +
        'com um código enviado para este e-mail. As sessões abertas antes disso foram encerradas.',
      '',
      'Se foi você, não precisa fazer nada.',
      '',
      'Se não foi você, troque a senha deste e-mail e avise a gestão do CPMR o quanto antes.',
      '',
      NOME_DO_REMETENTE,
    ].join('\n'),
  })
}

/** O que o aviso conta do pedido: o mesmo resumo que o pesquisador ve na lista */
export type ResumoDoPedido = {
  id: number
  protocoloCeua: string
  linhagem: string
  machos: number
  femeas: number
  qualquer: number
  idadeMin: number
  idadeMax: number
  /** AAAA-MM-DD */
  dataEntrega: string
}

const plural = (n: number, singular: string, flexao: string) =>
  `${n} ${n === 1 ? singular : flexao}`

/** As linhas do resumo do pedido, so com os grupos de animais que tem quantidade */
function linhasDoResumo(pedido: ResumoDoPedido): string[] {
  const animais = [
    pedido.machos > 0 ? plural(pedido.machos, 'macho', 'machos') : null,
    pedido.femeas > 0 ? plural(pedido.femeas, 'fêmea', 'fêmeas') : null,
    pedido.qualquer > 0 ? `${pedido.qualquer} de qualquer sexo` : null,
  ].filter((parte) => parte !== null)

  const idade =
    pedido.idadeMin === pedido.idadeMax
      ? `${pedido.idadeMin} dias`
      : `de ${pedido.idadeMin} a ${pedido.idadeMax} dias`
  const [ano, mes, dia] = pedido.dataEntrega.split('-')

  return [
    `Protocolo CEUA: ${pedido.protocoloCeua}`,
    `Linhagem: ${pedido.linhagem}`,
    `Animais: ${animais.join(', ')}`,
    `Idade: ${idade}`,
    `Data de entrega: ${dia}/${mes}/${ano}`,
  ]
}

/**
 * O aviso de que o pedido foi aprovado (sem motivo) ou recusado (com o motivo que o tecnico
 * escreveu). Quem pediu nao precisa abrir o Nidus para saber
 */
export async function avisarPedidoDecidido(
  email: string,
  pedido: ResumoDoPedido,
  motivoDaRecusa?: string,
): Promise<void> {
  const aprovado = motivoDaRecusa === undefined

  if (env.NODE_ENV !== 'production') {
    console.log(`[pedido] aviso de pedido ${aprovado ? 'aprovado' : 'recusado'} para ${email}`)
    return
  }

  await enviarPelaBrevo({
    para: email,
    assunto: `Seu pedido #${pedido.id} foi ${aprovado ? 'aprovado' : 'recusado'}`,
    texto: [
      'Olá!',
      '',
      aprovado
        ? `O CPMR aprovou o seu pedido #${pedido.id} de animais.`
        : `O CPMR recusou o seu pedido #${pedido.id} de animais.`,
      '',
      ...(aprovado ? [] : [`Motivo: ${motivoDaRecusa}`, '']),
      ...linhasDoResumo(pedido),
      '',
      `Veja os seus pedidos em ${env.CORS_ORIGEM}/solicitar`,
      '',
      NOME_DO_REMETENTE,
    ].join('\n'),
  })
}
