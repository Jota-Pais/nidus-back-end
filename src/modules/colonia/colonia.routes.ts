import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { dataDoFato, idNaRota, idNoCorpo } from '../../shared/validacao.ts'
import { anularBaixa, registrarBaixa } from './baixa.service.ts'
import { lerVisaoGeral } from './visaoGeral.service.ts'

/**
 * As acoes sobre animais que nao sao de um parto: a baixa em qualquer caixa (montada em
 * /api/caixas, ao lado das rotas de infra) e a anulacao de uma baixa (/api/ocorrencias). E a
 * visao geral da colonia (/api/visao-geral)
 */
export const baixaRoutes = Router()
export const ocorrenciaRoutes = Router()
export const visaoGeralRoutes = Router()

/** GET /api/visao-geral - a colonia por especie e linhagem, so para quem opera a colonia */
visaoGeralRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (_req, res) => {
  res.json(await lerVisaoGeral())
})

const itemDaBaixa = z.object({
  sexo: z.enum(['M', 'F']),
  qtd: z.number().int().positive('Informe quantos animais.').max(999, 'No máximo 999 animais.'),
  dtNascimento: z.iso.date('Data inválida. Use aaaa-mm-dd.').optional(),
  idPedido: idNoCorpo.optional(),
})

/** Corpo de POST /api/caixas/:id/baixa */
export const baixa = z.object({
  dtFato: dataDoFato,
  motivo: z.string().trim().min(1).max(200).optional(),
  itens: z.array(itemDaBaixa).min(1, 'Informe os animais da baixa.').max(20),
})

baixaRoutes.post('/:id/baixa', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = baixa.parse(req.body)

  res.status(201).json(await registrarBaixa(id, dados, usuarioDaRequisicao(req).id))
})

/**
 * Corpo de POST /api/ocorrencias/:id/anulacao. A caixa de cada sexo so quando a caixa da baixa nao
 * serve mais para ele (liberada, com outra ninhada, ou agora de estoque de outro sexo)
 */
export const anulacao = z.object({
  motivo: z.string().trim().min(1, 'Diga por que a baixa foi um engano.').max(200),
  idCaixaMachos: idNoCorpo.optional(),
  idCaixaFemeas: idNoCorpo.optional(),
})

/** Responde para onde voltou cada sexo e quantos voltaram sem a reserva que tinham */
ocorrenciaRoutes.post('/:id/anulacao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = anulacao.parse(req.body)

  res.status(201).json(await anularBaixa(id, dados, usuarioDaRequisicao(req).id))
})
