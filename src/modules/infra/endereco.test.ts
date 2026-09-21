import { describe, expect, it } from 'vitest'
import { LETRAS_DISPONIVEIS, codigoDaPosicao, letraDaPosicao, letrasNecessarias } from './endereco.ts'

describe('endereco da posicao - RF-INF-02', () => {
  it('gera letra = coluna, numero = linha', () => {
    expect(codigoDaPosicao(1, 1, 1, 8)).toBe('A1')
    expect(codigoDaPosicao(1, 3, 3, 8)).toBe('C3')
    expect(codigoDaPosicao(1, 8, 1, 8)).toBe('A8')
  })

  it('continua a sequencia de letras na traseira: ALESCO M1 e A-H e I-P', () => {
    const letras = (face: number) =>
      Array.from({ length: 8 }, (_, i) => letraDaPosicao(face, i + 1, 8))

    expect(letras(1).join('')).toBe('ABCDEFGH')
    expect(letras(2).join('')).toBe('IJKLMNOP')
  })

  it('acompanha a topologia estreita: TECNIPLAST M1 e 8 x 7, A-G e H-N', () => {
    // E esta contagem que sustenta a suposicao do CONF-07: sete letras para
    // sete colunas. Se a letra fosse a linha, seriam oito
    const letras = (face: number) =>
      Array.from({ length: 7 }, (_, i) => letraDaPosicao(face, i + 1, 7)).join('')

    expect(letras(1)).toBe('ABCDEFG')
    expect(letras(2)).toBe('HIJKLMN')
  })

  it('nenhuma letra aparece nas duas faces - a face nao e sufixo', () => {
    const daFace = (face: number) =>
      new Set(Array.from({ length: 5 }, (_, i) => letraDaPosicao(face, i + 1, 5)))

    const frontal = daFace(1)
    const traseira = daFace(2)

    expect([...frontal].filter((letra) => traseira.has(letra))) .toEqual([])
  })

  it('CONF-07: trocar o eixo da letra troca o endereco, e so isso', () => {
    // O teste que prova o isolamento. Linha 1, coluna 2 e 'B1' hoje; se o
    // cliente responder que a letra e a linha, o mesmo ponto vira 'A2'
    expect(codigoDaPosicao(1, 1, 2, 8)).toBe('B1')
    expect(codigoDaPosicao(1, 2, 1, 8)).toBe('A2')
  })

  it('falha alto quando a topologia estoura o alfabeto', () => {
    expect(() => letraDaPosicao(2, 14, 14)).toThrow(/sem letra disponivel/)
    expect(letrasNecessarias(2, 14)).toBeGreaterThan(LETRAS_DISPONIVEIS)
    expect(letrasNecessarias(2, 8)).toBe(16)
  })
})
