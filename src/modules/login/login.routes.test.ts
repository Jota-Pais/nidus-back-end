import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'

// login de verdade (usuario existe, senha confere) e teste de integracao: sai de
// autenticar chamando o banco. Aqui so o que nao toca banco - forma da entrada e a
// autorizacao de quem ja tem sessao, mesmo recorte dos outros arquivos de rota

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

describe('POST /api/sessao - forma da entrada', () => {
  it('e publica: nao exige sessao pra tentar logar', async () => {
    // Sem isso ninguem conseguiria dar o primeiro login - a rota que cria a sessao
    // nao pode exigir uma sessao existente
    const resposta = await request(app()).post('/api/sessao').send({ email: 'x', senha: 'x' })

    // Chega a tentar autenticar (não é 401 de sessão ausente) - o corpo é válido pro Zod, então
    // passa e cai na consulta ao banco, que aqui não existe: 500 e é isso que confirma que não
    // parou em NAO_AUTENTICADO por falta de sessão
    expect(resposta.status).not.toBe(401)
  })

  it('recusa corpo sem email ou senha, campo a campo', async () => {
    const resposta = await request(app()).post('/api/sessao').send({ email: 'tecnico@ufsc.br' })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(Object.keys(resposta.body.erro.campos)).toContain('senha')
  })

  it('recusa email vazio', async () => {
    const resposta = await request(app()).post('/api/sessao').send({ email: '', senha: 'x' })

    expect(resposta.status).toBe(400)
  })
})

describe('GET e DELETE /api/sessao - autenticado, qualquer perfil', () => {
  it('quem sou eu sem sessao devolve 401', async () => {
    const resposta = await request(app()).get('/api/sessao')

    expect(resposta.status).toBe(401)
    expect(resposta.body.erro.codigo).toBe('NAO_AUTENTICADO')
  })

  it('quem sou eu com sessao devolve o usuario, qualquer perfil', async () => {
    const resposta = await request(app('pesquisador')).get('/api/sessao')

    expect(resposta.status).toBe(200)
    expect(resposta.body.usuario.perfil).toBe('pesquisador')
  })

  it('logout sem sessao tambem devolve 401 - exige autenticado', async () => {
    const resposta = await request(app()).delete('/api/sessao')

    expect(resposta.status).toBe(401)
  })

  it('logout com sessao devolve 204 sem corpo', async () => {
    const resposta = await request(app('tecnico')).delete('/api/sessao')

    expect(resposta.status).toBe(204)
    expect(resposta.body).toEqual({})
  })
})
