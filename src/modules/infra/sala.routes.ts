import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { criarSala, listarSalas, removerSala, renomearSala } from './sala.service.ts'

export const salaRoutes = Router()

const idNaRota = z.object({ id: z.coerce.number().int().positive().max(2147483647) })

/** corpo do cadastro e da renomeacao: a sala so tem o nome */
export const salaNova = z.object({
  nome: z.string().trim().min(1).max(60),
})

salaRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (_req, res) => {
  res.json(await listarSalas())
})

/** Cadastrar, renomear e remover sala e so do gestor */
salaRoutes.post('/', exigirPerfil('gestor'), async (req, res) => {
  const dados = salaNova.parse(req.body)

  res.status(201).json(await criarSala(dados, usuarioDaRequisicao(req).id))
})

salaRoutes.patch('/:id', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = salaNova.parse(req.body)

  res.json(await renomearSala(id, dados, usuarioDaRequisicao(req).id))
})

salaRoutes.delete('/:id', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  await removerSala(id, usuarioDaRequisicao(req).id)
  res.status(204).send()
})
