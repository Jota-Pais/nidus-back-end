import { Router } from 'express'
import { z } from 'zod'
import { OPERA_A_COLONIA, exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { solicitacaoNova } from '../demanda/demanda.routes.ts'
import { consultarEstoque } from './estoque.service.ts'
import { buscarAtendimento } from './motor.service.ts'
import { avaliarViabilidade } from './viabilidade.service.ts'

export const buscaRoutes = Router()
export const estoqueRoutes = Router()
export const viabilidadeRoutes = Router()

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

const filtroDoEstoque = z.object({ especie: z.string().trim().min(1) })

/** GET /api/estoque - o que a colonia tem livre, so para quem opera a colonia */
estoqueRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  res.json(await consultarEstoque(filtroDoEstoque.parse(req.query).especie))
})

/**
 * POST /api/solicitacoes/viabilidade - quem pede confere, antes de enviar, se o CPMR consegue
 * atender. O corpo e o mesmo do pedido; a resposta e so o veredito, sem numero de estoque
 */
viabilidadeRoutes.post('/', exigirPerfil(), async (req, res) => {
  res.json(await avaliarViabilidade(solicitacaoNova.parse(req.body)))
})
