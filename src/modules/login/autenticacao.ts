// Le o cookie de sessao e preenche req.usuario. Injetada em app.ts no
// lugar do padrao "ninguem autenticado".

import type { RequestHandler } from 'express'
import { NOME_COOKIE, sessaoValida } from './sessao.ts'

/**
 * nunca recusa por conta propria - sempre chega ao 'next()'. Quem recusa e o 'exigirPerfil' de
 * cada rota; sem essa separacao, uma rota publica como POST /api/sessao (criar
 * a primeira sessao) exigiria sessao para existir
 */
export const autenticacaoPorCookie: RequestHandler = (req, _res, next) => {
  const idSessao = req.cookies?.[NOME_COOKIE]

  if (typeof idSessao === 'string') {
    const usuario = sessaoValida(idSessao)

    if (usuario !== undefined) {
      req.usuario = usuario
    }
  }

  next()
}
