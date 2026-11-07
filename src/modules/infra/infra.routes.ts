import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { LETRAS_DISPONIVEIS, letrasNecessarias } from './endereco.ts'
import {
  alterarEstante,
  cadastrarEstante,
  listarEstantes,
  montarGrade,
  removerEstante,
} from './infra.service.ts'

export const estanteRoutes = Router()

const idNaRota = z.object({
  id: z.coerce.number().int().positive(),
})

/** corpo do cadastro. 'capacidade' nao esta aqui, e por isso o Zod a descarta */
export const estanteNova = z
  .object({
    idSala: z.number().int().positive(),
    fabricante: z.string().trim().min(1).max(60),
    modelo: z.string().trim().min(1).max(60),
    numeroVisivel: z.string().trim().min(1).max(30),
    faces: z.number().int().min(1).max(2),
    linhas: z.number().int().min(1).max(26),
    colunas: z.number().int().min(1).max(26),
  })
  // a topologia tem de caber no alfabeto, senao a grade nao teria letra para as colunas
  .refine((dados) => letrasNecessarias(dados.faces, dados.colunas) <= LETRAS_DISPONIVEIS, {
    path: ['colunas'],
    error: `Faces x colunas nao pode passar de ${LETRAS_DISPONIVEIS} - o endereco ficaria sem letra.`,
  })

/**
 * corpo da edicao: so o numero e a sala. Fabricante, modelo e topologia nao estao aqui e o Zod
 * os descarta - o modelo nao muda depois do cadastro
 */
export const alteracaoDeEstante = z
  .object({
    numeroVisivel: z.string().trim().min(1).max(30).optional(),
    idSala: z.number().int().positive().optional(),
  })
  .refine((dados) => dados.numeroVisivel !== undefined || dados.idSala !== undefined, {
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

/** POST /api/estantes - so o gestor cadastra estante */
estanteRoutes.post('/', exigirPerfil('gestor'), async (req, res) => {
  const dados = estanteNova.parse(req.body)

  res.status(201).json(await cadastrarEstante(dados, usuarioDaRequisicao(req).id))
})

/** PATCH /api/estantes/:id - so o gestor muda o numero e a sala */
estanteRoutes.patch('/:id', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = alteracaoDeEstante.parse(req.body)

  res.json(await alterarEstante(id, dados, usuarioDaRequisicao(req).id))
})

/** DELETE /api/estantes/:id - so o gestor remove, e so a estante vazia */
estanteRoutes.delete('/:id', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  await removerEstante(id, usuarioDaRequisicao(req).id)
  res.status(204).send()
})
