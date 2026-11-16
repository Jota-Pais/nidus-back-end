import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { dataDoFato, idNaRota, idNoCorpo } from '../../shared/validacao.ts'
import { mudarDePosicao } from './caixa.service.ts'
import { editarCaixaDeEstoque } from './edicaoDoEstoque.service.ts'
import { criarCaixaDeEstoque, registrarEntrada } from './entrada.service.ts'
import { montarFicha } from './ficha.service.ts'
import { registrarMudanca, virarCaixaDeEstoque } from './mudanca.service.ts'

/** /api/caixas e a ficha, a posicao, os animais que mudam e o cadastro inicial do estoque */
export const caixaRoutes = Router()

/** GET /api/caixas/:id - a ficha da caixa */
caixaRoutes.get('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await montarFicha(id))
})

/** Uma posicao da estante, como no formar casal */
const posicao = z.object({
  idEstante: idNoCorpo,
  face: z.enum(['frontal', 'traseira']),
  linha: idNoCorpo,
  coluna: idNoCorpo,
})

/**
 * Um grupo de idade do cadastro inicial: quantos e quando nasceram (hoje ou antes). A idade minima
 * do estoque e conferida no servico
 */
const entrada = z.object({
  quantidade: z.number().int('Informe quantos animais.').min(1, 'Informe ao menos 1 animal.').max(999, 'No máximo 999 animais.'),
  dtNascimento: dataDoFato,
})

/** Corpo de POST /api/caixas/estoque: a caixa de estoque nova numa posicao vazia, com o primeiro grupo */
export const caixaDeEstoqueNova = entrada.extend({
  posicao,
  idLinhagem: idNoCorpo,
  sexo: z.enum(['M', 'F'], { error: 'Escolha machos ou fêmeas.' }),
})

/**
 * POST /api/caixas/estoque - o cadastro inicial: a caixa de estoque nasce na posicao vazia com
 * animais de idade conhecida e casal desconhecido. Devolve { idCaixa, codigo }
 */
caixaRoutes.post('/estoque', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const dados = caixaDeEstoqueNova.parse(req.body)

  res.status(201).json(await criarCaixaDeEstoque(dados, usuarioDaRequisicao(req).id))
})

/** Corpo de POST /api/caixas/:id/entrada: o sexo e a linhagem sao os da caixa */
export const entradaNaCaixa = entrada

/** POST /api/caixas/:id/entrada - mais um grupo de idade do cadastro inicial na caixa de estoque */
caixaRoutes.post('/:id/entrada', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = entradaNaCaixa.parse(req.body)

  res.status(201).json(await registrarEntrada(id, dados, usuarioDaRequisicao(req).id))
})

/**
 * Corpo de PATCH /api/caixas/:id: o que mudou na caixa de estoque, sem motivo (e o engano de
 * digitacao do cadastro inicial). O que fica contraditorio e conferido no servico
 */
export const edicaoDoEstoque = z
  .object({
    idLinhagem: idNoCorpo.optional(),
    sexo: z.enum(['M', 'F'], { error: 'Escolha machos ou fêmeas.' }).optional(),
    nascimentos: z
      .array(z.object({ idParto: idNoCorpo, dtNascimento: dataDoFato }))
      .min(1)
      .max(50)
      .refine((lista) => new Set(lista.map((item) => item.idParto)).size === lista.length, {
        error: 'Cada ninhada aparece uma vez só.',
      })
      .optional(),
  })
  .refine((dados) => Object.values(dados).some((valor) => valor !== undefined), {
    error: 'Mude ao menos um dado da caixa.',
  })

/**
 * PATCH /api/caixas/:id - corrige a caixa de estoque: a linhagem, o sexo e o nascimento do que veio
 * do cadastro inicial. Devolve a ficha
 */
caixaRoutes.patch('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = edicaoDoEstoque.parse(req.body)

  res.json(await editarCaixaDeEstoque(id, dados, usuarioDaRequisicao(req).id))
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
    qtd: z.number().int().positive('Informe quantos animais.').max(999, 'No máximo 999 animais.'),
    dtNascimento: z.iso.date('Data inválida. Use aaaa-mm-dd.').optional(),
    idPedido: idNoCorpo.optional(),
    soDoPedido: z.boolean().optional(),
    destino: z.union([z.object({ idCaixa: idNoCorpo }), z.object({ posicao })], {
      error: 'Escolha a caixa de estoque ou uma posição vazia.',
    }),
  })
  .refine((grupo) => grupo.soDoPedido !== true || grupo.idPedido !== undefined, {
    path: ['idPedido'],
    error: 'Diga de qual pedido são os reservados que mudam.',
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
    error: 'Informe os machos, as fêmeas ou os dois.',
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
