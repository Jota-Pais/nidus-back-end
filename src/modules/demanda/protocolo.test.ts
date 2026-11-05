import { afterEach, describe, expect, it, vi } from 'vitest'
import { conferirProtocolo, numeroCeua } from './protocolo.ts'

const HOJE = '2026-11-05'

describe('processo da UFSC', () => {
  it('aceita processos do Boletim Oficial, inclusive os de verificador 0 e 1', () => {
    for (const numero of [
      '23080.027699/2015-01',
      '23080.038397/2021-06',
      '23080.079383/2019-10',
      '23080.040077/2021-16',
      '23080.009760/2017-91',
      '23080.001234/2026-74',
    ]) {
      expect(conferirProtocolo(numero, HOJE), numero).toBeNull()
    }
  })

  it('verificador errado e recusado', () => {
    expect(conferirProtocolo('23080.001234/2026-11', HOJE)).toBe(
      'Digito verificador errado. Confira o numero do processo.',
    )
  })

  it('ano depois do atual e recusado', () => {
    expect(conferirProtocolo('23080.001234/2026-74', '2025-12-31')).toBe('O ano do processo ainda nao chegou.')
  })

  it('so com a pontuacao: a API grava o processo como ele aparece no parecer', () => {
    expect(conferirProtocolo('23080001234202674', HOJE)).toBe(
      'Use o processo, 23080.XXXXXX/AAAA-XX, ou os 10 digitos do Sistema CEUA.',
    )
  })
})

describe('numero do Sistema CEUA', () => {
  it('aceita os 10 digitos com a data do registro ate hoje', () => {
    expect(conferirProtocolo('3106240920', HOJE)).toBeNull()
    expect(conferirProtocolo('4401201118', HOJE)).toBeNull()
    expect(conferirProtocolo('7971160320', HOJE)).toBeNull()
    expect(conferirProtocolo('1234051126', HOJE)).toBeNull()
  })

  it('10 digitos que comecam com 23080 sao do Sistema CEUA, nao processo incompleto', () => {
    expect(conferirProtocolo('2308050920', HOJE)).toBeNull()
  })

  it('data que nao existe ou que ainda nao chegou e recusada', () => {
    expect(conferirProtocolo('1234310220', HOJE)).toBe(
      'Os 6 ultimos digitos do numero do Sistema CEUA nao formam uma data (DDMMAA).',
    )
    expect(conferirProtocolo('1234001320', HOJE)).not.toBeNull()
    expect(conferirProtocolo('1234061126', HOJE)).toBe(
      'Os 6 ultimos digitos do numero do Sistema CEUA sao uma data futura.',
    )
  })

  it('com a pontuacao do processo, ou com digito a menos, e recusado', () => {
    expect(conferirProtocolo('23080.50920', HOJE)).not.toBeNull()
    expect(conferirProtocolo('310624092', HOJE)).not.toBeNull()
  })
})

describe('hoje e o dia de Brasilia', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('o registro de 05/11 vale a partir da meia-noite de Brasilia, nao da de UTC', () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    // 04/11 as 23h30 em Brasilia, 05/11 as 02h30 em UTC
    vi.setSystemTime(new Date('2026-11-05T02:30:00.000Z'))
    expect(numeroCeua.safeParse('1234051126').success).toBe(false)

    // 05/11 a 00h30 em Brasilia
    vi.setSystemTime(new Date('2026-11-05T03:30:00.000Z'))
    expect(numeroCeua.safeParse('1234051126').success).toBe(true)
  })
})

describe('numeroCeua', () => {
  it('tira os espacos das pontas e recusa com a mensagem da regra', () => {
    expect(numeroCeua.parse(' 23080.001234/2026-74 ')).toBe('23080.001234/2026-74')

    const vazio = numeroCeua.safeParse('')
    expect(vazio.error?.issues[0]?.message).toBe(
      'Use o processo, 23080.XXXXXX/AAAA-XX, ou os 10 digitos do Sistema CEUA.',
    )
  })
})
