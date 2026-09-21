import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../env.ts'
import { exigirPerfil, usuarioDaRequisicao } from '../../shared/middlewares/autorizacao.ts'
import { autenticar } from './login.service.ts'
import { NOME_COOKIE, revogarSessao } from './sessao.ts'

/** Contrato secao 3. So esta rota fica fora de 'exigirPerfil': e como a sessao nasce */
export const sessaoRoutes = Router()

/**
 * 'SameSite=None; Secure' so em produção - em desenvolvimento ('http://') o
 * navegador descarta cookie Secure fora de HTTPS, e o login pararia de
 * funcionar em localhost (decisoes-de-stack.md §2.1, "o detalhe que morde")
 */
const atributosCookie = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
}

const opcoesCookie = {
  ...atributosCookie,
  // 12h, um turno - o contrato nao fixa duracao, so o mecanismo (secao 1.2)
  maxAge: 12 * 60 * 60_000,
}

const credenciais = z.object({
  email: z.string().trim().min(1),
  senha: z.string().min(1),
})

sessaoRoutes.post('/', async (req, res) => {
  const dados = credenciais.parse(req.body)
  const { usuario, idSessao } = await autenticar(dados)

  res.cookie(NOME_COOKIE, idSessao, opcoesCookie)
  res.json({ usuario })
})

/** Autenticado, qualquer perfil - 'exigirPerfil()' sem lista exige so a sessao. */
sessaoRoutes.get('/', exigirPerfil(), (req, res) => {
  res.json({ usuario: usuarioDaRequisicao(req) })
})

sessaoRoutes.delete('/', exigirPerfil(), (req, res) => {
  const idSessao = req.cookies?.[NOME_COOKIE]

  if (typeof idSessao === 'string') {
    revogarSessao(idSessao)
  }

  // O navegador so apaga o cookie se os atributos do Set-Cookie de remocao forem os mesmos do
  // que o criou (fora expires/maxAge). Em producao isso inclui Secure; SameSite=None: sem
  // eles, o Chrome descarta a remocao vinda de resposta cross-site e o cookie morto fica no
  // navegador
  res.clearCookie(NOME_COOKIE, atributosCookie)
  res.status(204).send()
})
