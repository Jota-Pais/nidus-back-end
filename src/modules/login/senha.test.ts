import { describe, expect, it } from 'vitest'
import { hashSenha, senhaCorresponde } from './senha.ts'

describe('hash de senha', () => {
  it('a senha certa confere contra o proprio hash', async () => {
    const hash = await hashSenha('correta123')

    expect(await senhaCorresponde('correta123', hash)).toBe(true)
  })

  it('senha errada nao confere', async () => {
    const hash = await hashSenha('correta123')

    expect(await senhaCorresponde('errada456', hash)).toBe(false)
  })

  it('o hash nunca e a senha em claro', async () => {
    const hash = await hashSenha('correta123')

    expect(hash).not.toContain('correta123')
  })

  it('o mesmo texto gera hashes diferentes a cada chamada (salt)', async () => {
    // sem isto, duas contas com a mesma senha teriam o mesmo hash na tabela -
    // vazamento de "estas duas pessoas usam a mesma senha".
    const [hashA, hashB] = await Promise.all([hashSenha('correta123'), hashSenha('correta123')])

    expect(hashA).not.toBe(hashB)
  })
})
