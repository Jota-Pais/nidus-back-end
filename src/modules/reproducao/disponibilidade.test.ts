import { describe, expect, it } from 'vitest'
import {
  type ContagemDoCiclo,
  type ParametroVigente,
  calcularDisponibilidade,
  calcularGrauCerteza,
  expectativaNaData,
  ofertaBruta,
  parametroNaData,
} from './disponibilidade.ts'

const expectativa = { m: 4, f: 4 }
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
    expect(ofertaBruta(projetado, expectativa)).toEqual({ m: 4, f: 4 })
  })

  it('previsto: nasceu, a oferta e nascido menos eutanasiado', () => {
    expect(calcularGrauCerteza(previsto)).toBe('previsto')
    expect(ofertaBruta(previsto, expectativa)).toEqual({ m: 4, f: 4 })
  })

  it('confirmado: desmamou, a oferta e a contagem real', () => {
    expect(calcularGrauCerteza(confirmado)).toBe('confirmado')
    expect(ofertaBruta(confirmado, expectativa)).toEqual({ m: 4, f: 4 })
  })

  it('desmamado manda sobre nascido, mesmo quando os numeros divergem', () => {
    // Mortalidade entre o parto e o desmame: a contagem real e menor que a ninhada que
    // nasceu e e a real que vale.
    const comPerda = ciclo({ nascidoM: 6, nascidoF: 6, desmamadoM: 2, desmamadoF: 3 })

    expect(ofertaBruta(comPerda, expectativa)).toEqual({ m: 2, f: 3 })
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

    expect(ofertaBruta(semSelecao, expectativa)).toEqual({ m: 7, f: 2 })
    expect(calcularGrauCerteza(semSelecao)).toBe('previsto')
  })
})

describe('disponibilidade liquida', () => {
  it('parto com 4M desmamados e 2M comprometidos devolve 2M e confirmado', () => {
    // O caso escrito no card, palavra por palavra
    const resultado = calcularDisponibilidade(confirmado, {
      expectativa,
      comprometido: { m: 2, f: 0 },
    })

    expect(resultado.disponivel.m).toBe(2)
    expect(resultado.grauCerteza).toBe('confirmado')
  })

  it('separa oferta bruta de disponivel liquido', () => {
    // Os dois numeros existem separados porque o teto do compromisso e a oferta BRUTA.
    // Confundir os dois faz o limite valer metade
    const resultado = calcularDisponibilidade(confirmado, {
      expectativa,
      comprometido: { m: 2, f: 1 },
    })

    expect(resultado.oferta).toEqual({ m: 4, f: 4 })
    expect(resultado.comprometido).toEqual({ m: 2, f: 1 })
    expect(resultado.disponivel).toEqual({ m: 2, f: 3 })
  })

  it('oferta toda comprometida deixa zero, e nao numero negativo', () => {
    const resultado = calcularDisponibilidade(confirmado, {
      expectativa,
      comprometido: { m: 4, f: 4 },
    })

    expect(resultado.disponivel).toEqual({ m: 0, f: 0 })
  })

  it('nunca devolve negativo, mesmo com registro corrigido para menos', () => {
    // Correcao de registro pode vir depois do compromisso firmado. A tela tem
    // de ler "nada disponivel", nao "-2 machos".
    const corrigido = ciclo({ nascidoM: 5, nascidoF: 5, desmamadoM: 2, desmamadoF: 2 })
    const resultado = calcularDisponibilidade(corrigido, {
      expectativa,
      comprometido: { m: 4, f: 4 },
    })

    expect(resultado.disponivel).toEqual({ m: 0, f: 0 })
    expect(resultado.oferta).toEqual({ m: 2, f: 2 })
  })

  it('sem compromisso, disponivel e a oferta inteira', () => {
    expect(calcularDisponibilidade(projetado, { expectativa, comprometido: nada }).disponivel)
      .toEqual({ m: 4, f: 4 })
  })
})

describe('expectativa vem do parametro vigente, nao de constante', () => {
  const parametros: ParametroVigente[] = [
    // vigência encerrada: valia até abril, com expectativa menor
    {
      idLinhagem: null,
      expectativaM: 3,
      expectativaF: 3,
      dtVigenciaInicio: '2026-01-01',
      dtVigenciaFim: '2026-04-30',
    },
    // vigente hoje, para a espécie inteira
    {
      idLinhagem: null,
      expectativaM: 4,
      expectativaF: 4,
      dtVigenciaInicio: '2026-05-01',
      dtVigenciaFim: null,
    },
    // Específico de uma linhagem: manda sobre o da espécie.
    {
      idLinhagem: 7,
      expectativaM: 6,
      expectativaF: 5,
      dtVigenciaInicio: '2026-05-01',
      dtVigenciaFim: null,
    },
  ]

  it('parto sem nascimento usa a expectativa do parametro, e nao 4 e 4 no codigo', () => {
    const daLinhagem = expectativaNaData(parametros, { idLinhagem: 7, em: '2026-09-10' })

    expect(daLinhagem).toEqual({ m: 6, f: 5 })
    expect(ofertaBruta(projetado, daLinhagem)).toEqual({ m: 6, f: 5 })
  })

  it('linhagem sem parametro proprio cai no da especie', () => {
    expect(expectativaNaData(parametros, { idLinhagem: 3, em: '2026-09-10' })).toEqual({
      m: 4,
      f: 4,
    })
  })

  it('calculo de data passada reproduz o parametro daquela epoca', () => {
    // O coracao do versionamento. Filtrar por 'dtVigenciaFim: null' devolveria 4 e
    // 4, que e a resposta de hoje - e a errada para recalcular algo de
    // marco.
    expect(expectativaNaData(parametros, { idLinhagem: null, em: '2026-03-15' })).toEqual({
      m: 3,
      f: 3,
    })
  })

  it('ignora parametro que comeca depois da data pedida', () => {
    expect(parametroNaData(parametros, { idLinhagem: 7, em: '2026-02-01' })?.expectativaM).toBe(3)
  })

  it('estoura em vez de palpitar quando nao ha parametro', () => {
    expect(() => expectativaNaData([], { idLinhagem: null, em: '2026-09-10' })).toThrow(
      /Sem parametro_biologico vigente/,
    )
  })
})
