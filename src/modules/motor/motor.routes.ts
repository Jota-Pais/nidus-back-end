import { Router } from 'express'
import { z } from 'zod'
import { OPERA_A_COLONIA, exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { consultarEstoque } from './estoque.service.ts'
import { buscarAtendimento } from './motor.service.ts'

export const buscaRoutes = Router()
export const estoqueRoutes = Router()

/** query string chega sempre como texto: 'z.coerce' faz a conversao */
export const filtroDaBusca = z.object({
  especie: z.string().trim().min(1),
  idLinhagem: z.coerce.number().int().positive().optional(),
  machos: z.coerce.number().int().min(0),
  femeas: z.coerce.number().int().min(0),
  idade: z.coerce.number().int().min(1),
  dataEntrega: z.iso.date('Data invalida. Use aaaa-mm-dd.').optional(),
  /** ids separados por virgula */
  excluir: z
    .string()
    .optional()
    .transform((ids) => (ids ? ids.split(',').map(Number).filter(Number.isInteger) : [])),
})

/** GET /api/busca - a busca de atendimento do tecnico */
buscaRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  res.json(await buscarAtendimento(filtroDaBusca.parse(req.query)))
})

const filtroDoEstoque = z.object({ especie: z.string().trim().min(1) })

estoqueRoutes.get('/', exigirPerfil(), async (req, res) => {
  res.json(await consultarEstoque(filtroDoEstoque.parse(req.query).especie))
})
