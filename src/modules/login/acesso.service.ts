// Primeiro acesso e senha esquecida: um codigo vai para o e-mail da UFSC, e com ele a pessoa
// define a senha. E o caminho para ter senha ate o ID-UFSC entrar

import { randomInt } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { enviarCodigoDeAcesso } from '../../shared/email.ts'
import { ErroDeAplicacao, erroDeRegra, muitasTentativas } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { abrirSessao } from './login.service.ts'
import { hashSenha, senhaCorresponde } from './senha.ts'

/** Por quanto tempo o codigo vale */
export const VALIDADE_DO_CODIGO_EM_MINUTOS = 15

/** Quantas vezes um codigo pode ser conferido. O codigo novo comeca do zero */
export const TENTATIVAS_POR_CODIGO = 5

/**
 * Quantos codigos podem ser pedidos, contados nas linhas de login.codigo_acesso. Por e-mail,
 * para ninguem lotar a caixa de outra pessoa. No total, para ficar abaixo da cota do servico
 * de e-mail: sem esse teto, um script que varia o endereco esgota a cota e ninguem mais
 * recebe codigo. O servico ainda nao foi escolhido, entao o teto total e conservador (50 por
 * hora, 200 por dia) e se ajusta aqui quando a cota dele for conhecida
 */
export const LIMITES_DE_PEDIDO = {
  porEmailPorMinuto: 1,
  porEmailPorHora: 5,
  totalPorHora: 50,
  totalPorDia: 200,
}

const MINUTO = 60_000
const HORA = 60 * MINUTO
const DIA = 24 * HORA

const CODIGO_INVALIDO = 'Codigo invalido ou expirado.'
const TENTATIVAS_ESGOTADAS = 'Tentativas esgotadas. Peca um codigo novo.'

/** O mesmo 409 para todo codigo que nao serve, com a mensagem tambem no campo do codigo */
const codigoInvalido = (mensagem = CODIGO_INVALIDO) =>
  erroDeRegra('CODIGO_INVALIDO', mensagem, { campos: { codigo: mensagem } })

/** 6 digitos, com zero a esquerda: 000042 e um codigo como outro qualquer */
export function novoCodigo(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/**
 * 429 no primeiro limite que o pedido estoura. Roda antes de qualquer gravacao: uma vez so
 * lendo, sem trava, e de novo dentro da transacao
 */
async function conferirLimites(tx: Prisma.TransactionClient, email: string, agora: Date) {
  const desde = (intervalo: number) => ({ gt: new Date(agora.getTime() - intervalo) })
  const doTotal = 'Muitos codigos pedidos agora. Tente de novo mais tarde.'

  const limites = [
    {
      onde: { email, dtCriacao: desde(MINUTO) },
      maximo: LIMITES_DE_PEDIDO.porEmailPorMinuto,
      mensagem: 'Aguarde um minuto para pedir outro codigo.',
    },
    {
      onde: { email, dtCriacao: desde(HORA) },
      maximo: LIMITES_DE_PEDIDO.porEmailPorHora,
      mensagem: `Voce ja pediu ${LIMITES_DE_PEDIDO.porEmailPorHora} codigos na ultima hora. Tente de novo mais tarde.`,
    },
    { onde: { dtCriacao: desde(HORA) }, maximo: LIMITES_DE_PEDIDO.totalPorHora, mensagem: doTotal },
    { onde: { dtCriacao: desde(DIA) }, maximo: LIMITES_DE_PEDIDO.totalPorDia, mensagem: doTotal },
  ]

  for (const { onde, maximo, mensagem } of limites) {
    if ((await tx.codigoAcesso.count({ where: onde })) >= maximo) {
      throw muitasTentativas(mensagem)
    }
  }
}

/**
 * POST /api/acesso/codigo. A resposta e a mesma com conta, sem conta e com conta inativa, no
 * 429 inclusive: a conta inativa ganha a linha dela, com o hash de um codigo que ninguem
 * recebe, e por isso conta nos limites como as outras
 */
export async function pedirCodigo(
  email: string,
  agora = new Date(),
): Promise<{ validadeEmMinutos: number }> {
  // Primeiro so lendo, sem trava: o pedido que ja estoura um limite volta 429 antes do hash do
  // codigo, que e a parte cara (bcrypt). Sem isso, um script martelando a rota gasta a CPU do
  // servidor mesmo levando 429, e a cada pedido pega uma conexao para a fila da trava
  await conferirLimites(prisma, email, agora)

  const codigo = novoCodigo()
  const [usuario, hashCodigo] = await Promise.all([
    prisma.usuario.findUnique({ where: { email } }),
    hashSenha(codigo),
  ])

  await prisma.$transaction(async (tx) => {
    // Um pedido de cada vez daqui ate o commit: sem a fila, dois pedidos em paralelo contam as
    // mesmas linhas e passam juntos do limite, e por isso os limites sao conferidos de novo
    // aqui dentro. A trava e da transacao (sai no commit) e por isso funciona atras do pooler
    // da Neon. Pedido de codigo e raro, e a fila dura so as contagens e a gravacao
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('login.codigo_acesso'))`
    await conferirLimites(tx, email, agora)

    // O codigo anterior do e-mail deixa de valer. A linha fica, marcada: os limites contam por ela
    await tx.codigoAcesso.updateMany({ where: { email, usadoEm: null }, data: { usadoEm: agora } })
    await tx.codigoAcesso.create({
      data: {
        email,
        hashCodigo,
        expiraEm: new Date(agora.getTime() + VALIDADE_DO_CODIGO_EM_MINUTOS * MINUTO),
      },
    })
  })

  // Sem 'await': o envio nao segura a resposta. Assim quem recebe o e-mail e a conta inativa,
  // que nao recebe, esperam o mesmo tempo, e uma falha do servico de e-mail fica so no log
  if (usuario === null || usuario.ativo) {
    enviarCodigoDeAcesso(email, codigo).catch((erro: unknown) => {
      console.error(`[acesso] o codigo para ${email} nao foi enviado:`, erro)
    })
  }

  return { validadeEmMinutos: VALIDADE_DO_CODIGO_EM_MINUTOS }
}

/**
 * A mensagem do 409 vem da linha relida depois da recusa, nao da lida antes da reserva: no
 * meio, outra tentativa em paralelo pode ter gastado a ultima, ou um codigo novo pode ter
 * tomado o lugar deste. "Esgotadas" e so o codigo que ainda valeria e ficou sem tentativa,
 * contando a que acabou de errar
 */
async function mensagemDaRecusa(id: number, agora: Date) {
  const linha = await prisma.codigoAcesso.findUnique({ where: { id } })
  const esgotado =
    linha !== null &&
    linha.usadoEm === null &&
    linha.expiraEm > agora &&
    linha.tentativas >= TENTATIVAS_POR_CODIGO

  return esgotado ? TENTATIVAS_ESGOTADAS : CODIGO_INVALIDO
}

/**
 * Confere o codigo vigente do e-mail sem gasta-lo e devolve o usuario, null quando a conta
 * ainda nao existe. Codigo errado, vencido, ja usado, inexistente ou de conta inativa dao o
 * mesmo 409, e a conta so e lida depois do acerto
 */
async function conferirCodigo(email: string, codigo: string, agora: Date) {
  const vigente = await prisma.codigoAcesso.findFirst({ where: { email }, orderBy: { id: 'desc' } })

  if (vigente === null) {
    throw codigoInvalido()
  }

  // A tentativa e reservada antes de comparar, num update so com a condicao no 'where':
  // requisicoes em paralelo leem o mesmo 'tentativas' antes do primeiro incremento, e so o
  // banco poe uma depois da outra
  const reserva = await prisma.codigoAcesso.updateMany({
    where: {
      id: vigente.id,
      usadoEm: null,
      expiraEm: { gt: agora },
      tentativas: { lt: TENTATIVAS_POR_CODIGO },
    },
    data: { tentativas: { increment: 1 } },
  })

  if (reserva.count !== 1) {
    throw codigoInvalido(await mensagemDaRecusa(vigente.id, agora))
  }

  if (!(await senhaCorresponde(codigo, vigente.hashCodigo))) {
    // a ultima tentativa ja avisa, para a pessoa nao gastar mais uma a toa
    throw codigoInvalido(await mensagemDaRecusa(vigente.id, agora))
  }

  // O acerto devolve a tentativa: a verificacao e a senha nova conferem o mesmo codigo, e
  // acertar nao pode gastar duas das cinco
  await prisma.codigoAcesso.updateMany({
    where: { id: vigente.id, tentativas: { gt: 0 } },
    data: { tentativas: { decrement: 1 } },
  })

  const usuario = await prisma.usuario.findUnique({ where: { email } })

  // O codigo da conta inativa nunca sai, mas a conta pode ter sido desativada depois do envio
  if (usuario !== null && !usuario.ativo) {
    throw codigoInvalido()
  }

  return { idCodigo: vigente.id, usuario }
}

/**
 * POST /api/acesso/verificacao. So aqui, com o codigo provado, a API diz se a conta existe:
 * 'novo' e nao ter usuario com o e-mail
 */
export async function verificarCodigo(
  email: string,
  codigo: string,
  agora = new Date(),
): Promise<{ novo: boolean }> {
  const { usuario } = await conferirCodigo(email, codigo, agora)

  return { novo: usuario === null }
}

/** Gasta o codigo, dentro da transacao da senha: com o mesmo codigo em paralelo, so uma passa */
async function gastarCodigo(tx: Prisma.TransactionClient, id: number, agora: Date) {
  const { count } = await tx.codigoAcesso.updateMany({
    where: { id, usadoEm: null },
    data: { usadoEm: agora },
  })

  if (count !== 1) {
    throw codigoInvalido()
  }
}

export type NovaSenha = {
  email: string
  codigo: string
  senha: string
  /** So da conta nova. Quem ja tem conta mantem o nome */
  nome?: string | undefined
}

/**
 * POST /api/acesso/senha - grava a senha e abre a sessao, como o login. O codigo e conferido
 * antes de qualquer coisa que dependa da conta: se o nome fosse cobrado antes, a rota diria
 * quem tem conta sem codigo nenhum
 */
export async function definirSenha(
  { email, codigo, senha, nome }: NovaSenha,
  agora = new Date(),
): Promise<{ usuario: UsuarioDaSessao; idSessao: string }> {
  const { idCodigo, usuario } = await conferirCodigo(email, codigo, agora)

  if (usuario === null) {
    // sem gastar o codigo: a tentativa ja voltou, e a pessoa so completa o formulario
    if (nome === undefined) {
      throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
        campos: { nome: 'Informe o seu nome.' },
      })
    }

    const hash = await hashSenha(senha)
    const criado = await prisma.$transaction(async (tx) => {
      await gastarCodigo(tx, idCodigo, agora)

      // So pesquisador. Gestao de usuarios e do gestor (spec do cliente, secao 1.10): tecnico
      // e gestor nunca nascem por esta rota
      return tx.usuario.create({ data: { nome, email, perfil: 'P', hashSenha: hash, ativo: true } })
    })

    return abrirSessao(criado)
  }

  const hash = await hashSenha(senha)
  await prisma.$transaction(async (tx) => {
    await gastarCodigo(tx, idCodigo, agora)

    // Conta que ja existe troca so a senha: perfil e nome ficam. O 'ativo' no 'where' segura a
    // conta desativada entre a conferencia e a gravacao
    const { count } = await tx.usuario.updateMany({
      where: { id: usuario.id, ativo: true },
      data: { hashSenha: hash },
    })

    if (count !== 1) {
      throw codigoInvalido()
    }
  })

  return abrirSessao(usuario)
}
