// Sessao: login e senha mestra

import { ErroDeAplicacao } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { perfil as dicPerfil } from '../../shared/traducao.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { hashSenha, senhaCorresponde } from './senha.ts'
import { criarSessao, novaMarca, revogadasDesde } from './sessao.ts'

export type Credenciais = {
  email: string
  senha: string
}

function paraUsuarioDaSessao(usuario: {
  id: number
  nome: string
  email: string
  perfil: string
}): UsuarioDaSessao {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil: dicPerfil.paraApi(usuario.perfil),
  }
}

/**
 * A senha mestra ativa, se existir. login.senha_mestra nao e requisito do cliente - e
 * decisao operacional do time, guardada como hash (nunca texto puro, mesma regra de
 * usuario.hash_senha)
 */
async function senhaMestraConfere(senha: string): Promise<boolean> {
  const mestra = await prisma.senhaMestra.findFirst({ where: { ativa: true } })

  return mestra !== null && (await senhaCorresponde(senha, mestra.hashSenha))
}

const hashSemUsuario = hashSenha(crypto.randomUUID())

/** POST /api/sessao - autentica e abre sessao */
export async function autenticar({ email, senha }: Credenciais): Promise<{
  usuario: UsuarioDaSessao
  idSessao: string
}> {
  // marcado antes de ler a senha: ver o fim da funcao
  const inicio = novaMarca()
  const usuario = await prisma.usuario.findUnique({ where: { email } })

  if (usuario === null || !usuario.ativo) {
    await senhaCorresponde(senha, await hashSemUsuario)
    throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha inválidos.')
  }

  const senhaPropriaConfere =
    usuario.hashSenha !== null && (await senhaCorresponde(senha, usuario.hashSenha))

  if (!senhaPropriaConfere) {
    if (!(await senhaMestraConfere(senha))) {
      throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha inválidos.')
    }

    console.warn(`[senha-mestra] sessao aberta para ${usuario.email} via senha mestra`)
  }

  // A senha foi lida no comeco, e o bcrypt leva segundos. Se nesse meio tempo ela mudou pela
  // senha esquecida, o que conferiu aqui pode ser a senha antiga, e esta sessao nasceria depois
  // da revogacao das outras, a salvo dela. Recusa como senha errada: a senha certa agora e outra.
  // Se o bcrypt terminar antes da revogacao, a sessao nasce antes dela e cai junto com as outras
  if (revogadasDesde(usuario.id, inicio)) {
    throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha inválidos.')
  }

  return abrirSessao(usuario)
}

/**
 * Abre a sessao de quem ja provou quem e. O login e o primeiro acesso terminam aqui, para a
 * sessao sair igual nos dois: mesmo usuario da sessao e mesmo ID no cookie
 */
export function abrirSessao(usuario: Parameters<typeof paraUsuarioDaSessao>[0]): {
  usuario: UsuarioDaSessao
  idSessao: string
} {
  const usuarioDaSessao = paraUsuarioDaSessao(usuario)

  return { usuario: usuarioDaSessao, idSessao: criarSessao(usuarioDaSessao) }
}
