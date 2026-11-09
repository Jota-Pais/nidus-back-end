import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { mudanca } from './caixa.routes.ts'

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

  it('pesquisador nao muda caixa de posicao', async () => {
    const resposta = await request(app('pesquisador'))
      .patch('/api/caixas/1/posicao')
      .send({ idEstante: 1, face: 'frontal', linha: 1, coluna: 1 })

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

  it('posicao com face que nao existe e VALIDACAO', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/1/posicao')
      .send({ idEstante: 1, face: 'lateral', linha: 1, coluna: 1 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('posicao sem linha e VALIDACAO', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/1/posicao')
      .send({ idEstante: 1, face: 'frontal', coluna: 1 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('id de caixa nao numerico vira 400, nao 500', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/abc/posicao')
      .send({ idEstante: 1, face: 'frontal', linha: 1, coluna: 1 })

    expect(resposta.status).toBe(400)
  })

  it('a caixa nao muda mais de coluna a mao: a rota saiu', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/caixas/1/estado')
      .send({ estado: 'livres', confirmar: false })

    expect(resposta.status).toBe(404)
  })
})

describe('mudanca de animais', () => {
  const ontem = somarDias(hojeISO(), -1)
  const machos = { qtd: 3, destino: { idCaixa: 2 } }

  it('pesquisador nao muda animais de caixa', async () => {
    const resposta = await request(app('pesquisador')).post('/api/caixas/1/mudanca').send({ dtFato: ontem, machos })

    expect(resposta.status).toBe(403)
  })

  it('o corpo valido passa', () => {
    expect(mudanca.safeParse({ dtFato: ontem, machos }).success).toBe(true)
    expect(
      mudanca.safeParse({
        dtFato: ontem,
        femeas: { qtd: 2, dtNascimento: '2026-09-01', idPedido: 9, destino: { posicao: { idEstante: 1, face: 'traseira', linha: 2, coluna: 3 } } },
      }).success,
    ).toBe(true)
  })

  it('sem machos nem femeas, recusa no campo', async () => {
    const resposta = await request(app('tecnico')).post('/api/caixas/1/mudanca').send({ dtFato: ontem })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos).toHaveProperty('machos')
  })

  it('a data no futuro e recusada antes de tocar o banco', async () => {
    const resposta = await request(app('tecnico'))
      .post('/api/caixas/1/mudanca')
      .send({ dtFato: somarDias(hojeISO(), 1), machos })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos).toHaveProperty('dtFato')
  })

  it('so do pedido pede o pedido, no campo dele', () => {
    const semPedido = mudanca.safeParse({ dtFato: ontem, machos: { ...machos, soDoPedido: true } })

    expect(semPedido.success).toBe(false)
    expect(semPedido.error?.issues.map((issue) => issue.path)).toEqual([['machos', 'idPedido']])
    expect(mudanca.safeParse({ dtFato: ontem, machos: { ...machos, idPedido: 9, soDoPedido: true } }).success).toBe(true)
  })

  it('sem destino, ou com quantidade zero, e VALIDACAO', () => {
    expect(mudanca.safeParse({ dtFato: ontem, machos: { qtd: 3 } }).success).toBe(false)
    expect(mudanca.safeParse({ dtFato: ontem, machos: { qtd: 0, destino: { idCaixa: 2 } } }).success).toBe(false)
    expect(
      mudanca.safeParse({ dtFato: ontem, machos: { qtd: 1, destino: { posicao: { idEstante: 1, face: 'lateral', linha: 1, coluna: 1 } } } })
        .success,
    ).toBe(false)
  })
})
