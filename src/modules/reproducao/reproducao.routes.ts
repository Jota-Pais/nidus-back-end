import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { dataDoFato, idNaRota, idNoCorpo, motivoDaCorrecao } from '../../shared/validacao.ts'
import { corrigirAcasalamento, corrigirDesmame, corrigirNascimento } from './correcao.service.ts'
import {
  encerrarCasal,
  fecharSemNinhada,
  formarCasal,
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

const grupoGenetico = z.enum(['A', 'B', 'C', 'D', 'E'])

const contagem = z.number().int().min(0).max(999, 'No máximo 999 animais.')

/**
 * Corpo de POST /api/casais. O casal vai numa caixa que ja existe ('idCaixa') ou numa posicao
 * vazia da estante ('posicao'), e ai a caixa nasce junto. Par genetico e linhagem da especie
 * certa sao conferidos no servico - o Zod garante so a forma
 */
export const casalNovo = z
  .object({
    idCaixa: idNoCorpo.optional(),
    posicao: z
      .object({
        idEstante: idNoCorpo,
        face: z.enum(['frontal', 'traseira']),
        linha: idNoCorpo,
        coluna: idNoCorpo,
      })
      .optional(),
    idLinhagem: idNoCorpo,
    grupoMacho: grupoGenetico,
    grupoFemea: grupoGenetico,
    dtFormacao: dataDoFato,
  })
  .refine((dados) => (dados.idCaixa === undefined) !== (dados.posicao === undefined), {
    path: ['idCaixa'],
    error: 'Informe a caixa ou a posição vazia, uma das duas.',
  })

casalRoutes.post('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const dados = casalNovo.parse(req.body)

  res.status(201).json(await formarCasal(dados, usuarioDaRequisicao(req).id))
})

const encerramento = z.object({
  dtEncerramento: dataDoFato,
  motivo: z.string().trim().min(1).max(200),
})

casalRoutes.post('/:id/encerramento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = encerramento.parse(req.body)

  res.json(await encerrarCasal(id, dados, usuarioDaRequisicao(req).id))
})

const nascimento = z.object({
  dtPartoReal: dataDoFato,
  nascidoM: contagem,
  nascidoF: contagem,
})

partoRoutes.post('/:id/nascimento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = nascimento.parse(req.body)

  res.json(await registrarNascimento(id, dados, usuarioDaRequisicao(req).id))
})

/** De qual pedido saem os reservados quando os livres nao bastam. So quando a resposta pedir */
const pedidoDosReservados = { idPedido: idNoCorpo.optional() }

/** Corpo de POST /api/partos/:id/selecao: uma rodada de eutanasia, com ao menos um animal */
export const selecao = z
  .object({
    dtSelecao: dataDoFato,
    eutanasiadoM: contagem,
    eutanasiadoF: contagem,
    ...pedidoDosReservados,
  })
  .refine((dados) => dados.eutanasiadoM + dados.eutanasiadoF > 0, {
    path: ['eutanasiadoM'],
    error: 'Informe ao menos um animal.',
  })

partoRoutes.post('/:id/selecao', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = selecao.parse(req.body)

  res.json(await registrarSelecao(id, dados, usuarioDaRequisicao(req).id))
})

/** Corpo de POST /api/partos/:id/desmame. Chave a mais que o front mande e descartada */
export const desmame = z.object({
  dtDesmameReal: dataDoFato,
  desmamadoM: contagem,
  desmamadoF: contagem,
  ...pedidoDosReservados,
})

partoRoutes.post('/:id/desmame', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = desmame.parse(req.body)

  res.json(await registrarDesmame(id, dados, usuarioDaRequisicao(req).id))
})

/** Corpo de POST /api/partos/:id/sem-ninhada */
export const semNinhada = z.object({
  dtSemNinhada: dataDoFato,
  motivo: z.string().trim().min(1, 'Diga por que o parto não vai nascer.').max(200),
})

partoRoutes.post('/:id/sem-ninhada', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = semNinhada.parse(req.body)

  res.json(await fecharSemNinhada(id, dados, usuarioDaRequisicao(req).id))
})

/** Corpo de PATCH /api/partos/:id/nascimento */
export const correcaoDoNascimento = nascimento.extend({
  motivo: motivoDaCorrecao,
  idCaixa: idNoCorpo.optional(),
  ...pedidoDosReservados,
})

partoRoutes.patch('/:id/nascimento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = correcaoDoNascimento.parse(req.body)

  res.json(await corrigirNascimento(id, dados, usuarioDaRequisicao(req).id))
})

/** Corpo de PATCH /api/partos/:id/desmame: so a data. A contagem se corrige pelas baixas */
export const correcaoDoDesmame = z.object({ dtDesmameReal: dataDoFato, motivo: motivoDaCorrecao })

partoRoutes.patch('/:id/desmame', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = correcaoDoDesmame.parse(req.body)

  res.json(await corrigirDesmame(id, dados, usuarioDaRequisicao(req).id))
})

/**
 * Corpo de PATCH /api/partos/:id/acasalamento. A data do acasalamento se edita direto na ficha,
 * sem motivo: ninguem ve o casal acasalar, e a data que vale e a ultima que alguem pos
 */
export const correcaoDoAcasalamento = z.object({
  dtAcasalamento: dataDoFato,
  motivo: motivoDaCorrecao.optional(),
})

partoRoutes.patch('/:id/acasalamento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = correcaoDoAcasalamento.parse(req.body)

  res.json(await corrigirAcasalamento(id, dados, usuarioDaRequisicao(req).id))
})
