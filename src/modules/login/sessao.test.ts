import { describe, expect, it } from 'vitest'
import { criarSessao, revogarSessao, sessaoValida } from './sessao.ts'

const usuario = { id: 1, nome: 'Ana Souza', email: 'tecnico@ufsc.br', perfil: 'tecnico' as const }

describe('sessao em memoria', () => {
  it('devolve o usuario para um ID de sessao criado', () => {
    const id = criarSessao(usuario)

    expect(sessaoValida(id)).toEqual(usuario)
  })

  it('ID que nunca existiu nao valida', () => {
    expect(sessaoValida('id-que-nunca-existiu')).toBeUndefined()
  })

  it('revogar e a revogacao real que decisoes-de-stack.md pede - some, nao so expira', () => {
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
})
