import { describe, expect, it } from 'vitest'
import { LETRAS_DISPONIVEIS, codigoDaPosicao, letraDaPosicao, letrasNecessarias } from './endereco.ts'

describe('endereco da posicao', () => {
  it('segue a spec do cliente: face, linha e letra da coluna', () => {
    expect(codigoDaPosicao(1, 1, 1, 8)).toBe('F1A')
    expect(codigoDaPosicao(1, 3, 3, 8)).toBe('F3C')
    expect(codigoDaPosicao(2, 1, 3, 8)).toBe('T1K')
  })

  it('continua a sequencia de letras na traseira: ALESCO M1 e A-H e I-P', () => {
    const letras = (face: number) =>
      Array.from({ length: 8 }, (_, i) => letraDaPosicao(face, i + 1, 8)).join('')

    expect(letras(1)).toBe('ABCDEFGH')
    expect(letras(2)).toBe('IJKLMNOP')
  })

  it('acompanha a topologia estreita: TECNIPLAST M1 e 8 x 7, A-G e H-N', () => {
    const letras = (face: number) =>
      Array.from({ length: 7 }, (_, i) => letraDaPosicao(face, i + 1, 7)).join('')

    expect(letras(1)).toBe('ABCDEFG')
    expect(letras(2)).toBe('HIJKLMN')
  })

  it('falha alto quando a topologia estoura o alfabeto', () => {
    expect(() => letraDaPosicao(2, 14, 14)).toThrow(/sem letra disponivel/)
    expect(letrasNecessarias(2, 14)).toBeGreaterThan(LETRAS_DISPONIVEIS)
    expect(letrasNecessarias(2, 8)).toBe(16)
  })
})
