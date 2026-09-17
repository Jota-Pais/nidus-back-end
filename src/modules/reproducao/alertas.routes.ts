import { Router } from 'express'
import { z } from 'zod'
import { OPERA_A_COLONIA, exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { montarAlertas } from './alertas.service.ts'

/** Contrato secao 8 - `RF-REP-07`. */
export const alertasRoutes = Router()

const filtro = z.object({
  especie: z.string().trim().min(1).optional(),
  // Janela de antecedencia; nao ha teto no requisito, mas 90 dias cobre
  // qualquer uso razoavel do painel e evita varrer a colonia toda por engano.
  dias: z.coerce.number().int().min(1).max(90).optional(),
})

alertasRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { especie, dias } = filtro.parse(req.query)

  res.json(await montarAlertas({ codigoEspecie: especie, dias }))
})
