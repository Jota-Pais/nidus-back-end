import { Router } from 'express'
import { z } from 'zod'
import { OPERA_A_COLONIA, exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { pedidoNovo } from '../demanda/demanda.routes.ts'
import { buscarAtendimento } from './motor.service.ts'
import { avaliarViabilidade } from './viabilidade.service.ts'

export const buscaRoutes = Router()
export const viabilidadeRoutes = Router()

/** query string chega sempre como texto: 'z.coerce' faz a conversao */
export const filtroDaBusca = z
  .object({
    especie: z.string().trim().min(1),
    idLinhagem: z.coerce.number().int().positive().max(2147483647),
    machos: z.coerce.number().int().min(0).max(9999),
    femeas: z.coerce.number().int().min(0).max(9999),
    qualquer: z.coerce.number().int().min(0).max(9999),
    /** a idade exata vem com idadeMin = idadeMax */
    idadeMin: z.coerce.number().int().min(1).max(300),
    idadeMax: z.coerce.number().int().min(1).max(300),
    dataEntrega: z.iso.date('Data inválida. Use aaaa-mm-dd.').optional(),
  })
  .refine((filtro) => filtro.idadeMax >= filtro.idadeMin, {
    path: ['idadeMax'],
    error: 'A idade máxima não pode ser menor que a mínima.',
  })

/** GET /api/busca - a busca de atendimento do tecnico */
buscaRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  res.json(await buscarAtendimento(filtroDaBusca.parse(req.query)))
})

/**
 * POST /api/pedidos/viabilidade - quem pede confere, antes de enviar, se o CPMR consegue
 * atender. O corpo e o mesmo do pedido; a resposta e so o veredito, sem numero de estoque
 */
viabilidadeRoutes.post('/', exigirPerfil(), async (req, res) => {
  res.json(await avaliarViabilidade(pedidoNovo.parse(req.body)))
})
