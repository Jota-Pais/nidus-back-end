import { afterEach, describe, expect, it, vi } from 'vitest'
import { enviarCodigoDeAcesso } from './email.ts'

// O ambiente e de mentira para o teste trocar o NODE_ENV: email.ts le o valor a cada envio

const ambiente = vi.hoisted(() => ({ NODE_ENV: 'test' }))

vi.mock('../env.ts', () => ({ env: ambiente }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('envio do codigo de acesso', () => {
  it.each(['development', 'test'])('em %s o codigo vai para o console do servidor', async (nodeEnv) => {
    ambiente.NODE_ENV = nodeEnv
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await enviarCodigoDeAcesso('fulano@ufsc.br', '012345')

    expect(log).toHaveBeenCalledWith('[acesso] codigo para fulano@ufsc.br: 012345')
  })

  it('em producao, sem servico de e-mail, falha dizendo isso e nao escreve o codigo', async () => {
    ambiente.NODE_ENV = 'production'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const erro = await enviarCodigoDeAcesso('fulano@ufsc.br', '012345').catch((e: unknown) => e)

    // o erro vai para o log do servidor: diz o que falta, mas nunca leva o codigo
    expect(String(erro)).toContain('Envio de e-mail nao configurado')
    expect(String(erro)).not.toContain('012345')
    expect(log).not.toHaveBeenCalled()
  })
})
