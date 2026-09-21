import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from './app.ts'

// Fumaca do esqueleto: app, CORS, JSON e tratador de erro ligados, e o
// envelope de erro no formato do contrato (docs/contrato-api.md, secao 2)
// Nao toca o banco
describe('esqueleto da API', () => {
  it('responde o healthcheck no formato do contrato', async () => {
    const resposta = await request(criarApp({ ambiente: 'teste', versao: '9.9.9' })).get('/saude')

    expect(resposta.status).toBe(200)
    expect(resposta.body).toEqual({ status: 'ok', ambiente: 'teste', versao: '9.9.9' })
  })

  it('devolve NAO_ENCONTRADO no envelope de erro para rota inexistente', async () => {
    const resposta = await request(criarApp()).get('/rota-que-nao-existe')

    expect(resposta.status).toBe(404)
    expect(resposta.body.erro.codigo).toBe('NAO_ENCONTRADO')
    expect(resposta.body.erro.mensagem).toContain('nao existe')
  })
})
