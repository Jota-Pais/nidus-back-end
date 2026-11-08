import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { montarQuadro, mudarDePosicao } from './caixa.service.ts'
import { virarCaixaDeEstoque } from './estoque.service.ts'
import { montarFicha } from './ficha.service.ts'

/** /api/quadro e o kanban de uma especie; /api/caixas e a ficha, a posicao e a caixa de estoque */
export const quadroRoutes = Router()
export const caixaRoutes = Router()

const filtroDoQuadro = z.object({
  // um kanban por especie: nao existe "todas as especies"
  especie: z.string().trim().min(1),
})

quadroRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { especie } = filtroDoQuadro.parse(req.query)

  res.json(await montarQuadro(especie))
})

const idNaRota = z.object({ id: z.coerce.number().int().positive().max(2147483647) })

/** GET /api/caixas/:id - a ficha da caixa */
caixaRoutes.get('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await montarFicha(id))
})

const posicaoNova = z.object({
  idEstante: z.number().int().positive().max(2147483647),
  face: z.enum(['frontal', 'traseira']),
  linha: z.number().int().positive().max(2147483647),
  coluna: z.number().int().positive().max(2147483647),
})

caixaRoutes.patch('/:id/posicao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await mudarDePosicao(id, posicaoNova.parse(req.body), usuarioDaRequisicao(req).id))
})

/** POST /api/caixas/:id/estoque - a caixa do casal encerrado vira caixa de estoque no lugar */
caixaRoutes.post('/:id/estoque', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await virarCaixaDeEstoque(id, usuarioDaRequisicao(req).id))
})
