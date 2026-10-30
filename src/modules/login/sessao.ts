// sessao em memoria: quando o processo reinicia, todo mundo loga de novo.

import { randomBytes } from 'node:crypto'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'

/** Nome do cookie. Uma fonte so, para rota e middleware nao divergirem */
export const NOME_COOKIE = 'nidus_sessao'

const sessoes = new Map<string, UsuarioDaSessao>()

/**
 * Um contador, nao um relogio: aqui so importa a ordem. Ele nunca empata e nunca volta, e o
 * relogio do sistema volta num acerto de hora
 */
let ultimaMarca = 0

/** A marca de agora na ordem das revogacoes: toda marca nova e maior que as anteriores */
export function novaMarca(): number {
  ultimaMarca += 1
  return ultimaMarca
}

/**
 * A marca da ultima revogacao das sessoes de cada usuario. O login que comecou antes dela pode
 * ter conferido a senha antiga, e nao abre sessao (ver 'revogadasDesde')
 */
const revogadasEm = new Map<number, number>()

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
 * troca de senha faz antes de abrir a sessao nova: quem entrou com a senha antiga sai. A marca
 * fica guardada para o login que ainda estava conferindo a senha antiga
 */
export function revogarSessoesDoUsuario(idUsuario: number): number {
  revogadasEm.set(idUsuario, novaMarca())
  let revogadas = 0

  for (const [id, usuario] of sessoes) {
    if (usuario.id === idUsuario) {
      sessoes.delete(id)
      revogadas++
    }
  }

  return revogadas
}

/**
 * Se as sessoes do usuario foram revogadas depois da 'marca'. O login le a senha e passa
 * segundos no bcrypt: se a senha muda nesse meio tempo, ele termina depois da revogacao com a
 * senha antiga conferida, e a sessao dele escaparia
 */
export function revogadasDesde(idUsuario: number, marca: number): boolean {
  const revogadaEm = revogadasEm.get(idUsuario)

  return revogadaEm !== undefined && revogadaEm > marca
}
