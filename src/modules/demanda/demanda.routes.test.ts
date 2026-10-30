import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { filtroDaBusca } from '../motor/motor.routes.ts'
import { solicitacaoNova } from './demanda.routes.ts'

// Autorizacao e forma da entrada. Nenhum teste aqui chega ao banco

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

const pedido = {
  idProjeto: 1,
  idLinhagem: 1,
  machos: 10,
  femeas: 5,
  idade: 28,
  dataEntrega: '2026-12-01',
  cronograma: 'unica',
}

describe('autorizacao', () => {
  it('sem sessao nao lista nem cria solicitacao', async () => {
    expect((await request(app()).get('/api/solicitacoes')).status).toBe(401)
    expect((await request(app()).post('/api/solicitacoes').send(pedido)).status).toBe(401)
  })

  it('o pesquisador nao usa a busca de atendimento nem aloca caixa', async () => {
    const busca = await request(app('pesquisador'))
      .get('/api/busca')
      .query({ especie: 'rato', machos: 1, femeas: 1, qualquer: 0, idadeMin: 28, idadeMax: 28 })
    const alocacao = await request(app('pesquisador'))
      .post('/api/solicitacoes/1/alocacao')
      .send({ itens: [{ idParto: 1, machos: 1, femeas: 0 }] })

    expect(busca.status).toBe(403)
    expect(alocacao.status).toBe(403)
  })
})

describe('forma da solicitacao', () => {
  it('aceita o pedido completo', () => {
    expect(solicitacaoNova.safeParse(pedido).success).toBe(true)
  })

  it('recusa idade abaixo de 21 dias e pedido sem nenhum animal', () => {
    expect(solicitacaoNova.safeParse({ ...pedido, idade: 20 }).success).toBe(false)
    expect(solicitacaoNova.safeParse({ ...pedido, machos: 0, femeas: 0 }).success).toBe(false)
  })

  it('alocacao sem item e VALIDACAO', async () => {
    const resposta = await request(app('tecnico')).post('/api/solicitacoes/1/alocacao').send({ itens: [] })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })
})

describe('forma da busca', () => {
  const busca = { especie: 'rato', machos: '10', femeas: '5', qualquer: '3', idadeMin: '20', idadeMax: '40' }

  it('converte a query string e separa as caixas excluidas', () => {
    const filtro = filtroDaBusca.parse({ ...busca, excluir: '3,7' })

    expect(filtro).toMatchObject({ machos: 10, femeas: 5, qualquer: 3, idadeMin: 20, idadeMax: 40, excluir: [3, 7] })
  })

  it('busca sem especie e VALIDACAO', async () => {
    const resposta = await request(app('tecnico'))
      .get('/api/busca')
      .query({ machos: 1, femeas: 1, qualquer: 0, idadeMin: 28, idadeMax: 28 })

    expect(resposta.status).toBe(400)
  })

  it('idade maxima menor que a minima e VALIDACAO no campo idadeMax', async () => {
    const resposta = await request(app('tecnico')).get('/api/busca').query({ ...busca, idadeMax: '19' })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos).toHaveProperty('idadeMax')
  })
})
