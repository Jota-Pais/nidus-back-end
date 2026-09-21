import { describe, expect, it } from 'vitest'
import { type CicloParaEvento, calcularProximoEvento, somarDias } from './proximoEvento.ts'

const contexto = { maxCiclos: 5, intervaloCicloDias: 6, hoje: '2026-09-10' }

/** Ciclo do exemplo da secao 6 do contrato, com o que se quiser sobrescrito */
const ciclo = (parcial: Partial<CicloParaEvento> = {}): CicloParaEvento => ({
  ordem: 1,
  dtPartoPrevisto: '2026-09-25',
  dtPartoReal: null,
  dtDesmamePrevisto: '2026-10-17',
  dtDesmameReal: null,
  ...parcial,
})

describe('proximo evento do ciclo - RF-REP-07', () => {
  it('cobra o parto enquanto ele nao for confirmado', () => {
    expect(calcularProximoEvento(ciclo(), contexto)).toEqual({
      tipo: 'parto_previsto',
      data: '2026-09-25',
      atrasado: false,
    })
  })

  it('marca atrasado quando a previsao passou sem confirmacao', () => {
    // O alerta que o contrato manda o front fazer gritar
    expect(
      calcularProximoEvento(ciclo({ dtPartoPrevisto: '2026-09-09' }), contexto),
    ).toMatchObject({ tipo: 'parto_previsto', atrasado: true })
  })

  it('nao marca atrasado no proprio dia da previsao', () => {
    expect(
      calcularProximoEvento(ciclo({ dtPartoPrevisto: '2026-09-10' }), contexto),
    ).toMatchObject({ atrasado: false })
  })

  it('passa a cobrar o desmame depois do parto confirmado', () => {
    expect(calcularProximoEvento(ciclo({ dtPartoReal: '2026-09-26' }), contexto)).toEqual({
      tipo: 'desmame_previsto',
      data: '2026-10-17',
      atrasado: false,
    })
  })

  it('nao deixa o reacasalamento passar na frente do desmame a confirmar', () => {
    // RN-05 libera reacasalamento em parto real + 6 = 02/10, ANTES do desmame previsto de
    // 17/10. Ordenar por data esconderia a confirmacao pendente - exatamente o que o RF-REP-07
    // existe para cobrar
    expect(calcularProximoEvento(ciclo({ dtPartoReal: '2026-09-26' }), contexto)?.tipo).toBe(
      'desmame_previsto',
    )
  })

  it('libera o reacasalamento em parto real + intervalo, com o ciclo fechado', () => {
    expect(
      calcularProximoEvento(
        ciclo({ dtPartoReal: '2026-09-26', dtDesmameReal: '2026-10-18' }),
        contexto,
      ),
    ).toEqual({ tipo: 'reacasalamento_liberado', data: '2026-10-02', atrasado: false })
  })

  it('reacasalamento liberado nunca esta atrasado - nao ha o que confirmar', () => {
    expect(
      calcularProximoEvento(
        ciclo({ dtPartoReal: '2026-01-05', dtDesmameReal: '2026-01-27' }),
        contexto,
      ),
    ).toMatchObject({ atrasado: false })
  })

  it('RN-04: no 5o ciclo fechado nao ha proximo evento, e sim reposicao', () => {
    expect(
      calcularProximoEvento(
        ciclo({ ordem: 5, dtPartoReal: '2026-09-26', dtDesmameReal: '2026-10-18' }),
        contexto,
      ),
    ).toBeNull()
  })

  it('caixa sem casal ativo nao tem evento', () => {
    expect(calcularProximoEvento(undefined, contexto)).toBeNull()
  })
})

describe('soma de dias em data de calendario', () => {
  it('atravessa virada de mes e de ano sem deslocar fuso', () => {
    expect(somarDias('2026-09-26', 6)).toBe('2026-10-02')
    expect(somarDias('2026-12-30', 6)).toBe('2027-01-05')
    expect(somarDias('2028-02-26', 3)).toBe('2028-02-29')
  })
})
