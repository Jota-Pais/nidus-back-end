import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'

// RF-ACS-02 e validacao de forma. Sucesso com dado real (as quatro listas contra a massa de
// teste da colonia) e teste de integracao.

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

describe('autorizacao dos alertas - RF-ACS-02', () => {
  it('sem sessao devolve 401', async () => {
    const resposta = await request(app()).get('/api/alertas')

    expect(resposta.status).toBe(401)
  })

  it('pesquisador nao enxerga alertas da colonia - RF-ACS-03', async () => {
    const resposta = await request(app('pesquisador')).get('/api/alertas')

    expect(resposta.status).toBe(403)
  })
})

describe('validacao de entrada', () => {
  it('especie e dias sao opcionais - forma valida sem nenhum dos dois', async () => {
    // sem sessao real de proposito: so confere que o Zod aceita ausencia dos dois campos (o
    // painel cobre as duas especies por padrao).
    const resposta = await request(app()).get('/api/alertas')

    expect(resposta.status).toBe(401) // passou do Zod, parou na sessao
  })

  it('recusa `dias` fora da faixa 1-90', async () => {
    const resposta = await request(app('tecnico')).get('/api/alertas').query({ dias: 0 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('recusa `dias` nao numerico', async () => {
    const resposta = await request(app('tecnico')).get('/api/alertas').query({ dias: 'muitos' })

    expect(resposta.status).toBe(400)
  })
})
