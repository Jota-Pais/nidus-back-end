// Sessao: login e senha mestra

import { ErroDeAplicacao } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { perfil as dicPerfil } from '../../shared/traducao.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { senhaCorresponde } from './senha.ts'
import { criarSessao } from './sessao.ts'

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

/** POST /api/sessao - autentica e abre sessao */
export async function autenticar({ email, senha }: Credenciais): Promise<{
  usuario: UsuarioDaSessao
  idSessao: string
}> {
  const usuario = await prisma.usuario.findUnique({ where: { email } })

  if (usuario === null || !usuario.ativo) {
    throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha invalidos.')
  }

  const senhaPropriaConfere =
    usuario.hashSenha !== null && (await senhaCorresponde(senha, usuario.hashSenha))

  if (!senhaPropriaConfere) {
    if (!(await senhaMestraConfere(senha))) {
      throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha invalidos.')
    }

    console.warn(`[senha-mestra] sessao aberta para ${usuario.email} via senha mestra`)
  }

  const usuarioDaSessao = paraUsuarioDaSessao(usuario)
  const idSessao = criarSessao(usuarioDaSessao)

  return { usuario: usuarioDaSessao, idSessao }
}
