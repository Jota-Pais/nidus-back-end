import { describe, expect, it } from 'vitest'
import { calcularCicloInicial, calcularProximoCiclo, diasEntre } from './cadeiaTemporal.ts'

// gestacao 23d, aleitamento 22d, intervalo 6d (shared/parametros.ts)

describe('ciclo inicial, a partir do acasalamento digitado', () => {
  it('deriva parto e desmame previstos, e o acasalamento e o proprio digitado', () => {
    const ciclo = calcularCicloInicial('2026-05-02')

    expect(ciclo).toEqual({
      dtAcasalamento: '2026-05-02',
      dtPartoPrevisto: '2026-05-25', // +23
      dtDesmamePrevisto: '2026-06-16', // +22
    })
  })

  it('atravessa virada de mes e de ano sem perder dia', () => {
    const ciclo = calcularCicloInicial('2026-12-20')

    expect(ciclo.dtPartoPrevisto).toBe('2027-01-12')
    expect(ciclo.dtDesmamePrevisto).toBe('2027-02-03')
  })
})

describe('proximo ciclo, a partir do parto REAL do anterior', () => {
  it('acasalamento do ciclo n+1 sai do parto real, nao do previsto', () => {
    // Parto real atrasou 3 dias em relacao ao previsto (25/05) - o proximo ciclo tem de
    // partir do que aconteceu, nao do que se esperava
    const ciclo = calcularProximoCiclo('2026-05-28')

    expect(ciclo).toEqual({
      dtAcasalamento: '2026-06-03', // 28/05 + 6
      dtPartoPrevisto: '2026-06-26', // + 23
      dtDesmamePrevisto: '2026-07-18', // + 22
    })
  })

  it('encadear os dois da o mesmo resultado que calcular tudo de uma vez', () => {
    const ciclo1 = calcularCicloInicial('2026-05-02')
    const ciclo2 = calcularProximoCiclo(ciclo1.dtPartoPrevisto)

    // Sem atraso: parto real == previsto, entao encadear reproduz a mesma conta
    // que fazer a mao a partir do primeiro acasalamento
    expect(ciclo2.dtAcasalamento).toBe('2026-05-31')
  })
})

describe('dias entre duas datas', () => {
  it('e a idade em dias: o mesmo dia e zero, e atravessa mes e ano', () => {
    expect(diasEntre('2026-11-08', '2026-11-08')).toBe(0)
    expect(diasEntre('2026-10-30', '2026-11-08')).toBe(9)
    expect(diasEntre('2026-12-31', '2027-01-01')).toBe(1)
    expect(diasEntre('2026-11-08', '2026-11-01')).toBe(-7)
  })
})
