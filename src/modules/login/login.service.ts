// Secao 3 do contrato: sessao. `RF-ACS-01`.

import { env } from '../../env.ts'
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
 * sem distinguir os dois" - por isso as recusas (usuario inexistente,
 * inativo, sem senha local, senha errada) caem no mesmo `throw`.
 *
 * `hashSenha` nulo e quem entra so pelo SSO (`RF-ACS-01`/`PEN-09`, mock no
 * semestre) - sem senha local possivel, mesma recusa de credencial invalida,
 * nao um erro diferente que revelaria que o e-mail existe.
 *
 * ⚠️ **Senha mestra - decisao explicita do time, 17/09/2026, cientes do risco.**
 * Com `SENHA_MESTRA` definida no ambiente, ela abre sessao pra qualquer conta
 * ATIVA (nao pula a checagem de `ativo`), pra suporte e desenvolvimento
 * rapido - "simular o erro de um usuario" sem precisar resetar a senha dele.
 * Sem a variavel definida (producao, se o time decidir nao usar la), este
 * caminho nunca bate: nao ha valor padrao no codigo, de proposito - o valor
 * so existe no `.env` de cada ambiente, nunca no git. Cada uso fica um
 * `console.warn` no log do servidor; nao e trilha de auditoria de verdade
 * (isso e RF-BI-04, fase 4), so a menor visibilidade que da pra ter sem
 * tabela nova.
 */
export async function autenticar({ email, senha }: Credenciais): Promise<{
  usuario: UsuarioDaSessao
  idSessao: string
}> {
  const usuario = await prisma.usuario.findUnique({ where: { email } })

  if (usuario === null || !usuario.ativo) {
    throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha invalidos.')
  }

  const viaSenhaMestra = env.SENHA_MESTRA !== undefined && senha === env.SENHA_MESTRA

  if (!viaSenhaMestra) {
    const confere = usuario.hashSenha !== null && (await senhaCorresponde(senha, usuario.hashSenha))

    if (!confere) {
      throw new ErroDeAplicacao(401, 'NAO_AUTENTICADO', 'E-mail ou senha invalidos.')
    }
  } else {
    console.warn(`[senha-mestra] sessao aberta para ${usuario.email} via senha mestra`)
  }

  const usuarioDaSessao = paraUsuarioDaSessao(usuario)
  const idSessao = criarSessao(usuarioDaSessao)

  return { usuario: usuarioDaSessao, idSessao }
}
