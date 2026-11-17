import { Router } from 'express'
import { z } from 'zod'
import { exigirPerfil, usuarioDaRequisicao } from '../../shared/middlewares/autorizacao.ts'
import { alterarLinhagem, criarLinhagem } from '../demanda/projeto.service.ts'
import { montarCatalogo } from './catalogo.service.ts'

export const catalogoRoutes = Router()

/**
 * 'GET /api/catalogo' - autenticado, qualquer perfil: o
 * pesquisador tambem precisa de especie e linhagem para montar o pedido.
 */
catalogoRoutes.get('/', exigirPerfil(), async (_req, res) => {
  res.json(await montarCatalogo())
})

const idNaRota = z.object({ id: z.coerce.number().int().positive().max(2147483647) })

/** Como se cruzam as famílias A-E: rodízio, mesma letra ou, nulo, sem regra (sem aviso) */
const cruzamento = z.enum(['rodizio', 'mesma_letra']).nullable()

export const linhagemNova = z.object({
  idEspecie: z.number().int().positive().max(2147483647),
  nome: z.string().trim().min(1).max(60),
  cruzamento: cruzamento.optional(),
})

const alteracaoDeLinhagem = z
  .object({
    nome: z.string().trim().min(1).max(60).optional(),
    ativa: z.boolean().optional(),
    cruzamento: cruzamento.optional(),
  })
  .refine(
    (dados) =>
      dados.nome !== undefined || dados.ativa !== undefined || dados.cruzamento !== undefined,
    { path: ['nome'], error: 'Informe o que alterar.' },
  )

catalogoRoutes.post('/linhagens', exigirPerfil('gestor'), async (req, res) => {
  const dados = linhagemNova.parse(req.body)

  res.status(201).json(await criarLinhagem(dados, usuarioDaRequisicao(req)))
})

catalogoRoutes.patch('/linhagens/:id', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = alteracaoDeLinhagem.parse(req.body)

  res.json(await alterarLinhagem(id, dados, usuarioDaRequisicao(req)))
})
