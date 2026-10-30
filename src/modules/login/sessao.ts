// sessao em memoria: quando o processo reinicia, todo mundo loga de novo.

import { randomBytes } from 'node:crypto'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'

/** Nome do cookie. Uma fonte so, para rota e middleware nao divergirem */
export const NOME_COOKIE = 'nidus_sessao'

const sessoes = new Map<string, UsuarioDaSessao>()

/** Cria a sessao e devolve o ID que vai no cookie 'nidus_sessao'. */
export function criarSessao(usuario: UsuarioDaSessao): string {
  const id = randomBytes(32).toString('hex')
  sessoes.set(id, usuario)
  return id
}

/** O usuario da sessao, ou undefined se o ID nao existe (nunca existiu ou foi revogado) */
export function sessaoValida(id: string): UsuarioDaSessao | undefined {
  return sessoes.get(id)
}

/** DELETE /api/sessao - revogacao real: some do 'Map', nao so expira. */
export function revogarSessao(id: string): void {
  sessoes.delete(id)
}

/**
 * Revoga todas as sessoes do usuario, em qualquer aparelho, e devolve quantas eram. E o que a
 * troca de senha faz antes de abrir a sessao nova: quem entrou com a senha antiga sai
 */
export function revogarSessoesDoUsuario(idUsuario: number): number {
  let revogadas = 0

  for (const [id, usuario] of sessoes) {
    if (usuario.id === idUsuario) {
      sessoes.delete(id)
      revogadas++
    }
  }

  return revogadas
}
