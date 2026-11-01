import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'

describe('corpo que o express.json recusa', () => {
  it('JSON malformado devolve 400 VALIDACAO, nao 500', async () => {
    const resposta = await request(criarApp())
      .post('/api/sessao')
      .set('Content-Type', 'application/json')
      .send('{"email": ')

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(resposta.body.erro.campos).toHaveProperty('(corpo)')
  })

  it('corpo acima do limite devolve 413', async () => {
    const resposta = await request(criarApp())
      .post('/api/sessao')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a'.repeat(200_000), senha: 'x' }))

    expect(resposta.status).toBe(413)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })
})
