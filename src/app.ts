import cors from 'cors'
import express, { type Express, type RequestHandler } from 'express'
import { catalogoRoutes } from './modules/catalogo/catalogo.routes.ts'
import { estanteRoutes } from './modules/infra/infra.routes.ts'
import { rotaNaoEncontrada, tratadorDeErros } from './shared/middlewares/erro.ts'

type OpcoesApp = {
  /**
   * Origem do front autorizada. Front (Vercel) e API (Render) ficam em dominios
   * diferentes, entao CORS com origem explicita e `credentials: true` - `*` e
   * recusado pelo navegador quando ha cookie de sessao.
   */
  corsOrigem?: string
  /** Vai no /saude: desenvolvimento | teste | producao. */
  ambiente?: string
  /** Vai no /saude: a `version` do package.json. */
  versao?: string
  /**
   * Quem le a sessao e preenche `req.usuario` - a AUTENTICACAO.
   *
   * Entra por parametro, e nao por import, por dois motivos. O primeiro e de
   * desenho: autenticar vai mudar quando o SSO do ID-UFSC entrar (`PEN-09`) e
   * autorizar nao, entao os dois nao devem estar amarrados. O segundo e de
   * teste: e assim que o teste de rota injeta um perfil sem subir cookie,
   * banco nem login.
   *
   * O padrao nao autentica ninguem. Nao e brecha - e o contrario: sem sessao,
   * `exigirPerfil` devolve 401 em toda rota protegida, que e o comportamento
   * correto enquanto `POST /api/sessao` (contrato secao 3) nao existir.
   */
  autenticacao?: RequestHandler
}

/**
 * Monta a aplicacao sem subir servidor. Separado de server.ts para que o teste
 * chame a API em memoria, sem porta e sem .env.
 */
export function criarApp({
  corsOrigem = 'http://localhost:5173',
  ambiente = 'desenvolvimento',
  versao = '0.0.0',
  autenticacao = (_req, _res, next) => next(),
}: OpcoesApp = {}): Express {
  const app = express()

  app.use(cors({ origin: corsOrigem, credentials: true }))
  app.use(express.json())

  // Healthcheck - contrato secao 9. Publico e a unica rota fora de /api: e por
  // ele que a Render sabe que a instancia subiu e o front sabe que ela acordou.
  app.get('/saude', (_req, res) => {
    res.json({ status: 'ok', ambiente, versao })
  })

  // Daqui para baixo tudo passa pela autenticacao. Ela nunca recusa por conta
  // propria: preenche `req.usuario` quando ha sessao e segue. Quem recusa e o
  // `exigirPerfil` de cada rota - `RF-ACS-02`, autorizacao no servidor.
  app.use('/api', autenticacao)

  // Os routers de cada modulo, todos sob /api (contrato secao 1).
  app.use('/api/catalogo', catalogoRoutes)
  app.use('/api/estantes', estanteRoutes)

  app.use(rotaNaoEncontrada)
  app.use(tratadorDeErros)

  return app
}
