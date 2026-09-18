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
 * A senha mestra ativa, se existir. `login.senha_mestra` nao e requisito do
 * cliente nem tabela do MVP (`docs/modelo-de-dados.md`) - e decisao
 * operacional do time, guardada como hash (nunca texto puro, mesma regra de
 * `usuario.hash_senha`).
 */
async function senhaMestraConfere(senha: string): Promise<boolean> {
  const mestra = await prisma.senhaMestra.findFirst({ where: { ativa: true } })

  return mestra !== null && (await senhaCorresponde(senha, mestra.hashSenha))
}

/**
 * `POST /api/sessao` - autentica e abre sessao.
 *
 * Contrato secao 3: "mesma mensagem para e-mail inexistente e senha errada,
 * sem distinguir os dois" - por isso as recusas (usuario inexistente,
 * inativo, sem senha local, senha errada) caem no mesmo `throw`.
 *
 * `hashSenha` nulo e quem entra so pelo SSO (`RF-ACS-01`/`PEN-09`, mock no
 * semestre) - sem senha local possivel, mesma recusa de credencial invalida,
 * nao um erro diferente que revelaria que o e-mail existe.
 *
 * ⚠️ **Senha mestra - decisao explicita do time, 17/09/2026, cientes do risco.**
 * Se existir uma `senha_mestra` ativa no banco, ela abre sessao pra qualquer
 * conta ATIVA (nao pula a checagem de `ativo`) - suporte e desenvolvimento
 * rapido, "simular o erro de um usuario" sem resetar a senha dele. So
 * consultada quando a senha propria do usuario NAO confere, pra nao pagar
 * uma consulta extra no caminho comum (login com a senha certa). Sem linha
 * ativa na tabela, esse caminho nunca bate - nada de valor padrao no codigo.
 * Cada uso fica um `console.warn` no log; nao e trilha de auditoria de
 * verdade (RF-BI-04, fase 4), so a menor visibilidade possivel sem tabela de
 * evento.
 */
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
