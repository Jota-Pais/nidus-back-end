// RF-ACS-02: **autorizacao decidida no servidor, sempre.**
//
// O front pode esconder um botao por conveniencia, mas nunca autoriza. Toda
// rota do contrato declara o perfil exigido, e e este arquivo que cobra.
//
// Separado da autenticacao de proposito: autenticar e descobrir QUEM e (le o
// cookie de sessao), autorizar e decidir SE ALCANCA (le o perfil). Sao dois
// motivos de mudanca diferentes - o primeiro muda quando o SSO do ID-UFSC
// entrar (PEN-09), o segundo nao.

import type { RequestHandler } from 'express'
import { naoAutenticado, semPermissao } from '../erros.ts'
import type { Perfil } from '../traducao.ts'

/** O usuario da requisicao, no vocabulario da API - `perfil` ja traduzido. */
export type UsuarioDaSessao = {
  id: number
  nome: string
  email: string
  perfil: Perfil
}

/**
 * Exige sessao valida e um dos perfis. Sem perfil na lista, exige so a sessao.
 *
 * A ordem das duas recusas segue a tabela 2.1 do contrato e nao e permutavel:
 * **401 quando nao ha sessao, 403 quando ha sessao e o perfil nao alcanca.**
 * Trocar isso conta a quem nao esta logado que o recurso existe.
 */
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
 * O usuario da requisicao, para uso DENTRO de rota que ja passou por
 * `exigirPerfil`. Estreita o tipo sem `as` e sem `!`.
 *
 * Se estourar, o erro e de montagem da rota - alguem esqueceu o middleware -,
 * e cai como 500 no log do servidor, que e onde bug nosso deve aparecer.
 */
export function usuarioDaRequisicao(req: { usuario?: UsuarioDaSessao }): UsuarioDaSessao {
  const usuario = req.usuario

  if (usuario === undefined) {
    throw new Error('Rota sem exigirPerfil: req.usuario nao foi preenchido.')
  }

  return usuario
}

/**
 * Perfis que operam a colonia. E a lista que quase toda rota de infraestrutura
 * e de reproducao repete no contrato ("tecnico, gestor"), e o pesquisador fica
 * fora por desenho: `RF-ACS-03` diz que ele **nao enxerga a colonia** - recebe
 * menos dados, nao os mesmos dados filtrados no cliente.
 */
export const OPERA_A_COLONIA: Perfil[] = ['tecnico', 'gestor']
