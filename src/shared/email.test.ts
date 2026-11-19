import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOME_DO_REMETENTE,
  TEMPO_LIMITE_DO_ENVIO_EM_MS,
  avisarAnimaisReservados,
  avisarPedidoDecidido,
  avisarSenhaAlterada,
  enviarCodigoDeAcesso,
} from './email.ts'

// O ambiente e de mentira para o teste trocar o NODE_ENV e as variaveis da Brevo: email.ts le
// os valores a cada envio. A rede tambem: o fetch e trocado em todo teste, e nenhum sai da maquina

const CHAVE = 'chave-de-mentira-0123'
const REMETENTE = 'nidus@exemplo.com'

const ambiente = vi.hoisted(() => ({
  NODE_ENV: 'production',
  CORS_ORIGEM: 'https://thenidus.vercel.app',
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

  it.each(['development', 'test'])('em %s o aviso de senha alterada vai para o console', async (nodeEnv) => {
    ambiente.NODE_ENV = nodeEnv
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await avisarSenhaAlterada('fulano@ufsc.br', new Date())

    expect(log).toHaveBeenCalledWith('[acesso] aviso de senha alterada para fulano@ufsc.br')
    expect(fetchFalso).not.toHaveBeenCalled()
  })
})

describe('codigo de acesso, em production, pela Brevo', () => {
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
    // seguir um 3xx levaria a chave e o codigo a outra origem
    expect(opcoes.redirect).toBe('error')
    expect(corpo).toEqual({
      sender: { email: REMETENTE, name: NOME_DO_REMETENTE },
      to: [{ email: 'fulano@ufsc.br' }],
      subject: 'Seu código para definir a senha do Nidus',
      textContent: expect.any(String),
    })
  })

  it('o texto diz o que e, o codigo, a validade e o que fazer se a pessoa nao pediu', async () => {
    await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15)

    const { textContent } = chamadaUnica().corpo
    expect(textContent).toContain('código para definir a senha do Nidus é 012345')
    expect(textContent).toContain('vale por 15 minutos')
    // o link abre a tela no campo do codigo, com o e-mail, e sem o codigo
    expect(textContent).toContain('https://thenidus.vercel.app/definir-senha?email=fulano%40ufsc.br')
    expect(textContent).not.toMatch(/definir-senhaS*012345/)
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

  it('o corpo da resposta que para no meio tambem vira o erro do tempo limite', async () => {
    // o fetch ja voltou com o status; e a leitura do corpo que o sinal interrompe
    const corpoParado = {
      ok: true,
      status: 201,
      text: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    }
    fetchFalso.mockResolvedValueOnce(corpoParado as unknown as Response)

    const erro = await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15).catch((e: unknown) => e)

    expect(String(erro)).toContain('Envio pela Brevo falhou: a API nao respondeu em 10 s')
  })

  it('o redirecionamento recusado vira erro com o motivo, sem o codigo e sem a chave', async () => {
    // e como o fetch do Node recusa um 3xx com redirect 'error'
    fetchFalso.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))

    const erro = await enviarCodigoDeAcesso('fulano@ufsc.br', '012345', 15).catch((e: unknown) => e)

    expect(String(erro)).toContain('Envio pela Brevo falhou: a chamada a API nao terminou')
    expect(String(erro)).toContain('fetch failed: unexpected redirect')
    expect(String(erro)).not.toContain('012345')
    expect(String(erro)).not.toContain(CHAVE)
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

    expect(String(erro)).toContain('a chamada a API nao terminou (fetch failed')
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

describe('aviso de senha alterada, em production', () => {
  // 1h30 de 31/10 em UTC ainda e 30/10 em Brasilia, as 22h30
  const quando = new Date('2026-10-31T01:30:00Z')

  it('vai pela Brevo a um destinatario so, com o assunto do aviso', async () => {
    await avisarSenhaAlterada('fulano@ufsc.br', quando)

    const { url, opcoes, corpo } = chamadaUnica()
    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect(opcoes.headers).toMatchObject({ 'api-key': CHAVE })
    expect(corpo).toEqual({
      sender: { email: REMETENTE, name: NOME_DO_REMETENTE },
      to: [{ email: 'fulano@ufsc.br' }],
      subject: 'Sua senha do Nidus foi alterada',
      textContent: expect.any(String),
    })
  })

  it('o texto diz o que mudou, quando, e o que fazer se nao foi a pessoa', async () => {
    await avisarSenhaAlterada('fulano@ufsc.br', quando)

    const { textContent } = chamadaUnica().corpo
    expect(textContent).toContain('foi alterada em 30/10/2026, às 22:30 (horário de Brasília)')
    expect(textContent).toContain('As sessões abertas antes disso foram encerradas.')
    expect(textContent).toContain('Se foi você, não precisa fazer nada.')
    expect(textContent).toContain('Se não foi você, troque a senha deste e-mail e avise a equipe')
  })

  it('a recusa da Brevo vira erro, sem a chave', async () => {
    fetchFalso.mockResolvedValueOnce(respostaDaBrevo(400, { code: 'unauthorized', message: `chave ${CHAVE}` }))

    const erro = await avisarSenhaAlterada('fulano@ufsc.br', quando).catch((e: unknown) => e)

    expect(String(erro)).toContain('Envio pela Brevo recusado: 400 unauthorized')
    expect(String(erro)).not.toContain(CHAVE)
  })
})

describe('aviso do pedido decidido', () => {
  const pedido = {
    protocoloCeua: '23080.000001/2026-54',
    linhagem: 'Wistar',
    machos: 2,
    femeas: 1,
    qualquer: 0,
    idadeMin: 21,
    idadeMax: 28,
    dataEntrega: '2026-12-01',
    dataPedido: '2026-11-05',
  }

  it('fora de production vai para o console, sem rede', async () => {
    ambiente.NODE_ENV = 'test'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await avisarPedidoDecidido('ana@ufsc.br', pedido)

    expect(log).toHaveBeenCalledWith('[pedido] aviso de pedido aprovado para ana@ufsc.br')
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('a aprovacao traz o resumo e o link, sem motivo', async () => {
    await avisarPedidoDecidido('ana@ufsc.br', pedido)

    const { corpo } = chamadaUnica()
    expect(corpo.to).toEqual([{ email: 'ana@ufsc.br' }])
    expect(corpo.subject).toBe('Seu pedido de animais foi aprovado')
    expect(corpo.textContent).toContain('aprovou o seu pedido de animais')
    // aprovar nao e reservar: os animais sao reservados depois, e vem outro e-mail
    expect(corpo.textContent).toContain('Os animais serão reservados para a data de entrega')
    expect(corpo.textContent).toContain('você recebe outro e-mail quando a reserva estiver pronta')
    expect(corpo.textContent).toContain('Protocolo CEUA: 23080.000001/2026-54')
    expect(corpo.textContent).toContain('Linhagem: Wistar')
    expect(corpo.textContent).toContain('Animais: 2 machos, 1 fêmea')
    expect(corpo.textContent).toContain('Idade: de 21 a 28 dias')
    expect(corpo.textContent).toContain('Data de entrega: 01/12/2026')
    expect(corpo.textContent).toContain('Data do pedido: 05/11/2026')
    expect(corpo.textContent).toContain('https://thenidus.vercel.app/pedidos')
    expect(corpo.textContent).not.toContain('Motivo')
  })

  it('a recusa traz o motivo', async () => {
    await avisarPedidoDecidido('ana@ufsc.br', pedido, 'Sem Wistar até dezembro')

    const { corpo } = chamadaUnica()
    expect(corpo.subject).toBe('Seu pedido de animais foi recusado')
    expect(corpo.textContent).toContain('recusou o seu pedido de animais')
    expect(corpo.textContent).toContain('Motivo: Sem Wistar até dezembro')
    expect(corpo.textContent).not.toContain('reservados para')
  })
})

describe('aviso de animais reservados', () => {
  const pedido = {
    protocoloCeua: '23080.000001/2026-54',
    linhagem: 'Wistar',
    machos: 0,
    femeas: 0,
    qualquer: 1,
    idadeMin: 28,
    idadeMax: 28,
    dataEntrega: '2026-12-01',
    dataPedido: '2026-11-05',
  }

  it('fora de production vai para o console, sem rede', async () => {
    ambiente.NODE_ENV = 'development'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await avisarAnimaisReservados('ana@ufsc.br', pedido)

    expect(log).toHaveBeenCalledWith('[pedido] aviso de animais reservados para ana@ufsc.br')
    expect(fetchFalso).not.toHaveBeenCalled()
  })

  it('diz para que entrega os animais estao reservados, com o resumo e o link', async () => {
    await avisarAnimaisReservados('ana@ufsc.br', pedido)

    const { corpo } = chamadaUnica()
    expect(corpo.to).toEqual([{ email: 'ana@ufsc.br' }])
    expect(corpo.subject).toBe('Os animais do seu pedido estão reservados')
    expect(corpo.textContent).toContain('A equipe aprovou o seu pedido de animais.')
    expect(corpo.textContent).toContain('Os animais do seu pedido estão reservados para a entrega de 01/12/2026.')
    expect(corpo.textContent).toContain('Animais: 1 de qualquer sexo')
    expect(corpo.textContent).toContain('Idade: 28 dias')
    expect(corpo.textContent).toContain('Data do pedido: 05/11/2026')
    expect(corpo.textContent).toContain('https://thenidus.vercel.app/pedidos')
  })
})
