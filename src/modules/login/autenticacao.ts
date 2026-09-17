// A AUTENTICACAO de verdade - quem le o cookie de sessao e preenche
// `req.usuario`. Injetada em `app.ts` no lugar do padrao "ninguem autenticado"
// (ver o comentario la sobre por que o padrao nao e brecha).
//
// Mora no modulo `login`, e nao em `shared/middlewares/`, porque conhece o
// mecanismo de sessao (`sessao.ts`) - `shared/` e para o generico que nao
// depende de nenhum modulo, e o inverso quebraria essa direcao.

import type { RequestHandler } from 'express'
import { NOME_COOKIE, sessaoValida } from './sessao.ts'

/**
 * Nunca recusa por conta propria - sempre chega ao `next()`. Quem recusa e o
 * `exigirPerfil` de cada rota (`RF-ACS-02`); sem essa separacao, uma rota
 * publica como `POST /api/sessao` (criar a primeira sessao) exigiria sessao
 * para existir.
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
