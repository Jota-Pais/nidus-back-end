import { describe, expect, it } from 'vitest'
import {
  type ContagemDoCiclo,
  calcularDisponibilidade,
  calcularGrauCerteza,
  disponibilidadeDoParto,
  faltaNaReserva,
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
  it('nada nasceu: nao ha animal nenhum', () => {
    expect(calcularGrauCerteza(projetado)).toBe('J')
    expect(ofertaBruta(projetado)).toEqual({ m: 0, f: 0 })
  })

  it('previsto: nasceu, a oferta e nascido menos eutanasiado', () => {
    expect(calcularGrauCerteza(previsto)).toBe('P')
    expect(ofertaBruta(previsto)).toEqual({ m: 4, f: 4 })
  })

  it('confirmado: desmamou, a oferta e a contagem real', () => {
    expect(calcularGrauCerteza(confirmado)).toBe('C')
    expect(ofertaBruta(confirmado)).toEqual({ m: 4, f: 4 })
  })

  it('desmamado manda sobre nascido, mesmo quando os numeros divergem', () => {
    // Mortalidade entre o parto e o desmame: a contagem real e menor que a ninhada que
    // nasceu e e a real que vale.
    const comPerda = ciclo({ nascidoM: 6, nascidoF: 6, desmamadoM: 2, desmamadoF: 3 })

    expect(ofertaBruta(comPerda)).toEqual({ m: 2, f: 3 })
    expect(calcularGrauCerteza(comPerda)).toBe('C')
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
    expect(calcularGrauCerteza(semSelecao)).toBe('P')
  })
})

describe('disponibilidade liquida', () => {
  it('parto com 4M desmamados e 2M comprometidos devolve 2M', () => {
    const resultado = calcularDisponibilidade(confirmado, { m: 2, f: 0 })

    expect(resultado.disponivel.m).toBe(2)
  })

  it('separa oferta bruta de disponivel liquido', () => {
    // Os dois numeros existem separados porque o teto do compromisso e a oferta BRUTA.
    // Confundir os dois faz o limite valer metade
    const resultado = calcularDisponibilidade(confirmado, { m: 2, f: 1 })

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
    expect(ofertaBruta(corrigido)).toEqual({ m: 2, f: 2 })
  })

  it('sem compromisso, disponivel e a oferta inteira', () => {
    expect(calcularDisponibilidade(previsto, nada).disponivel).toEqual({ m: 4, f: 4 })
  })
})

describe('disponibilidade do parto lido do banco', () => {
  it('soma os compromissos do parto e desconta da oferta', () => {
    const parto = { ...previsto, compromissos: [{ qtdM: 2, qtdF: 1 }, { qtdM: 1, qtdF: 1 }] }

    expect(disponibilidadeDoParto(parto).comprometido).toEqual({ m: 3, f: 2 })
    expect(disponibilidadeDoParto(parto).disponivel).toEqual({ m: 1, f: 2 })
  })

  it('parto sem compromisso tem a oferta inteira livre', () => {
    expect(disponibilidadeDoParto({ ...confirmado, compromissos: [] }).disponivel).toEqual({ m: 4, f: 4 })
  })
})

describe('reserva em falta', () => {
  const reserva = (idSolicitacao: number, qtdM: number, qtdF: number) => ({ qtdM, qtdF, remessa: { idSolicitacao } })

  it('parto que ainda nao nasceu nao tem ninhada para faltar', () => {
    expect(faltaNaReserva({ ...projetado, compromissos: [reserva(1, 4, 4)] })).toBeNull()
  })

  it('soma o reservado de cada pedido e diz quanto passa do que a ninhada tem', () => {
    // confirmado: 4 M e 5 F desmamados
    const parto = { ...confirmado, compromissos: [reserva(9, 3, 1), reserva(4, 2, 0), reserva(9, 0, 2)] }

    expect(faltaNaReserva(parto)).toEqual({
      m: 1,
      f: 0,
      pedidos: [
        { idSolicitacao: 4, m: 2, f: 0 },
        { idSolicitacao: 9, m: 3, f: 3 },
      ],
    })
  })
})
