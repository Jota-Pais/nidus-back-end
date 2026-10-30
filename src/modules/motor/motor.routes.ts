import { Router } from 'express'
import { z } from 'zod'
import { OPERA_A_COLONIA, exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { buscarAtendimento } from './motor.service.ts'

export const buscaRoutes = Router()

/** query string chega sempre como texto: 'z.coerce' faz a conversao */
export const filtroDaBusca = z
  .object({
    especie: z.string().trim().min(1),
    idLinhagem: z.coerce.number().int().positive().optional(),
    machos: z.coerce.number().int().min(0),
    femeas: z.coerce.number().int().min(0),
    qualquer: z.coerce.number().int().min(0),
    /** a idade exata vem com idadeMin = idadeMax */
    idadeMin: z.coerce.number().int().min(1),
    idadeMax: z.coerce.number().int().min(1),
    dataEntrega: z.iso.date('Data invalida. Use aaaa-mm-dd.').optional(),
    /** ids separados por virgula */
    excluir: z
      .string()
      .optional()
      .transform((ids) => (ids ? ids.split(',').map(Number).filter(Number.isInteger) : [])),
  })
  .refine((filtro) => filtro.idadeMax >= filtro.idadeMin, {
    path: ['idadeMax'],
    error: 'A idade maxima nao pode ser menor que a minima.',
  })

/** GET /api/busca - a busca de atendimento do tecnico */
buscaRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  res.json(await buscarAtendimento(filtroDaBusca.parse(req.query)))
})
