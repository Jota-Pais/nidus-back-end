import { Router } from 'express'
import { z } from 'zod'
import {
  OPERA_A_COLONIA,
  exigirPerfil,
  usuarioDaRequisicao,
} from '../../shared/middlewares/autorizacao.ts'
import { idNaRota } from '../../shared/validacao.ts'
import { COLUNAS_SEM_LETRA, LETRAS_DISPONIVEIS, letrasNecessarias } from './endereco.ts'
import { alterarFormato, cadastrarFormato, listarFormatos, removerFormato } from './formato.service.ts'

/** /api/formatos - as medidas dos modelos de estante. Quem opera a colonia le e escreve */
export const formatoRoutes = Router()

const nome = z.string().trim().min(1).max(60)
const faces = z.number().int().min(1).max(2)
const linhas = z.number().int().min(1).max(26)
const colunas = z.number().int().min(1).max(26)

/** corpo do cadastro: o nome e as medidas, que tem de caber nas letras do endereco */
export const formatoNovo = z
  .object({ nome, faces, linhas, colunas })
  // a traseira continua as letras da frontal: sem isto, a grade ficaria sem letra para as colunas
  .refine((dados) => letrasNecessarias(dados.faces, dados.colunas) <= LETRAS_DISPONIVEIS, {
    path: ['colunas'],
    error: COLUNAS_SEM_LETRA,
  })

/**
 * corpo da edicao: o nome e as medidas, ao menos um. Faces x colunas fica com o servico, que
 * combina o que vem com o que o formato ja tem
 */
export const alteracaoDeFormato = z
  .object({
    nome: nome.optional(),
    faces: faces.optional(),
    linhas: linhas.optional(),
    colunas: colunas.optional(),
  })
  .refine((dados) => Object.values(dados).some((valor) => valor !== undefined), {
    path: ['nome'],
    error: 'Informe o que alterar.',
  })

formatoRoutes.get('/', exigirPerfil(...OPERA_A_COLONIA), async (_req, res) => {
  res.json(await listarFormatos())
})

formatoRoutes.post('/', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const dados = formatoNovo.parse(req.body)

  res.status(201).json(await cadastrarFormato(dados, usuarioDaRequisicao(req).id))
})

/** PATCH /api/formatos/:id - mudar as medidas muda todas as estantes do formato */
formatoRoutes.patch('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = alteracaoDeFormato.parse(req.body)

  res.json(await alterarFormato(id, dados, usuarioDaRequisicao(req).id))
})

/** DELETE /api/formatos/:id - so o formato que nenhuma estante ativa usa */
formatoRoutes.delete('/:id', exigirPerfil(...OPERA_A_COLONIA), async (req, res) => {
  const { id } = idNaRota.parse(req.params)

  await removerFormato(id, usuarioDaRequisicao(req).id)
  res.status(204).send()
})
