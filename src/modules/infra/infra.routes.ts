import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { idNoCorpo } from '../../shared/validacao.ts'
import {
  alterarEstante,
  cadastrarEstante,
  listarEstantes,
  montarGrade,
  removerEstante,
} from './infra.service.ts'

export const estanteRoutes = Router()

const idNaRota = z.object({
  id: z.coerce.number().int().positive().max(2147483647),
})

/**
 * corpo do cadastro: a sala, o formato e o numero da etiqueta. As medidas sao as do formato:
 * fabricante, modelo, medidas e capacidade nao estao aqui, e o Zod os descarta
 */
export const estanteNova = z.object({
  idSala: idNoCorpo,
  idFormato: idNoCorpo,
  numeroVisivel: z.string().trim().min(1).max(30),
})

/** corpo da edicao: o numero, a sala e o formato, ao menos um */
export const alteracaoDeEstante = z
  .object({
    numeroVisivel: z.string().trim().min(1).max(30).optional(),
    idSala: idNoCorpo.optional(),
    idFormato: idNoCorpo.optional(),
  })
  .refine((dados) => dados.numeroVisivel !== undefined || dados.idSala !== undefined || dados.idFormato !== undefined, {
    path: ['numeroVisivel'],
    error: 'Informe o que alterar.',
  })

estanteRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (_req, res) => {
  res.json(await listarEstantes())
})

estanteRoutes.get('/:id/grade', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await montarGrade(id))
})

/** POST /api/estantes - quem opera a colonia cadastra estante */
estanteRoutes.post('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const dados = estanteNova.parse(req.body)

  res.status(201).json(await cadastrarEstante(dados, usuarioDaRequisicao(req).id))
})

/** PATCH /api/estantes/:id - o numero, a sala e o formato */
estanteRoutes.patch('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = alteracaoDeEstante.parse(req.body)

  res.json(await alterarEstante(id, dados, usuarioDaRequisicao(req).id))
})

/** DELETE /api/estantes/:id - so a estante vazia */
estanteRoutes.delete('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  await removerEstante(id, usuarioDaRequisicao(req).id)
  res.status(204).send()
})
