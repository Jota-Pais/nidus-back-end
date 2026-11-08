import { Router } from 'express'
import { z } from 'zod'
import { exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { listarHistorico } from './historico.service.ts'

export const historicoRoutes = Router()

const filtro = z.object({
  entidade: z.string().trim().min(1).max(20).optional(),
  idEntidade: z.coerce.number().int().positive().max(2147483647).optional(),
  busca: z.string().trim().min(1).max(100).optional(),
  limite: z.coerce.number().int().min(1).max(500).default(100),
})

historicoRoutes.get('/', exigirPerfil('gestor'), async (req, res) => {
  res.json(await listarHistorico(filtro.parse(req.query)))
})
