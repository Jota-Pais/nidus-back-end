import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import {
  alocarSolicitacao,
  criarSolicitacao,
  listarProjetos,
  listarSolicitacoes,
} from './demanda.service.ts'

export const projetoRoutes = Router()
export const solicitacaoRoutes = Router()

projetoRoutes.get('/', exigirPerfil(), async (req, res) => {
  res.json(await listarProjetos(usuarioDaRequisicao(req)))
})

solicitacaoRoutes.get('/', exigirPerfil(), async (req, res) => {
  res.json(await listarSolicitacoes(usuarioDaRequisicao(req)))
})

/** corpo de POST /api/solicitacoes - o formulario "Solicitar animais" */
export const solicitacaoNova = z
  .object({
    idProjeto: z.number().int().positive(),
    idLinhagem: z.number().int().positive(),
    machos: z.number().int().min(0),
    femeas: z.number().int().min(0),
    idade: z.number().int().min(21, 'A idade minima e 21 dias.'),
    dataEntrega: z.iso.date('Data invalida. Use aaaa-mm-dd.'),
    cronograma: z.enum(['unica', 'semanal', 'quinzenal', 'mensal']),
  })
  .refine((dados) => dados.machos + dados.femeas > 0, {
    path: ['machos'],
    error: 'Peca ao menos um animal.',
  })

solicitacaoRoutes.post('/', exigirPerfil(), async (req, res) => {
  const dados = solicitacaoNova.parse(req.body)

  res.status(201).json(await criarSolicitacao(dados, usuarioDaRequisicao(req)))
})

const idNaRota = z.object({ id: z.coerce.number().int().positive() })

const alocacao = z.object({
  itens: z
    .array(
      z.object({
        idParto: z.number().int().positive(),
        machos: z.number().int().min(0),
        femeas: z.number().int().min(0),
      }),
    )
    .min(1, 'Escolha ao menos uma caixa.'),
})

/** POST /api/solicitacoes/:id/alocacao - so quem opera a colonia aloca */
solicitacaoRoutes.post('/:id/alocacao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const { itens } = alocacao.parse(req.body)

  res.json(await alocarSolicitacao(id, itens, usuarioDaRequisicao(req)))
})
