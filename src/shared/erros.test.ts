import { describe, expect, it } from 'vitest'

import { naoEncontrado } from './erros.ts'

describe('naoEncontrado', () => {
  it('concorda com a entidade', () => {
    expect(naoEncontrado('Pedido').message).toBe('Pedido não encontrado.')
    expect(naoEncontrado('Baixa').message).toBe('Baixa não encontrada.')
    expect(naoEncontrado('Caixa 12').message).toBe('Caixa 12 não encontrada.')
  })

  it('responde 404 com o código', () => {
    expect(naoEncontrado('Parto')).toMatchObject({ status: 404, codigo: 'NAO_ENCONTRADO' })
  })
})
