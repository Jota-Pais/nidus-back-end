import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import {
  alocarSolicitacao,
  criarSolicitacao,
  listarProjetos,
  listarSolicitacoes,
  recusarSemResposta,
  recusarSolicitacao,
  registrarEntrega,
} from './demanda.service.ts'
import { devolverParaAnalise } from './devolucao.service.ts'
import { SITUACAO_DO_PROJETO, alterarProjeto, criarProjeto } from './projeto.service.ts'
import { numeroCeua } from './protocolo.ts'

export const projetoRoutes = Router()
export const solicitacaoRoutes = Router()

const idNaRota = z.object({ id: z.coerce.number().int().positive() })

/** So o gestor lista: o pesquisador digita o protocolo e nao ve o dos outros */
projetoRoutes.get('/', exigirPerfil('gestor'), async (req, res) => {
  res.json(await listarProjetos(usuarioDaRequisicao(req)))
})

export const projetoNovo = z.object({
  numero: numeroCeua,
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
  await recusarSemResposta().catch((erro: unknown) => {
    console.error('[pedido] a recusa dos pedidos sem resposta falhou:', erro)
  })
  res.json(await listarSolicitacoes(usuarioDaRequisicao(req)))
})

// Os tetos protegem as colunas SMALLINT do banco. 300 dias e o teto do formulario do cliente
const MAXIMO_DE_ANIMAIS = 9999
const IDADE = { minima: 21, maxima: 300 }

const animais = z
  .number()
  .int('Use um numero inteiro de animais.')
  .min(0, 'O numero de animais nao pode ser negativo.')
  .max(MAXIMO_DE_ANIMAIS, `No maximo ${MAXIMO_DE_ANIMAIS} animais.`)

/** corpo de POST /api/solicitacoes - o formulario "Solicitar animais". O e-mail vem da sessao */
export const solicitacaoNova = z
  .object({
    nomePesquisador: z
      .string()
      .trim()
      .min(1, 'Informe o nome do pesquisador.')
      .max(120, 'O nome passa de 120 caracteres.'),
    /** so o formato: o pedido nao depende de projeto cadastrado */
    protocoloCeua: numeroCeua,
    idLinhagem: z.number().int().positive(),
    machos: animais,
    femeas: animais,
    qualquer: animais,
    /** a idade exata vem com idadeMin = idadeMax */
    idadeMin: z
      .number()
      .int()
      .min(IDADE.minima, `A idade minima e ${IDADE.minima} dias.`)
      .max(IDADE.maxima, `A idade maxima e ${IDADE.maxima} dias.`),
    idadeMax: z.number().int().max(IDADE.maxima, `A idade maxima e ${IDADE.maxima} dias.`),
    dataEntrega: z.iso.date('Data invalida. Use aaaa-mm-dd.'),
    /** vazia, ausente ou null (o que o GET devolve sem observacoes) vira null */
    observacoes: z
      .string()
      .trim()
      .max(500, 'As observacoes passam de 500 caracteres.')
      .nullish()
      .transform((texto) => texto || null),
  })
  .refine((dados) => dados.machos + dados.femeas + dados.qualquer > 0, {
    path: ['machos'],
    error: 'Peca ao menos um animal.',
  })
  .refine((dados) => dados.idadeMax >= dados.idadeMin, {
    path: ['idadeMax'],
    error: 'A idade maxima nao pode ser menor que a minima.',
  })
  // hoje e o dia de Brasilia: em UTC, das 21h a meia-noite, hoje ja seria passado
  .refine((dados) => dados.dataEntrega >= hojeISO(), {
    path: ['dataEntrega'],
    error: 'A data de entrega ja passou.',
  })

solicitacaoRoutes.post('/', exigirPerfil('pesquisador'), async (req, res) => {
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

/** POST /api/solicitacoes/:id/devolucao - o pedido aceito com reserva em falta volta para analise */
solicitacaoRoutes.post('/:id/devolucao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  res.json(await devolverParaAnalise(id, usuarioDaRequisicao(req)))
})
