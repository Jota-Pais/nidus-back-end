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
} from './demanda.service.ts'

export const projetoRoutes = Router()
export const solicitacaoRoutes = Router()

projetoRoutes.get('/', exigirPerfil(), async (req, res) => {
  res.json(await listarProjetos(usuarioDaRequisicao(req)))
})

solicitacaoRoutes.get('/', exigirPerfil(), async (req, res) => {
  res.json(await listarSolicitacoes(usuarioDaRequisicao(req)))
})

// Os tetos protegem as colunas SMALLINT do banco. 300 dias e o teto do formulario do cliente
const MAXIMO_DE_ANIMAIS = 9999
const IDADE = { minima: 21, maxima: 300 }

const animais = z
  .number()
  .int()
  .min(0)
  .max(MAXIMO_DE_ANIMAIS, `No maximo ${MAXIMO_DE_ANIMAIS} animais.`)

/** corpo de POST /api/solicitacoes - o formulario "Solicitar animais". O e-mail vem da sessao */
export const solicitacaoNova = z
  .object({
    nomePesquisador: z
      .string()
      .trim()
      .min(1, 'Informe o nome do pesquisador.')
      .max(120, 'O nome passa de 120 caracteres.'),
    /** o numero do projeto em etica.projeto */
    protocoloCeua: z.string().regex(/^23080\.\d{6}\/\d{4}-\d{2}$/, 'Use o formato 23080.XXXXXX/AAAA-XX.'),
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
    cronograma: z.enum(['unica', 'semanal', 'quinzenal', 'mensal']),
    /** vazia ou ausente vira null */
    observacoes: z
      .string()
      .trim()
      .max(500, 'As observacoes passam de 500 caracteres.')
      .optional()
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
  .refine((dados) => dados.dataEntrega >= hojeISO(), {
    path: ['dataEntrega'],
    error: 'A data de entrega ja passou.',
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
