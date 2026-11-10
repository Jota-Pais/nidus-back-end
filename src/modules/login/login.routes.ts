import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../env.ts'
import { exigirPerfil, usuarioDaRequisicao } from '../../shared/middlewares/autorizacao.ts'
import { ErroDeAplicacao } from '../../shared/erros.ts'
import { definirSenha, pedirCodigo, verificarCodigo } from './acesso.service.ts'
import { autenticar } from './login.service.ts'
import { NOME_COOKIE, revogarSessao } from './sessao.ts'
import { conferirTentativas, limparFalhas, registrarFalha } from './tentativas.ts'

/** O POST fica fora de 'exigirPerfil', como as rotas de /api/acesso: e como a sessao nasce */
export const sessaoRoutes = Router()

/**
 * 'SameSite=None; Secure' so em produção - em desenvolvimento ('http://') o
 * navegador descarta cookie Secure fora de HTTPS, e o login pararia de
 * funcionar em localhost
 */
const atributosCookie = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
}

const opcoesCookie = {
  ...atributosCookie,
  // 12h, um turno
  maxAge: 12 * 60 * 60_000,
}

/**
 * corpo do POST /api/sessao. O e-mail vai em minusculas: o indice unico de usuario.email
 * diferencia maiusculas, e o e-mail e gravado em minusculas. O front do login ja manda
 * assim, mas nao e a unica porta
 */
export const credenciais = z.object({
  email: z.string().trim().toLowerCase().min(1),
  senha: z.string().min(1),
})

sessaoRoutes.post('/', async (req, res) => {
  const dados = credenciais.parse(req.body)
  const chave = `${req.ip}:${dados.email}`
  conferirTentativas(chave)

  const sessao = await autenticar(dados).catch((erro: unknown) => {
    if (erro instanceof ErroDeAplicacao && erro.status === 401) {
      registrarFalha(chave)
    }
    throw erro
  })

  limparFalhas(chave)
  const { usuario, idSessao } = sessao

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

/**
 * Primeiro acesso e senha esquecida. Tudo fora de 'exigirPerfil', como o POST /api/sessao, e
 * nenhuma resposta e 401: o front le qualquer 401 como "E-mail ou senha incorretos."
 */
export const acessoRoutes = Router()

/** O e-mail de quem pede acesso, de qualquer dominio. O maximo e o da coluna usuario.email */
const emailDeAcesso = z
  .string()
  .trim()
  .toLowerCase()
  .max(160, 'O e-mail passa de 160 caracteres.')
  // E a unica regra do formato: barra 'eu,voce@exemplo.com', que no envio vira uma lista de
  // destinatarios
  .email('E-mail inválido.')

const codigoDeSeisDigitos = z.string().regex(/^\d{6}$/, 'O código tem 6 números.')

const pedidoDeCodigo = z.object({ email: emailDeAcesso })

const codigoParaConferir = z.object({ email: emailDeAcesso, codigo: codigoDeSeisDigitos })

const novaSenha = codigoParaConferir.extend({
  // o mesmo minimo do 'npm run db:senha'
  senha: z.string().min(8, 'A senha precisa de pelo menos 8 caracteres.'),
  // Opcional aqui: o nome so e cobrado da conta nova, e so depois de conferir o codigo. O
  // maximo e o da coluna usuario.nome
  nome: z
    .string()
    .trim()
    .min(1, 'Informe o seu nome.')
    .max(120, 'O nome passa de 120 caracteres.')
    .optional(),
})

acessoRoutes.post('/codigo', async (req, res) => {
  const { email } = pedidoDeCodigo.parse(req.body)

  res.json(await pedirCodigo(email))
})

acessoRoutes.post('/verificacao', async (req, res) => {
  const { email, codigo } = codigoParaConferir.parse(req.body)

  res.json(await verificarCodigo(email, codigo))
})

acessoRoutes.post('/senha', async (req, res) => {
  const { usuario, idSessao } = await definirSenha(novaSenha.parse(req.body))

  // a mesma sessao do login: mesmo cookie, mesmos atributos e o mesmo maxAge
  res.cookie(NOME_COOKIE, idSessao, opcoesCookie)
  res.json({ usuario })
})
