import { describe, expect, it } from 'vitest'
import {
  type ContagemDoCiclo,
  calcularDisponibilidade,
  calcularGrauCerteza,
  ofertaBruta,
} from './disponibilidade.ts'

const nada = { m: 0, f: 0 }

/** Um ciclo em que nada aconteceu, com o que se quiser sobrescrito. */
const ciclo = (parcial: Partial<ContagemDoCiclo> = {}): ContagemDoCiclo => ({
  nascidoM: null,
  nascidoF: null,
  eutanasiadoM: null,
  eutanasiadoF: null,
  desmamadoM: null,
  desmamadoF: null,
  ...parcial,
})

const projetado = ciclo()
const previsto = ciclo({ nascidoM: 5, nascidoF: 6, eutanasiadoM: 1, eutanasiadoF: 2 })
const confirmado = ciclo({
  nascidoM: 5,
  nascidoF: 6,
  eutanasiadoM: 1,
  eutanasiadoF: 2,
  desmamadoM: 4,
  desmamadoF: 4,
})

describe('os tres niveis do COALESCE', () => {
  it('projetado: nada nasceu, a oferta e a expectativa', () => {
    expect(calcularGrauCerteza(projetado)).toBe('projetado')
    expect(ofertaBruta(projetado)).toEqual({ m: 4, f: 4 })
  })

  it('previsto: nasceu, a oferta e nascido menos eutanasiado', () => {
    expect(calcularGrauCerteza(previsto)).toBe('previsto')
    expect(ofertaBruta(previsto)).toEqual({ m: 4, f: 4 })
  })

  it('confirmado: desmamou, a oferta e a contagem real', () => {
    expect(calcularGrauCerteza(confirmado)).toBe('confirmado')
    expect(ofertaBruta(confirmado)).toEqual({ m: 4, f: 4 })
  })

  it('desmamado manda sobre nascido, mesmo quando os numeros divergem', () => {
    // Mortalidade entre o parto e o desmame: a contagem real e menor que a ninhada que
    // nasceu e e a real que vale.
    const comPerda = ciclo({ nascidoM: 6, nascidoF: 6, desmamadoM: 2, desmamadoF: 3 })

    expect(ofertaBruta(comPerda)).toEqual({ m: 2, f: 3 })
    expect(calcularGrauCerteza(comPerda)).toBe('confirmado')
  })
})

describe('selecao ausente conta zero, nao nulo', () => {
  it('ninhada nascida sem selecao registrada mantem a oferta real', () => {
    // O erro que a leitura literal da formula produz: 'nascido - eutanasiado' com
    // eutanasiado nulo vira NULO em SQL, e a oferta cairia para a expectativa PROJETADA de
    // uma ninhada que ja nasceu. O trigger do banco decidiu contar zero; aqui e igual, de
    // proposito
    const semSelecao = ciclo({ nascidoM: 7, nascidoF: 2 })

    expect(ofertaBruta(semSelecao)).toEqual({ m: 7, f: 2 })
    expect(calcularGrauCerteza(semSelecao)).toBe('previsto')
  })
})

describe('disponibilidade liquida', () => {
  it('parto com 4M desmamados e 2M comprometidos devolve 2M e confirmado', () => {
    const resultado = calcularDisponibilidade(confirmado, { m: 2, f: 0 })

    expect(resultado.disponivel.m).toBe(2)
    expect(resultado.grauCerteza).toBe('confirmado')
  })

  it('separa oferta bruta de disponivel liquido', () => {
    // Os dois numeros existem separados porque o teto do compromisso e a oferta BRUTA.
    // Confundir os dois faz o limite valer metade
    const resultado = calcularDisponibilidade(confirmado, { m: 2, f: 1 })

    expect(resultado.oferta).toEqual({ m: 4, f: 4 })
    expect(resultado.comprometido).toEqual({ m: 2, f: 1 })
    expect(resultado.disponivel).toEqual({ m: 2, f: 3 })
  })

  it('oferta toda comprometida deixa zero, e nao numero negativo', () => {
    const resultado = calcularDisponibilidade(confirmado, { m: 4, f: 4 })

    expect(resultado.disponivel).toEqual({ m: 0, f: 0 })
  })

  it('nunca devolve negativo, mesmo com registro corrigido para menos', () => {
    // Correcao de registro pode vir depois do compromisso firmado. A tela tem
    // de ler "nada disponivel", nao "-2 machos".
    const corrigido = ciclo({ nascidoM: 5, nascidoF: 5, desmamadoM: 2, desmamadoF: 2 })
    const resultado = calcularDisponibilidade(corrigido, { m: 4, f: 4 })

    expect(resultado.disponivel).toEqual({ m: 0, f: 0 })
    expect(resultado.oferta).toEqual({ m: 2, f: 2 })
  })

  it('sem compromisso, disponivel e a oferta inteira', () => {
    expect(calcularDisponibilidade(projetado, nada).disponivel).toEqual({ m: 4, f: 4 })
  })
})
