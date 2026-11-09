import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express, type RequestHandler } from 'express'
import { catalogoRoutes } from './modules/catalogo/catalogo.routes.ts'
import { baixaRoutes, ocorrenciaRoutes } from './modules/colonia/colonia.routes.ts'
import { projetoRoutes, solicitacaoRoutes } from './modules/demanda/demanda.routes.ts'
import { caixaRoutes, quadroRoutes } from './modules/infra/caixa.routes.ts'
import { historicoRoutes } from './modules/historico/historico.routes.ts'
import { estanteRoutes } from './modules/infra/infra.routes.ts'
import { salaRoutes } from './modules/infra/sala.routes.ts'
import { autenticacaoPorCookie } from './modules/login/autenticacao.ts'
import { acessoRoutes, sessaoRoutes } from './modules/login/login.routes.ts'
import { buscaRoutes, estoqueRoutes, viabilidadeRoutes } from './modules/motor/motor.routes.ts'
import { casalRoutes, partoRoutes } from './modules/reproducao/reproducao.routes.ts'
import { usuarioRoutes } from './modules/usuarios/usuarios.routes.ts'
import { rotaNaoEncontrada, tratadorDeErros } from './shared/middlewares/erro.ts'

type OpcoesApp = {
  /**
   * origem do front autorizada. Front (Vercel) e API (Render) ficam em dominios
   * diferentes, entao CORS com origem explicita e 'credentials: true' - * e recusado
   * pelo navegador quando ha cookie de sessao.
   */
  corsOrigem?: string
  /** Vai no /saude: desenvolvimento | teste | producao */
  ambiente?: string
  /** vai no /saude: a version do package.json. */
  versao?: string
  /** quem le a sessao e preenche req.usuario - a AUTENTICACAO */
  autenticacao?: RequestHandler
}

/**
 * Monta a aplicacao sem subir servidor. Separado de server.ts para que o
 * teste chame a API em memoria, sem porta e sem .env
 */
export function criarApp({
  corsOrigem = 'http://localhost:5173',
  ambiente = 'desenvolvimento',
  versao = '0.0.0',
  autenticacao = autenticacaoPorCookie,
}: OpcoesApp = {}): Express {
  const app = express()
  app.set('trust proxy', 1)

  app.use(cors({ origin: corsOrigem, credentials: true }))
  app.use(express.json())
  app.use(cookieParser())

  // Healthcheck. Publico e a unica rota fora de /api: e por ele que a Render sabe que a
  // instancia subiu
  app.get('/saude', (_req, res) => {
    res.json({ status: 'ok', ambiente, versao })
  })

  // Daqui para baixo tudo passa pela autenticacao. Ela nunca recusa por conta propria: preenche
  // req.usuario quando ha sessao e segue.
  app.use('/api', autenticacao)

  // Os routers de cada modulo, todos sob /api
  app.use('/api/sessao', sessaoRoutes)
  app.use('/api/acesso', acessoRoutes)
  app.use('/api/catalogo', catalogoRoutes)
  app.use('/api/salas', salaRoutes)
  app.use('/api/estantes', estanteRoutes)
  app.use('/api/casais', casalRoutes)
  app.use('/api/partos', partoRoutes)
  app.use('/api/quadro', quadroRoutes)
  app.use('/api/caixas', caixaRoutes)
  app.use('/api/caixas', baixaRoutes)
  app.use('/api/ocorrencias', ocorrenciaRoutes)
  app.use('/api/projetos', projetoRoutes)
  // antes das solicitacoes, para o '/viabilidade' nao cair numa rota de id
  app.use('/api/solicitacoes/viabilidade', viabilidadeRoutes)
  app.use('/api/solicitacoes', solicitacaoRoutes)
  app.use('/api/busca', buscaRoutes)
  app.use('/api/historico', historicoRoutes)
  app.use('/api/estoque', estoqueRoutes)
  app.use('/api/usuarios', usuarioRoutes)

  app.use(rotaNaoEncontrada)
  app.use(tratadorDeErros)

  return app
}
