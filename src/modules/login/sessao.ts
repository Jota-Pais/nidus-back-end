// Sessao em memoria - decisao de implementacao do card, registrada aqui.
//
// `decisoes-de-stack.md` §2.1 fechou "cookie de sessao httpOnly" contra JWT
// pelo motivo explicito de **revogacao real**: logout apaga do lado do
// servidor. Um cookie assinado (JWT ou `cookie-session`) nao entrega isso -
// so um registro do lado do servidor que o logout pode apagar entrega.
//
// Nao ha tabela de sessao nas 14 do MVP (`modelo-de-dados.md` §4), e criar
// uma e mudanca de schema que "e pedida ao responsavel pelo banco, nao feita
// direto" (`decisoes-de-stack.md` §1.2) - fora do escopo deste card. Por
// isso a sessao vive num `Map` do processo: mais simples que negociar
// migration nova, e o preco aceito e que a Render reinicia por inatividade
// (~15min, `decisoes-de-stack.md` §1.3) e todo mundo loga de novo depois -
// que e exatamente o mesmo acordo ja aceito para a API dormir.
//
// O valor do cookie e o ID em si: aleatorio, imprevisivel
// (`crypto.randomBytes`, nao sequencial), o suficiente para nao precisar de
// assinatura por cima.

import { randomBytes } from 'node:crypto'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'

/** Nome do cookie - contrato secao 1.2. Uma fonte so, para rota e middleware nao divergirem. */
export const NOME_COOKIE = 'nidus_sessao'

const sessoes = new Map<string, UsuarioDaSessao>()

/** Cria a sessao e devolve o ID que vai no cookie `nidus_sessao`. */
export function criarSessao(usuario: UsuarioDaSessao): string {
  const id = randomBytes(32).toString('hex')
  sessoes.set(id, usuario)
  return id
}

/** O usuario da sessao, ou `undefined` se o ID nao existe (nunca existiu ou foi revogado). */
export function sessaoValida(id: string): UsuarioDaSessao | undefined {
  return sessoes.get(id)
}

/** `DELETE /api/sessao` - revogacao real: some do `Map`, nao so expira. */
export function revogarSessao(id: string): void {
  sessoes.delete(id)
}
