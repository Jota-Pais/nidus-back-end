import type { RequestHandler } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { criarApp } from '../app.ts'
import { emailsCapturados, enviarCodigoDeAcesso, limparEmailsCapturados } from './email.ts'
import { agora, avancarRelogio, lerRelogio, relogioLigado } from './relogio.ts'
import { hojeISO } from './traducao.ts'

// O relogio guarda o deslocamento em memoria do modulo: cada teste reimporta com vi.resetModules
// quando precisa de um deslocamento limpo. Aqui o deslocamento so cresce, entao os testes de
// avanco usam a diferenca para o instante real e nao um valor absoluto

const DIA = 24 * 60 * 60 * 1000

const comoGestor: RequestHandler = (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil: 'gestor' } as never
  next()
}

beforeEach(() => {
  vi.stubEnv('RELOGIO_DE_TESTE', '')
  limparEmailsCapturados()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('relogio', () => {
  it('desligado devolve o tempo real e ignora o avanco', () => {
    const antes = Date.now()
    avancarRelogio(30)
    const depois = Date.now()

    expect(relogioLigado()).toBe(false)
    expect(agora().getTime()).toBeGreaterThanOrEqual(antes)
    expect(agora().getTime()).toBeLessThanOrEqual(depois + 1000)
    expect(lerRelogio().deslocamentoDias).toBe(0)
  })

  it('ligado e avancado devolve o instante deslocado, e o hojeISO acompanha', () => {
    vi.stubEnv('RELOGIO_DE_TESTE', 'ligado')
    const base = lerRelogio().deslocamentoDias

    avancarRelogio(10)

    const dias = (agora().getTime() - Date.now()) / DIA
    expect(lerRelogio().deslocamentoDias).toBe(base + 10)
    expect(dias).toBeGreaterThan(base + 9.99)
    expect(dias).toBeLessThan(base + 10.01)
    expect(hojeISO()).toBe(lerRelogio().hoje)
    expect(hojeISO()).not.toBe(hojeISO(new Date()))
  })

  it('le o deslocamento inicial da variavel de ambiente', async () => {
    vi.resetModules()
    vi.stubEnv('RELOGIO_DE_TESTE', 'ligado')
    vi.stubEnv('RELOGIO_DESLOCAMENTO_DIAS', '5')
    const novo = await import('./relogio.ts')

    expect(novo.lerRelogio().deslocamentoDias).toBe(5)
  })
})

describe('rotas /api/relogio', () => {
  it('nao existem com o relogio desligado', async () => {
    const resposta = await request(criarApp()).get('/api/relogio')

    expect(resposta.status).not.toBe(200)
    expect([401, 404]).toContain(resposta.status)
  })

  it('existem sem login com o relogio ligado, e o POST avanca', async () => {
    vi.stubEnv('RELOGIO_DE_TESTE', 'ligado')
    const app = criarApp()
    const base = (await request(app).get('/api/relogio')).body.deslocamentoDias as number

    const resposta = await request(app).post('/api/relogio').send({ dias: 3 })

    expect(resposta.status).toBe(200)
    expect(resposta.body.deslocamentoDias).toBe(base + 3)
    expect(resposta.body.hoje).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('recusa dias que nao e inteiro nao negativo', async () => {
    vi.stubEnv('RELOGIO_DE_TESTE', 'ligado')
    const app = criarApp()

    for (const dias of [-1, 1.5, 'x']) {
      expect((await request(app).post('/api/relogio').send({ dias })).status).toBe(400)
    }
  })

  it('GET /api/relogio/emails devolve os e-mails capturados', async () => {
    vi.stubEnv('RELOGIO_DE_TESTE', 'ligado')
    await enviarCodigoDeAcesso('a@ufsc.br', '123456', 10)

    const resposta = await request(criarApp()).get('/api/relogio/emails')

    expect(resposta.status).toBe(200)
    expect(resposta.body).toHaveLength(1)
    expect(resposta.body[0]).toMatchObject({ para: 'a@ufsc.br' })
  })
})

describe('GET /api/sessao com o relogio', () => {
  it('traz hoje e relogioDeTeste nulo fora do modo de teste', async () => {
    const resposta = await request(criarApp({ autenticacao: comoGestor })).get('/api/sessao')

    expect(resposta.body.hoje).toBe(hojeISO())
    expect(resposta.body.relogioDeTeste).toBeNull()
  })

  it('traz o deslocamento no modo de teste', async () => {
    vi.stubEnv('RELOGIO_DE_TESTE', 'ligado')
    const resposta = await request(criarApp({ autenticacao: comoGestor })).get('/api/sessao')

    expect(resposta.body.relogioDeTeste).toEqual({ deslocamentoDias: lerRelogio().deslocamentoDias })
    expect(resposta.body.hoje).toBe(lerRelogio().hoje)
  })
})

describe('e-mail com o relogio ligado', () => {
  it('guarda o e-mail em vez de enviar, com quando no relogio, e mantem so os 50 ultimos', async () => {
    vi.stubEnv('RELOGIO_DE_TESTE', 'ligado')
    const fetchFalso = vi.fn()
    vi.stubGlobal('fetch', fetchFalso)

    for (let i = 0; i < 55; i++) {
      await enviarCodigoDeAcesso(`p${i}@ufsc.br`, '123456', 10)
    }

    const guardados = emailsCapturados()
    expect(fetchFalso).not.toHaveBeenCalled()
    expect(guardados).toHaveLength(50)
    expect(guardados[0]?.para).toBe('p54@ufsc.br')
    expect(guardados[0]?.assunto).toContain('código')
    expect(guardados[0]?.texto).toContain('123456')
    expect(guardados[0]?.quando).toBeInstanceOf(Date)
    vi.unstubAllGlobals()
  })

  it('desligado nao guarda nada', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await enviarCodigoDeAcesso('a@ufsc.br', '123456', 10)

    expect(emailsCapturados()).toHaveLength(0)
  })
})
