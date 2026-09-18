import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import {
  encerrarCasal,
  formarCasal,
  registrarDesmame,
  registrarNascimento,
  registrarSelecao,
} from './reproducao.service.ts'

/**
 * Contrato secao 7. Dois routers porque a URL do contrato tem duas raizes -
 * `/api/casais` e `/api/partos` - e um `parto` nao pertence a um `casal` na
 * rota (`RF-CIC-02`: quadro e ficha abrem pelo `idCaixa`/`idParto`, nunca
 * navegando `casal -> parto` na URL).
 *
 * Todas as rotas sao tecnico ou gestor - `RF-ACS-03`, o pesquisador nao
 * enxerga a colonia.
 */
export const casalRoutes = Router()
export const partoRoutes = Router()

const idNaRota = z.object({ id: z.coerce.number().int().positive() })

/** Contrato secao 1: `aaaa-mm-dd`, nunca timestamp para data de calendario. */
const dataCalendario = z.iso.date('Data invalida. Use aaaa-mm-dd.')

const grupoGenetico = z.enum(['A', 'B', 'C', 'D', 'E'])

/**
 * Corpo de `POST /api/casais`. `RN-02` (o par esta na rotacao) e `RF-DEM-02`
 * (linhagem da especie da caixa) sao responsabilidade do servico - o Zod
 * garante so a forma, nao consulta o banco.
 */
export const casalNovo = z.object({
  idCaixa: z.number().int().positive(),
  idLinhagem: z.number().int().positive(),
  grupoMacho: grupoGenetico,
  grupoFemea: grupoGenetico,
  dtFormacao: dataCalendario,
})

casalRoutes.post('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const dados = casalNovo.parse(req.body)

  res.status(201).json(await formarCasal(dados))
})

const encerramento = z.object({
  dtEncerramento: dataCalendario,
  motivo: z.string().trim().min(1).max(200),
})

casalRoutes.post('/:id/encerramento', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = encerramento.parse(req.body)

  res.json(await encerrarCasal(id, dados))
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

/** `idCaixaRecria` nulo e explicito, nunca omitido (contrato secao 1, D-03). */
const desmame = z.object({
  dtDesmameReal: dataCalendario,
  desmamadoM: z.number().int().min(0),
  desmamadoF: z.number().int().min(0),
  idCaixaRecria: z.number().int().positive().nullable(),
})

partoRoutes.post('/:id/desmame', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = desmame.parse(req.body)

  res.json(await registrarDesmame(id, dados, usuarioDaRequisicao(req).id))
})
