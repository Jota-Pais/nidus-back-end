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
import { criarCaixaDeEstoque } from './entrada.service.ts'
import { montarFicha } from './ficha.service.ts'
import { listarLiberadas } from './liberadas.service.ts'
import { registrarMudanca, virarCaixaDeEstoque } from './mudanca.service.ts'

/** /api/caixas e a ficha, a posicao, os animais que mudam e o cadastro inicial do estoque */
export const caixaRoutes = Router()

const idNaConsulta = z.coerce.number().int().positive().max(2147483647)
const diaNaConsulta = z.iso.date('Data inválida. Use aaaa-mm-dd.')

/** A consulta de GET /api/caixas/liberadas: a especie e, se quiser, a linhagem, a busca e o periodo */
export const filtroDasLiberadas = z
  .object({
    idEspecie: idNaConsulta,
    idLinhagem: idNaConsulta.optional(),
    busca: z.string().trim().min(1).max(40).optional(),
    de: diaNaConsulta.optional(),
    ate: diaNaConsulta.optional(),
    limite: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((filtro) => filtro.de === undefined || filtro.ate === undefined || filtro.de <= filtro.ate, {
    path: ['ate'],
    error: 'O fim do período não pode ser antes do início.',
  })

/**
 * GET /api/caixas/liberadas - as caixas que sairam da estante, da especie pedida, a liberacao mais
 * recente primeiro. Antes de '/:id', que leria 'liberadas' como id
 */
caixaRoutes.get('/liberadas', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  res.json(await listarLiberadas(filtroDasLiberadas.parse(req.query)))
})

/** GET /api/caixas/:id - a ficha da caixa, tambem a da caixa liberada */
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

/** Uma ninhada aparece uma vez so na lista da edicao */
const umaVezCada = (lista: { idParto: number }[]) =>
  new Set(lista.map((item) => item.idParto)).size === lista.length

/**
 * Corpo de PATCH /api/caixas/:id: o que mudou na caixa de estoque, sem motivo (e o engano de
 * digitacao do cadastro inicial). A quantidade e a de cada ninhada do cadastro inicial, ao menos
 * 1: e assim que se acrescenta ou tira animal do cadastro depois que a caixa nasceu. O que fica
 * contraditorio e conferido no servico
 */
export const edicaoDoEstoque = z
  .object({
    idLinhagem: idNoCorpo.optional(),
    sexo: z.enum(['M', 'F'], { error: 'Escolha machos ou fêmeas.' }).optional(),
    nascimentos: z
      .array(z.object({ idParto: idNoCorpo, dtNascimento: dataDoFato }))
      .min(1)
      .max(50)
      .refine(umaVezCada, { error: 'Cada ninhada aparece uma vez só.' })
      .optional(),
    quantidades: z
      .array(z.object({ idParto: idNoCorpo, quantidade: entrada.shape.quantidade }))
      .min(1)
      .max(50)
      .refine(umaVezCada, { error: 'Cada ninhada aparece uma vez só.' })
      .optional(),
  })
  .refine((dados) => Object.values(dados).some((valor) => valor !== undefined), {
    error: 'Mude ao menos um dado da caixa.',
  })

/**
 * PATCH /api/caixas/:id - corrige a caixa de estoque: a linhagem, o sexo, e o nascimento e a
 * quantidade do que veio do cadastro inicial. Devolve a ficha
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

/** No maximo quantas caixas recebem os animais de um sexo numa mudanca */
export const PARTES_POR_SEXO = 20

const partesQueMudam = z
  .array(grupoQueMuda)
  .min(1, 'Informe ao menos uma caixa.')
  .max(PARTES_POR_SEXO, `No máximo ${PARTES_POR_SEXO} caixas por sexo.`)

/**
 * Um sexo todo para uma caixa (o grupo) ou dividido em varias (a lista, uma parte por caixa). Le
 * pelo formato que chegou, e nao por z.union: assim cada erro fica no campo dele
 * ('machos.destino', 'machos.1.qtd') em vez de um erro so no sexo
 */
const sexoQueMuda = z.unknown().transform((valor, ctx) => {
  const lido = Array.isArray(valor) ? partesQueMudam.safeParse(valor) : grupoQueMuda.safeParse(valor)
  if (lido.success) return lido.data

  for (const issue of lido.error.issues) ctx.addIssue({ ...issue, code: 'custom', message: issue.message })
  return z.NEVER
})

/** Corpo de POST /api/caixas/:id/mudanca */
export const mudanca = z
  .object({
    dtFato: dataDoFato,
    machos: sexoQueMuda.optional(),
    femeas: sexoQueMuda.optional(),
  })
  .refine((dados) => dados.machos !== undefined || dados.femeas !== undefined, {
    path: ['machos'],
    error: 'Informe os machos, as fêmeas ou os dois.',
  })

/**
 * POST /api/caixas/:id/mudanca - animais desmamados mudam desta caixa para caixas de estoque:
 * a passagem da caixa do casal e a mudanca de estoque para estoque. Cada sexo vai para uma caixa
 * ({ qtd, destino }) ou dividido em ate PARTES_POR_SEXO caixas ([{ qtd, destino }, ...]), tudo
 * numa operacao so. Devolve { caixas, liberada }, uma caixa por parte
 */
caixaRoutes.post('/:id/mudanca', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = mudanca.parse(req.body)

  res.status(201).json(await registrarMudanca(id, dados, usuarioDaRequisicao(req).id))
})
