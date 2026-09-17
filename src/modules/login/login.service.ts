// Secao 3 do contrato: sessao. `RF-ACS-01`.

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
 * `POST /api/sessao` - autentica e abre sessao.
 *
 * Contrato secao 3: "mesma mensagem para e-mail inexistente e senha errada,
 * sem distinguir os dois" - por isso as tres recusas (usuario inexistente,
 * inativo, sem senha local) e a senha errada caem no mesmo `throw`.
 *
 * `hashSenha` nulo e quem entra so pelo SSO (`RF-ACS-01`/`PEN-09`, mock no
 * semestre) - sem senha local possivel, mesma recusa de credencial invalida,
 * nao um erro diferente que revelaria que o e-mail existe.
 */
export async function autenticar({ email, senha }: Credenciais): Promise<{
  usuario: UsuarioDaSessao
  idSessao: string
}> {
  const usuario = await prisma.usuario.findUnique({ where: { email } })

  if (usuario === null || !usuario.ativo || usuario.hashSenha === null) {
    throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha invalidos.')
  }

  const confere = await senhaCorresponde(senha, usuario.hashSenha)

  if (!confere) {
    throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha invalidos.')
  }

  const usuarioDaSessao = paraUsuarioDaSessao(usuario)
  const idSessao = criarSessao(usuarioDaSessao)

  return { usuario: usuarioDaSessao, idSessao }
}
