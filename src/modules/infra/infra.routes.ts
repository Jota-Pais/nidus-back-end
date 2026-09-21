import { Router } from 'express'
import { z } from 'zod'
import { OPERA_A_COLONIA, exigirPerfil } from '../../shared/middlewares/autorizacao.ts'
import { LETRAS_DISPONIVEIS, letrasNecessarias } from './endereco.ts'
import { cadastrarEstante, listarEstantes, montarGrade } from './infra.service.ts'

export const estanteRoutes = Router()

/**
 * Query param chega sempre como string (decisao de stack 1.1) - 'z.coerce' e nunca 'Number()'
 * a mao
 */
const filtroDaLista = z.object({
  sala: z.string().trim().min(1).optional(),
  especie: z.string().trim().min(1).optional(),
})

const idNaRota = z.object({
  id: z.coerce.number().int().positive(),
})

/**
 * corpo do cadastro. Exportado para o teste conferir a forma sem subir rota nem tocar o banco -
 * 'capacidade' nao esta aqui, e por isso o Zod a descarta
 */
export const estanteNova = z
  .object({
    sala: z.string().trim().min(1).max(60),
    fabricante: z.string().trim().min(1).max(60),
    modelo: z.string().trim().min(1).max(60),
    numeroVisivel: z.string().trim().min(1).max(30),
    faces: z.number().int().min(1).max(2),
    linhas: z.number().int().min(1).max(26),
    colunas: z.number().int().min(1).max(26),
  })
  // Regra entre campos, que e o que cabe ao Zod: a topologia tem de caber
  // no alfabeto, senao a grade nao teria endereco para gerar (RF-INF-02)
  // Recusar no cadastro e melhor que estourar na primeira leitura da grade.
  .refine((dados) => letrasNecessarias(dados.faces, dados.colunas) <= LETRAS_DISPONIVEIS, {
    path: ['colunas'],
    error: `Faces x colunas nao pode passar de ${LETRAS_DISPONIVEIS} - o endereco ficaria sem letra.`,
  })

/** 'GET /api/estantes' - lista com ocupacao (RF-INF-06) */
estanteRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  res.json(await listarEstantes(filtroDaLista.parse(req.query)))
})

/**
 * GET /api/estantes/:id/grade - as duas faces, o endpoint central do
 * RF-INF-03. Posicoes vazias vem com 'caixa: null'; o front nao gera
 * grade
 */
estanteRoutes.get('/:id/grade', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await montarGrade(id))
})

/** POST /api/estantes - cadastro. Gestor. */
estanteRoutes.post('/', exigirPerfil('gestor'), async (req, res) => {
  const dados = estanteNova.parse(req.body)

  res.status(201).json(await cadastrarEstante(dados))
})
