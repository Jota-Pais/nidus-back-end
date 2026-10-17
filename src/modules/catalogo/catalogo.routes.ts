import { Router } from 'express'
import { exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { montarCatalogo } from './catalogo.service.ts'

export const catalogoRoutes = Router()

/**
 * 'GET /api/catalogo' - autenticado, qualquer perfil: o
 * pesquisador tambem precisa de especie e linhagem para montar o pedido.
 */
catalogoRoutes.get('/', exigirPerfil(), async (_req, res) => {
  res.json(await montarCatalogo())
})
