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
  recusarSolicitacao,
  registrarEntrega,
} from './demanda.service.ts'
import { SITUACAO_DO_PROJETO, alterarProjeto, criarProjeto } from './projeto.service.ts'

export const projetoRoutes = Router()
export const solicitacaoRoutes = Router()

const idNaRota = z.object({ id: z.coerce.number().int().positive() })

projetoRoutes.get('/', exigirPerfil(), async (req, res) => {
  res.json(await listarProjetos(usuarioDaRequisicao(req)))
})

export const projetoNovo = z.object({
  numero: z.string().trim().min(1).max(30),
  titulo: z.string().trim().min(1).max(255),
  idUsuarioResponsavel: z.number().int().positive(),
  dtVigenciaInicio: z.iso.date('Data invalida. Use aaaa-mm-dd.'),
  dtVigenciaFim: z.iso.date('Data invalida. Use aaaa-mm-dd.'),
  cotaAutorizada: z.number().int().min(0),
  situacao: z.enum(Object.values(SITUACAO_DO_PROJETO)),
})

projetoRoutes.post('/', exigirPerfil('gestor'), async (req, res) => {
  const dados = projetoNovo.parse(req.body)

  res.status(201).json(await criarProjeto(dados, usuarioDaRequisicao(req)))
})

projetoRoutes.put('/:id', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = projetoNovo.parse(req.body)

  res.json(await alterarProjeto(id, dados, usuarioDaRequisicao(req)))
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

const entrega = z.object({
  dtEntrega: z.iso.date('Data invalida. Use aaaa-mm-dd.'),
})

solicitacaoRoutes.post('/:id/entrega', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const { dtEntrega } = entrega.parse(req.body)

  res.json(await registrarEntrega(id, dtEntrega, usuarioDaRequisicao(req).id))
})

const recusa = z.object({
  motivo: z.string().trim().min(1, 'Diga o motivo da recusa.').max(200),
})

solicitacaoRoutes.post('/:id/recusa', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const { motivo } = recusa.parse(req.body)

  res.json(await recusarSolicitacao(id, motivo, usuarioDaRequisicao(req).id))
})
