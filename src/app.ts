import cors from 'cors'
import express, { type Express } from 'express'
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
}

/**
 * Monta a aplicacao sem subir servidor. Separado de server.ts para que o teste
 * chame a API em memoria, sem porta e sem .env.
 */
export function criarApp({
  corsOrigem = 'http://localhost:5173',
  ambiente = 'desenvolvimento',
  versao = '0.0.0',
}: OpcoesApp = {}): Express {
  const app = express()

  app.use(cors({ origin: corsOrigem, credentials: true }))
  app.use(express.json())

  // Healthcheck - contrato secao 9. Publico e a unica rota fora de /api: e por
  // ele que a Render sabe que a instancia subiu e o front sabe que ela acordou.
  app.get('/saude', (_req, res) => {
    res.json({ status: 'ok', ambiente, versao })
  })

  // Os routers de cada modulo entram aqui, todos sob /api (contrato secao 1):
  //
  //   app.use('/api/estantes', estanteRoutes)
  //   app.use('/api/casais', casalRoutes)

  app.use(rotaNaoEncontrada)
  app.use(tratadorDeErros)

  return app
}
