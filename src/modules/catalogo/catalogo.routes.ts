import { Router } from 'express'
import { exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { montarCatalogo } from './catalogo.service.ts'

export const catalogoRoutes = Router()

/**
 * `GET /api/catalogo` - contrato secao 4. Autenticado, **qualquer perfil**:
 * o pesquisador tambem precisa de especie e linhagem para montar o pedido.
 *
 * Sem query, sem paginacao: e uma chamada de boot.
 */
catalogoRoutes.get('/', exigirPerfil(), async (_req, res) => {
  res.json(await montarCatalogo())
})
