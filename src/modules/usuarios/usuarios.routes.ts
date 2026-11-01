import { Router } from 'express'
import { z } from 'zod'
import { exigirPerfil, usuarioDaRequisicao } from '../../shared/middlewares/autorizacao.ts'
import { perfil } from '../../shared/traducao.ts'
import {
  alterarUsuario,
  criarUsuario,
  definirSenhaDoUsuario,
  listarUsuarios,
} from './usuarios.service.ts'

export const usuarioRoutes = Router()

const idNaRota = z.object({ id: z.coerce.number().int().positive() })

const senha = z.string().min(8, 'A senha precisa de pelo menos 8 caracteres.').max(72)

export const usuarioNovo = z.object({
  nome: z.string().trim().min(1).max(120),
  email: z.email('E-mail invalido.').trim().max(160),
  perfil: z.enum(perfil.termos),
  senha,
})

export const alteracaoDeUsuario = z
  .object({
    nome: z.string().trim().min(1).max(120).optional(),
    perfil: z.enum(perfil.termos).optional(),
    ativo: z.boolean().optional(),
  })
  .refine((dados) => Object.values(dados).some((valor) => valor !== undefined), {
    path: ['nome'],
    error: 'Informe o que alterar.',
  })

usuarioRoutes.get('/', exigirPerfil('gestor'), async (_req, res) => {
  res.json(await listarUsuarios())
})

usuarioRoutes.post('/', exigirPerfil('gestor'), async (req, res) => {
  const dados = usuarioNovo.parse(req.body)

  res.status(201).json(await criarUsuario(dados, usuarioDaRequisicao(req)))
})

usuarioRoutes.patch('/:id', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = alteracaoDeUsuario.parse(req.body)

  res.json(await alterarUsuario(id, dados, usuarioDaRequisicao(req)))
})

usuarioRoutes.post('/:id/senha', exigirPerfil('gestor'), async (req, res) => {
  const { id } = idNaRota.parse(req.params)
  const dados = z.object({ senha }).parse(req.body)

  res.json(await definirSenhaDoUsuario(id, dados.senha, usuarioDaRequisicao(req)))
})
