import { describe, expect, it } from 'vitest'
import { criarSessao, revogarSessao, revogarSessoesDoUsuario, sessaoValida } from './sessao.ts'

const usuario = { id: 1, nome: 'Ana Souza', email: 'tecnico@ufsc.br', perfil: 'tecnico' as const }
// So o ultimo teste usa estes dois: as sessoes dos testes de cima continuam no 'Map'
const gestor = { id: 2, nome: 'Carlos Mendes', email: 'gestor@ufsc.br', perfil: 'gestor' as const }
const pesquisador = {
  id: 3,
  nome: 'Beatriz Lima',
  email: 'pesquisador@ufsc.br',
  perfil: 'pesquisador' as const,
}

describe('sessao em memoria', () => {
  it('devolve o usuario para um ID de sessao criado', () => {
    const id = criarSessao(usuario)

    expect(sessaoValida(id)).toEqual(usuario)
  })

  it('ID que nunca existiu nao valida', () => {
    expect(sessaoValida('id-que-nunca-existiu')).toBeUndefined()
  })

  it('revogar e revogacao real - some, nao so expira', () => {
    const id = criarSessao(usuario)
    revogarSessao(id)

    expect(sessaoValida(id)).toBeUndefined()
  })

  it('duas sessoes do mesmo usuario tem IDs diferentes e nao se cancelam', () => {
    const idA = criarSessao(usuario)
    const idB = criarSessao(usuario)

    revogarSessao(idA)

    expect(sessaoValida(idA)).toBeUndefined()
    expect(sessaoValida(idB)).toEqual(usuario)
  })

  it('revogar as sessoes do usuario derruba todas as dele, e so as dele', () => {
    const doGestor = [criarSessao(gestor), criarSessao(gestor), criarSessao(gestor)]
    const doOutro = criarSessao(pesquisador)

    expect(revogarSessoesDoUsuario(gestor.id)).toBe(3)

    for (const id of doGestor) expect(sessaoValida(id)).toBeUndefined()
    expect(sessaoValida(doOutro)).toEqual(pesquisador)
    expect(revogarSessoesDoUsuario(gestor.id)).toBe(0)
  })
})
