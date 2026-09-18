import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'

// `RF-ACS-02` e validacao de forma. A forma da resposta de sucesso (secao 8 do
// contrato, com casal/ciclo/disponivel reais) e teste de integracao, junto da
// massa de teste da colonia - mesmo recorte de `infra.routes.test.ts`.

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

describe('autorizacao do quadro e da transicao - RF-ACS-02', () => {
  it('quadro sem sessao devolve 401', async () => {
    const resposta = await request(app()).get('/api/quadro').query({ especie: 'rato' })

    expect(resposta.status).toBe(401)
    expect(resposta.body.erro.codigo).toBe('NAO_AUTENTICADO')
  })

  it('pesquisador nao enxerga o quadro - RF-ACS-03', async () => {
    const resposta = await request(app('pesquisador')).get('/api/quadro').query({ especie: 'rato' })

    expect(resposta.status).toBe(403)
    expect(resposta.body.erro.codigo).toBe('SEM_PERMISSAO')
  })

  it('pesquisador nao move caixa de estado', async () => {
    const resposta = await request(app('pesquisador'))
      .patch('/api/caixas/1/estado')
      .send({ estado: 'expedida', justificativa: null, confirmar: false })

    expect(resposta.status).toBe(403)
  })

  it('ficha sem sessao devolve 401', async () => {
    const resposta = await request(app()).get('/api/caixas/1')

    expect(resposta.status).toBe(401)
  })

  it('pesquisador nao abre a ficha - RF-ACS-03', async () => {
    const resposta = await request(app('pesquisador')).get('/api/caixas/1')

    expect(resposta.status).toBe(403)
  })
})

describe('validacao de entrada', () => {
  it('quadro sem `especie` e VALIDACAO, nao quadro vazio', async () => {
    // RF-CIC-01: nao existe "todas as especies" - omitir o filtro e erro de
    // forma, e nao devolver as duas espécies misturadas.
    const resposta = await request(app('tecnico')).get('/api/quadro')

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('recusa estado fora do dominio das 5 colunas', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/1/estado')
      .send({ estado: 'em_manutencao', justificativa: null, confirmar: false })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('omitir `confirmar` e VALIDACAO - o front sempre manda o campo', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/1/estado')
      .send({ estado: 'expedida', justificativa: null })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('id de caixa nao numerico vira 400, nao 500', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/abc/estado')
      .send({ estado: 'expedida', justificativa: null, confirmar: false })

    expect(resposta.status).toBe(400)
  })

  it('id de caixa nao numerico na ficha tambem vira 400', async () => {
    const resposta = await request(app('tecnico')).get('/api/caixas/abc')

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })
})
