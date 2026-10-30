import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOME_DO_REMETENTE, TEMPO_LIMITE_DO_ENVIO_EM_MS, enviarCodigoDeAcesso } from './email.ts'

// O ambiente e de mentira para o teste trocar o NODE_ENV e as variaveis da Brevo: email.ts le
// os valores a cada envio. A rede tambem: o fetch e trocado em todo teste, e nenhum sai da maquina

const CHAVE = 'chave-de-mentira-0123'
const REMETENTE = 'nidus@exemplo.ufsc.br'

const ambiente = vi.hoisted(() => ({
  NODE_ENV: 'production',
  BREVO_API_KEY: undefined as string | undefined,
  EMAIL_REMETENTE: undefined as string | undefined,
}))

vi.mock('../env.ts', () => ({ env: ambiente }))

type Chamada = [string, RequestInit]

const respostaDaBrevo = (status: number, corpo: object) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } })

let fetchFalso = vi.fn(async (..._chamada: Chamada) => respostaDaBrevo(201, { messageId: '<1@brevo>' }))

beforeEach(() => {
  Object.assign(ambiente, { NODE_ENV: 'production', BREVO_API_KEY: CHAVE, EMAIL_REMETENTE: REMETENTE })
  fetchFalso = vi.fn(async (..._chamada: Chamada) => respostaDaBrevo(201, { messageId: '<1@brevo>' }))
  vi.stubGlobal('fetch', fetchFalso)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A unica chamada a Brevo: URL, cabecalhos e o corpo ja lido */
function chamadaUnica() {
  expect(fetchFalso).toHaveBeenCalledTimes(1)
  const [url, opcoes] = fetchFalso.mock.calls[0] as Chamada
  return { url, opcoes, corpo: JSON.parse(String(opcoes.body)) }
}

describe('fora de production', () => {
  it.each(['development', 'test'])('em %s o codigo vai para o console, sem rede', async (nodeEnv) => {
    ambiente.NODE_ENV = nodeEnv
    ambiente.BREVO_API_KEY = undefined
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15)

    expect(log).toHaveBeenCalledWith('[acesso] codigo para fulano@ufsc.br: 012345')
    expect(fetchFalso).not.toHaveBeenCalled()
  })
})

describe('em production, pela Brevo', () => {
  it('manda o codigo a um destinatario so, com a chave no cabecalho', async () => {
    await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15)

    const { url, opcoes, corpo } = chamadaUnica()
    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect(opcoes.method).toBe('POST')
    expect(opcoes.headers).toEqual({
      'api-key': CHAVE,
      'content-type': 'application/json',
      accept: 'application/json',
    })
    expect(corpo).toEqual({
      sender: { email: REMETENTE, name: NOME_DO_REMETENTE },
      to: [{ email: 'fulano@ufsc.br' }],
      subject: 'Seu código de acesso ao Nidus',
      textContent: expect.any(String),
    })
  })

  it('o texto diz o que e, o codigo, a validade e o que fazer se a pessoa nao pediu', async () => {
    await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15)

    const { textContent } = chamadaUnica().corpo
    expect(textContent).toContain('código para definir a senha do Nidus é 012345')
    expect(textContent).toContain('vale por 15 minutos')
    expect(textContent).toContain('Se você não pediu este código, ignore este e-mail')
    // e nada que diga se a conta existe: o mesmo texto vai para quem tem conta e quem nao tem
    expect(textContent).not.toMatch(/conta/i)
  })

  it('a Brevo que nao responde no tempo limite vira erro, e o envio desiste', async () => {
    const tempoLimite = vi.spyOn(AbortSignal, 'timeout')
    // o tempo limite de verdade e de 10 s: aqui o sinal dispara logo
    tempoLimite.mockImplementation(() => {
      const controle = new AbortController()
      setTimeout(() => controle.abort(new DOMException('tempo esgotado', 'TimeoutError')), 5)
      return controle.signal
    })
    fetchFalso.mockImplementationOnce(
      (_url, opcoes) =>
        new Promise<Response>((_resolve, rejeitar) => {
          const sinal = opcoes.signal
          if (!(sinal instanceof AbortSignal)) {
            rejeitar(new Error('chamada sem tempo limite'))
            return
          }
          sinal.addEventListener('abort', () => rejeitar(sinal.reason))
        }),
    )

    const erro = await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15).catch((e: unknown) => e)

    expect(tempoLimite).toHaveBeenCalledWith(TEMPO_LIMITE_DO_ENVIO_EM_MS)
    expect(String(erro)).toContain('a API nao respondeu em 10 s')
  })

  it('a recusa da Brevo vira erro com o status e o motivo, sem o codigo e sem a chave', async () => {
    // a resposta devolve de proposito o codigo e a chave, para provar que o log nao os leva
    fetchFalso.mockResolvedValueOnce(
      respostaDaBrevo(400, {
        code: 'invalid_parameter',
        message: `textContent 012345 recusado para a chave ${CHAVE}`,
      }),
    )

    const erro = await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15).catch((e: unknown) => e)

    expect(erro).toBeInstanceOf(Error)
    expect(String(erro)).toContain('Envio pela Brevo recusado: 400 invalid_parameter')
    expect(String(erro)).not.toContain('012345')
    expect(String(erro)).not.toContain(CHAVE)
  })

  it('a rede fora do ar vira erro, sem o codigo e sem a chave', async () => {
    fetchFalso.mockRejectedValueOnce(new TypeError(`fetch failed ${CHAVE} 012345`))

    const erro = await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15).catch((e: unknown) => e)

    expect(String(erro)).toContain('a API nao foi alcancada')
    expect(String(erro)).not.toContain('012345')
    expect(String(erro)).not.toContain(CHAVE)
  })

  it('sem a configuracao, falha sem chamar a Brevo e sem escrever o codigo', async () => {
    ambiente.BREVO_API_KEY = undefined
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const erro = await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15).catch((e: unknown) => e)

    expect(String(erro)).toContain('faltam BREVO_API_KEY e EMAIL_REMETENTE')
    expect(String(erro)).not.toContain('012345')
    expect(fetchFalso).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
