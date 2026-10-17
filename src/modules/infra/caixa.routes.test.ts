import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'

// Autorizacao e validacao de forma. Nenhum teste aqui chega ao banco

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

describe('autorizacao do kanban e da ficha', () => {
  it('kanban sem sessao devolve 401', async () => {
    const resposta = await request(app()).get('/api/quadro').query({ especie: 'rato' })

    expect(resposta.status).toBe(401)
    expect(resposta.body.erro.codigo).toBe('NAO_AUTENTICADO')
  })

  it('pesquisador nao enxerga o kanban', async () => {
    const resposta = await request(app('pesquisador')).get('/api/quadro').query({ especie: 'rato' })

    expect(resposta.status).toBe(403)
    expect(resposta.body.erro.codigo).toBe('SEM_PERMISSAO')
  })

  it('pesquisador nao move caixa de coluna', async () => {
    const resposta = await request(app('pesquisador'))
      .patch('/api/caixas/1/estado')
      .send({ estado: 'enviado', confirmar: false })

    expect(resposta.status).toBe(403)
  })

  it('pesquisador nao abre a ficha', async () => {
    const resposta = await request(app('pesquisador')).get('/api/caixas/1')

    expect(resposta.status).toBe(403)
  })
})

describe('validacao de entrada', () => {
  it('kanban sem `especie` e VALIDACAO, nao kanban vazio', async () => {
    const resposta = await request(app('tecnico')).get('/api/quadro')

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('recusa coluna que nao e uma das 5 do kanban', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/1/estado')
      .send({ estado: 'expedida', confirmar: false })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('omitir `confirmar` e VALIDACAO', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/1/estado')
      .send({ estado: 'enviado' })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('id de caixa nao numerico vira 400, nao 500', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/abc/estado')
      .send({ estado: 'enviado', confirmar: false })

    expect(resposta.status).toBe(400)
  })
})
