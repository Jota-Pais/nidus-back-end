import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { dataDoFato, idNaRota, idNoCorpo } from '../../shared/validacao.ts'
import { montarQuadro, mudarDePosicao } from './caixa.service.ts'
import { montarFicha } from './ficha.service.ts'
import { registrarMudanca, virarCaixaDeEstoque } from './mudanca.service.ts'

/** /api/quadro e o kanban de uma especie; /api/caixas e a ficha, a posicao e os animais que mudam */
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

/** GET /api/caixas/:id - a ficha da caixa */
caixaRoutes.get('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await montarFicha(id))
})

/** Uma posicao da estante */
const posicao = z.object({
  idEstante: idNoCorpo,
  face: z.enum(['frontal', 'traseira']),
  linha: idNoCorpo,
  coluna: idNoCorpo,
})

caixaRoutes.patch('/:id/posicao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await mudarDePosicao(id, posicao.parse(req.body), usuarioDaRequisicao(req).id))
})

/** POST /api/caixas/:id/estoque - a caixa do casal encerrado vira caixa de estoque no lugar */
caixaRoutes.post('/:id/estoque', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await virarCaixaDeEstoque(id, usuarioDaRequisicao(req).id))
})

/**
 * Os animais de um sexo que mudam, e para onde: uma caixa de estoque ou uma posicao vazia. O
 * pedido diz de onde saem os reservados quando os livres nao bastam; com soDoPedido, so os
 * reservados dele mudam
 */
const grupoQueMuda = z
  .object({
    qtd: z.number().int().positive('Informe quantos animais.').max(999, 'No maximo 999 animais.'),
    dtNascimento: z.iso.date('Data invalida. Use aaaa-mm-dd.').optional(),
    idPedido: idNoCorpo.optional(),
    soDoPedido: z.boolean().optional(),
    destino: z.union([z.object({ idCaixa: idNoCorpo }), z.object({ posicao })], {
      error: 'Escolha a caixa de estoque ou uma posicao vazia.',
    }),
  })
  .refine((grupo) => grupo.soDoPedido !== true || grupo.idPedido !== undefined, {
    path: ['idPedido'],
    error: 'Diga de qual pedido sao os reservados que mudam.',
  })

/** Corpo de POST /api/caixas/:id/mudanca */
export const mudanca = z
  .object({
    dtFato: dataDoFato,
    machos: grupoQueMuda.optional(),
    femeas: grupoQueMuda.optional(),
  })
  .refine((dados) => dados.machos !== undefined || dados.femeas !== undefined, {
    path: ['machos'],
    error: 'Informe os machos, as femeas ou os dois.',
  })

/**
 * POST /api/caixas/:id/mudanca - animais desmamados mudam desta caixa para caixas de estoque:
 * a passagem da caixa do casal e a mudanca de estoque para estoque
 */
caixaRoutes.post('/:id/mudanca', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = mudanca.parse(req.body)

  res.status(201).json(await registrarMudanca(id, dados, usuarioDaRequisicao(req).id))
})
