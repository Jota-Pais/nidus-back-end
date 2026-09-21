// sessao em memoria - decisao de implementacao do card, registrada aqui.

import { randomBytes } from 'node:crypto'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'

/** Nome do cookie - contrato secao 1.2. Uma fonte so, para rota e middleware nao divergirem */
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
