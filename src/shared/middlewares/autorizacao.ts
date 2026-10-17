// Autorizacao decidida no servidor, sempre

import type { RequestHandler } from 'express'
import { naoAutenticado, semPermissao } from '../erros.ts'
import type { Perfil } from '../traducao.ts'

/** O usuario da requisicao, no vocabulario da API - perfil ja traduzido */
export type UsuarioDaSessao = {
  id: number
  nome: string
  email: string
  perfil: Perfil
}

/** Exige sessao valida e um dos perfis. Sem perfil na lista, exige so a sessao. */
export function exigirPerfil(...perfisAceitos: Perfil[]): RequestHandler {
  return (req, _res, next) => {
    const usuario = req.usuario

    if (usuario === undefined) {
      next(naoAutenticado())
      return
    }

    if (perfisAceitos.length > 0 && !perfisAceitos.includes(usuario.perfil)) {
      next(semPermissao())
      return
    }

    next()
  }
}

/**
 * O usuario da requisicao, para uso DENTRO de rota que ja passou por 'exigirPerfil'.
 * Estreita o tipo sem as e sem '!'.
 */
export function usuarioDaRequisicao(req: { usuario?: UsuarioDaSessao }): UsuarioDaSessao {
  const usuario = req.usuario

  if (usuario === undefined) {
    throw new Error('Rota sem exigirPerfil: req.usuario nao foi preenchido.')
  }

  return usuario
}

/**
 * Perfis que operam a colonia. E a lista que quase toda rota de infraestrutura e de
 * reproducao repete ("tecnico, gestor"), e o pesquisador fica fora por
 * desenho: ele nao enxerga a colonia - recebe menos dados, nao os
 * mesmos dados filtrados no cliente.
 */
export const OPERA_A_COLONIA: Perfil[] = ['tecnico', 'gestor']
