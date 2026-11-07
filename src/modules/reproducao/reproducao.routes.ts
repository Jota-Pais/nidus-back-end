import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { corrigirDesmame, corrigirNascimento, corrigirSelecao } from './correcao.service.ts'
import {
  encerrarCasal,
  formarCasal,
  registrarAcasalamento,
  registrarDesmame,
  registrarNascimento,
  registrarSelecao,
} from './reproducao.service.ts'

/**
 * Dois routers porque a URL tem duas raizes -
 * '/api/casais' e /api/partos - e um 'parto' nao pertence a um casal na
 * rota (quadro e ficha abrem pelo idCaixa/idParto, nunca
 * navegando 'casal -> parto' na URL).
 */
export const casalRoutes = Router()
export const partoRoutes = Router()

const idNaRota = z.object({ id: z.coerce.number().int().positive() })

/** 'aaaa-mm-dd', nunca timestamp para data de calendario. */
const dataCalendario = z.iso
  .date('Data invalida. Use aaaa-mm-dd.')
  .refine((data) => data >= '2000-01-01' && data <= '2100-12-31', 'Use um ano entre 2000 e 2100.')

const grupoGenetico = z.enum(['A', 'B', 'C', 'D', 'E'])

/**
 * Corpo de POST /api/casais. O casal vai numa caixa que ja existe ('idCaixa') ou numa posicao
 * vazia da estante ('posicao'), e ai a caixa nasce junto. Par genetico e linhagem da especie
 * certa sao conferidos no servico - o Zod garante so a forma
 */
export const casalNovo = z
  .object({
    idCaixa: z.number().int().positive().optional(),
    posicao: z
      .object({
        idEstante: z.number().int().positive(),
        face: z.enum(['frontal', 'traseira']),
        linha: z.number().int().positive(),
        coluna: z.number().int().positive(),
      })
      .optional(),
    idLinhagem: z.number().int().positive(),
    grupoMacho: grupoGenetico,
    grupoFemea: grupoGenetico,
    dtFormacao: dataCalendario,
  })
  .refine((dados) => (dados.idCaixa === undefined) !== (dados.posicao === undefined), {
    path: ['idCaixa'],
    error: 'Informe a caixa ou a posicao vazia, uma das duas.',
  })

casalRoutes.post('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const dados = casalNovo.parse(req.body)

  res.status(201).json(await formarCasal(dados, usuarioDaRequisicao(req).id))
})

const encerramento = z.object({
  dtEncerramento: dataCalendario,
  motivo: z.string().trim().min(1).max(200),
})

casalRoutes.post('/:id/encerramento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = encerramento.parse(req.body)

  res.json(await encerrarCasal(id, dados, usuarioDaRequisicao(req).id))
})

const acasalamento = z.object({ dtAcasalamento: dataCalendario })

casalRoutes.post('/:id/acasalamento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = acasalamento.parse(req.body)

  res.status(201).json(await registrarAcasalamento(id, dados, usuarioDaRequisicao(req).id))
})

const nascimento = z.object({
  dtPartoReal: dataCalendario,
  nascidoM: z.number().int().min(0),
  nascidoF: z.number().int().min(0),
})

partoRoutes.post('/:id/nascimento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = nascimento.parse(req.body)

  res.json(await registrarNascimento(id, dados, usuarioDaRequisicao(req).id))
})

const selecao = z.object({
  dtSelecao: dataCalendario,
  eutanasiadoM: z.number().int().min(0),
  eutanasiadoF: z.number().int().min(0),
})

partoRoutes.post('/:id/selecao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = selecao.parse(req.body)

  res.json(await registrarSelecao(id, dados, usuarioDaRequisicao(req).id))
})

/** Corpo de POST /api/partos/:id/desmame. Chave a mais que o front mande e descartada */
export const desmame = z.object({
  dtDesmameReal: dataCalendario,
  desmamadoM: z.number().int().min(0),
  desmamadoF: z.number().int().min(0),
})

partoRoutes.post('/:id/desmame', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = desmame.parse(req.body)

  res.json(await registrarDesmame(id, dados, usuarioDaRequisicao(req).id))
})

const motivoDaCorrecao = z.object({
  motivo: z.string().trim().min(1, 'Diga o motivo da correcao.').max(200),
})

partoRoutes.patch('/:id/nascimento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = nascimento.extend(motivoDaCorrecao.shape).parse(req.body)

  res.json(await corrigirNascimento(id, dados, usuarioDaRequisicao(req).id))
})

partoRoutes.patch('/:id/selecao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = selecao.extend(motivoDaCorrecao.shape).parse(req.body)

  res.json(await corrigirSelecao(id, dados, usuarioDaRequisicao(req).id))
})

partoRoutes.patch('/:id/desmame', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = desmame.extend(motivoDaCorrecao.shape).parse(req.body)

  res.json(await corrigirDesmame(id, dados, usuarioDaRequisicao(req).id))
})
