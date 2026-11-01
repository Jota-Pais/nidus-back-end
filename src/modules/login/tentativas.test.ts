import { describe, expect, it } from 'vitest'
import { conferirTentativas, limparFalhas, registrarFalha } from './tentativas.ts'

describe('limite de tentativas de login', () => {
  it('bloqueia depois de 5 falhas seguidas', () => {
    const chave = 'ip:bloqueio@ufsc.br'
    for (let i = 0; i < 5; i += 1) registrarFalha(chave, 1_000)

    expect(() => conferirTentativas(chave, 2_000)).toThrow(
      expect.objectContaining({ status: 429, codigo: 'MUITAS_TENTATIVAS' }),
    )
  })

  it('4 falhas ainda deixam tentar', () => {
    const chave = 'ip:quatro@ufsc.br'
    for (let i = 0; i < 4; i += 1) registrarFalha(chave, 1_000)

    expect(() => conferirTentativas(chave, 2_000)).not.toThrow()
  })

  it('libera depois de 15 minutos', () => {
    const chave = 'ip:espera@ufsc.br'
    for (let i = 0; i < 5; i += 1) registrarFalha(chave, 0)

    expect(() => conferirTentativas(chave, 15 * 60_000 + 1)).not.toThrow()
  })

  it('login certo zera a contagem', () => {
    const chave = 'ip:acertou@ufsc.br'
    for (let i = 0; i < 5; i += 1) registrarFalha(chave, 1_000)
    limparFalhas(chave)

    expect(() => conferirTentativas(chave, 2_000)).not.toThrow()
  })
})
