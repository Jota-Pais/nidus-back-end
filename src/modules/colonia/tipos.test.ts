import { describe, expect, it } from 'vitest'
import { noNumero, quantosAnimais, quantosDoSexo } from './tipos.ts'

// Como o texto conta animal: toda mensagem e descricao passa por aqui, para nunca sair "1 machos"

describe('como o texto conta animal', () => {
  it('a quantidade de um sexo concorda com o numero', () => {
    expect(quantosDoSexo(1, 'M')).toBe('1 macho')
    expect(quantosDoSexo(2, 'M')).toBe('2 machos')
    expect(quantosDoSexo(1, 'F')).toBe('1 fêmea')
    expect(quantosDoSexo(0, 'F')).toBe('0 fêmeas')
  })

  it('machos e femeas juntos, so o sexo que tem animal', () => {
    expect(quantosAnimais({ m: 2, f: 1 })).toBe('2 machos e 1 fêmea')
    expect(quantosAnimais({ m: 0, f: 3 })).toBe('3 fêmeas')
    expect(quantosAnimais({ m: 1, f: 0 })).toBe('1 macho')
    expect(quantosAnimais({ m: 0, f: 0 })).toBe('nenhum animal')
  })

  it('o verbo concorda com quantos animais', () => {
    expect(noNumero(1, 'voltou', 'voltaram')).toBe('voltou')
    expect(noNumero(0, 'voltou', 'voltaram')).toBe('voltaram')
    expect(noNumero(3, 'voltou', 'voltaram')).toBe('voltaram')
  })
})
