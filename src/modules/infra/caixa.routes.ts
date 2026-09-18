import { Router } from 'express'
import { z } from 'zod'
import { OPERA_A_COLONIA, exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { montarQuadro, moverCaixa } from './caixa.service.ts'
import { montarFicha } from './ficha.service.ts'

/**
 * Contrato secoes 6 e 8. Dois routers: `/api/quadro` (sem `:id` - a espécie
 * segrega, nao a caixa) e `/api/caixas` (a ficha e a transicao de uma caixa).
 */
export const quadroRoutes = Router()
export const caixaRoutes = Router()

const filtroDoQuadro = z.object({
  // `RF-CIC-01`: especie e obrigatoria, e a segregacao e do servidor - nao ha
  // "todas as especies" no quadro.
  especie: z.string().trim().min(1),
})

quadroRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { especie } = filtroDoQuadro.parse(req.query)

  res.json(await montarQuadro(especie))
})

const idNaRota = z.object({ id: z.coerce.number().int().positive() })

/** `GET /api/caixas/:id` - a ficha completa. `RF-INF-04` + `RF-REP-02`. */
caixaRoutes.get('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await montarFicha(id))
})

const estadoTermo = z.enum([
  'em_reproducao',
  'parcialmente_comprometida',
  'totalmente_comprometida',
  'preparada_para_envio',
  'expedida',
])

/** `confirmar` sem default: o front sempre manda o campo (contrato secao 8). */
const transicao = z.object({
  estado: estadoTermo,
  justificativa: z.string().trim().min(1).max(200).nullable(),
  confirmar: z.boolean(),
})

caixaRoutes.patch('/:id/estado', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = transicao.parse(req.body)

  res.json(await moverCaixa(id, dados))
})
