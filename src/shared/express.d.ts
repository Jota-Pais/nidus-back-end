// `req.usuario` - quem a requisicao e, depois que a autenticacao passou.
//
// Augmentacao global em vez de tipo passado adiante: e como o Express expoe
// dado de request para middleware, e evita `as` em toda rota.
import type { UsuarioDaSessao } from './middlewares/autorizacao.ts'

declare global {
  namespace Express {
    interface Request {
      /**
       * Preenchido pela autenticacao. `undefined` em rota publica e em toda
       * requisicao sem cookie valido - nunca confiar que existe sem passar por
       * `exigirPerfil`.
       */
      usuario?: UsuarioDaSessao
    }
  }
}
