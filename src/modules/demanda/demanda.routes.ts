import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { dataDoFato, idNaRota, idNoCorpo } from '../../shared/validacao.ts'
import { registrarEntrega } from './entrega.service.ts'
import { aprovarPedido, criarPedido, listarPedidos, recusarPedido, recusarSemResposta } from './pedido.service.ts'
import { SITUACAO_DO_PROJETO, alterarProjeto, criarProjeto, listarProjetos } from './projeto.service.ts'
import { numeroCeua } from './protocolo.ts'
import { desfazerReserva, reservarAnimais } from './reserva.service.ts'
import { retiradaDoPedido } from './retirada.service.ts'

export const projetoRoutes = Router()
export const pedidoRoutes = Router()

/** So o gestor lista: o pesquisador digita o protocolo e nao ve o dos outros */
projetoRoutes.get('/', exigirPerfil('gestor'), async (req, res) => {
  res.json(await listarProjetos(usuarioDaRequisicao(req)))
})

export const projetoNovo = z.object({
  numero: numeroCeua,
  titulo: z.string().trim().min(1).max(255),
  idUsuarioResponsavel: idNoCorpo,
  dtVigenciaInicio: z.iso.date('Data inválida. Use aaaa-mm-dd.'),
  dtVigenciaFim: z.iso.date('Data inválida. Use aaaa-mm-dd.'),
  cotaAutorizada: z.number().int().min(0).max(2147483647),
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

/** GET /api/pedidos - antes de listar, recusa os pedidos que ficaram sem resposta */
pedidoRoutes.get('/', exigirPerfil(), async (req, res) => {
  await recusarSemResposta().catch((erro: unknown) => {
    console.error('[pedido] a recusa dos pedidos sem resposta falhou:', erro)
  })
  res.json(await listarPedidos(usuarioDaRequisicao(req)))
})

// Os tetos protegem as colunas SMALLINT do banco. 300 dias e o teto do formulario do cliente
const MAXIMO_DE_ANIMAIS = 9999
const IDADE = { minima: 21, maxima: 300 }

const animais = z
  .number()
  .int('Use um número inteiro de animais.')
  .min(0, 'O número de animais não pode ser negativo.')
  .max(MAXIMO_DE_ANIMAIS, `No máximo ${MAXIMO_DE_ANIMAIS} animais.`)

/** corpo de POST /api/pedidos - o formulario "Solicitar animais". O e-mail vem da sessao */
export const pedidoNovo = z
  .object({
    nomePesquisador: z
      .string()
      .trim()
      .min(1, 'Informe o nome do pesquisador.')
      .max(120, 'O nome passa de 120 caracteres.'),
    /** so o formato: o pedido nao depende de projeto cadastrado */
    protocoloCeua: numeroCeua,
    idLinhagem: idNoCorpo,
    machos: animais,
    femeas: animais,
    qualquer: animais,
    /** a idade exata vem com idadeMin = idadeMax */
    idadeMin: z
      .number()
      .int()
      .min(IDADE.minima, `A idade mínima é ${IDADE.minima} dias.`)
      .max(IDADE.maxima, `A idade máxima é ${IDADE.maxima} dias.`),
    idadeMax: z.number().int().max(IDADE.maxima, `A idade máxima é ${IDADE.maxima} dias.`),
    dataEntrega: z.iso
      .date('Data inválida. Use aaaa-mm-dd.')
      .refine((data) => data <= '2100-12-31', 'Use um ano até 2100.'),
    /** vazia, ausente ou null (o que o GET devolve sem observacoes) vira null */
    observacoes: z
      .string()
      .trim()
      .max(500, 'As observações passam de 500 caracteres.')
      .nullish()
      .transform((texto) => texto || null),
  })
  .refine((dados) => dados.machos + dados.femeas + dados.qualquer > 0, {
    path: ['machos'],
    error: 'Peça ao menos um animal.',
  })
  .refine((dados) => dados.idadeMax >= dados.idadeMin, {
    path: ['idadeMax'],
    error: 'A idade máxima não pode ser menor que a mínima.',
  })
  // hoje e o dia de Brasilia: em UTC, das 21h a meia-noite, hoje ja seria passado
  .refine((dados) => dados.dataEntrega >= hojeISO(), {
    path: ['dataEntrega'],
    error: 'A data de entrega já passou.',
  })

pedidoRoutes.post('/', exigirPerfil('pesquisador'), async (req, res) => {
  const dados = pedidoNovo.parse(req.body)

  res.status(201).json(await criarPedido(dados, usuarioDaRequisicao(req)))
})

/** POST /api/pedidos/:id/aprovacao - a equipe aceita fazer o pedido sem reservar; reserva depois */
pedidoRoutes.post('/:id/aprovacao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await aprovarPedido(id, usuarioDaRequisicao(req)))
})

/**
 * Corpo de POST /api/pedidos/:id/alocacao: os lugares da busca (a caixa e a data de nascimento) e
 * quantos machos e femeas sair de cada um. O "qualquer" do pedido vem como macho ou femea
 */
export const alocacao = z.object({
  itens: z
    .array(
      z
        .object({
          idCaixa: idNoCorpo,
          dtNascimento: z.iso.date('Data inválida. Use aaaa-mm-dd.'),
          machos: animais,
          femeas: animais,
        })
        .refine((item) => item.machos + item.femeas > 0, {
          path: ['machos'],
          error: 'Escolha ao menos um animal desta caixa.',
        }),
    )
    .min(1, 'Escolha ao menos uma caixa.')
    .max(100, 'No máximo 100 caixas numa reserva.'),
})

/**
 * POST /api/pedidos/:id/alocacao - so quem opera a colonia reserva: o pedido enviado (aprovado na
 * mesma reserva) ou aprovado inteiro, ou o que falta no reservado em falta
 */
pedidoRoutes.post('/:id/alocacao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const { itens } = alocacao.parse(req.body)

  res.json(await reservarAnimais(id, itens, usuarioDaRequisicao(req)))
})

/** Corpo de POST /api/pedidos/:id/entrega: o dia em que os animais sairam, nunca no futuro */
export const entrega = z.object({ dtEntrega: dataDoFato })

pedidoRoutes.post('/:id/entrega', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const { dtEntrega } = entrega.parse(req.body)

  res.json(await registrarEntrega(id, dtEntrega, usuarioDaRequisicao(req).id))
})

const recusa = z.object({
  motivo: z.string().trim().min(1, 'Diga o motivo da recusa.').max(200),
})

/** POST /api/pedidos/:id/recusa - o pedido reservado tambem: os animais voltam a ficar livres */
pedidoRoutes.post('/:id/recusa', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const { motivo } = recusa.parse(req.body)

  res.json(await recusarPedido(id, motivo, usuarioDaRequisicao(req).id))
})

/** POST /api/pedidos/:id/devolucao - desfaz a reserva, com falta ou sem; o pedido volta a aprovado */
pedidoRoutes.post('/:id/devolucao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await desfazerReserva(id, usuarioDaRequisicao(req)))
})

/** GET /api/pedidos/:id/retirada - de que caixas tirar os animais do pedido na entrega */
pedidoRoutes.get('/:id/retirada', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await retiradaDoPedido(id))
})
