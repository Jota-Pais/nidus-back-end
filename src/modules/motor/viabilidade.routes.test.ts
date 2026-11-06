import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { criarApp } from '../../app.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { DATA_PROXIMA_DEMAIS } from './viabilidade.service.ts'

// POST /api/solicitacoes/viabilidade com o banco de mentira e a colonia vazia: quem decide e a
// timeline reversa. As datas partem do dia de hoje, porque a rota valida a entrega contra hoje

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    linhagem: { findUnique: async () => ({ especie: { nome: 'Rato' } }) },
    especie: { findMany: async () => [{ id: 1, nome: 'Rato' }] },
    caixa: { findMany: async () => [] },
  },
}))

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

const ROTA = '/api/solicitacoes/viabilidade'

/** o mesmo corpo do POST /api/solicitacoes */
const pedido = {
  nomePesquisador: 'Ana Souza',
  protocoloCeua: '23080.001234/2026-74',
  idLinhagem: 1,
  machos: 2,
  femeas: 2,
  qualquer: 0,
  idadeMin: 21,
  idadeMax: 30,
  dataEntrega: somarDias(hojeISO(), 100),
}

describe('POST /api/solicitacoes/viabilidade', () => {
  it('sem sessao devolve 401', async () => {
    const resposta = await request(app()).post(ROTA).send(pedido)

    expect(resposta.status).toBe(401)
  })

  it('qualquer perfil logado confere, e a resposta e so o veredito', async () => {
    for (const perfil of ['pesquisador', 'tecnico', 'gestor'] as const) {
      const resposta = await request(app(perfil)).post(ROTA).send(pedido)

      expect(resposta.status).toBe(200)
      expect(resposta.body).toEqual({ viavel: true, motivo: null })
    }
  })

  it('data curta demais para acasalamento novo nao da, com o motivo para quem pede', async () => {
    const resposta = await request(app('pesquisador'))
      .post(ROTA)
      .send({ ...pedido, dataEntrega: somarDias(hojeISO(), 1) })

    expect(resposta.status).toBe(200)
    expect(resposta.body).toEqual({ viavel: false, motivo: DATA_PROXIMA_DEMAIS })
  })

  it('corpo invalido e VALIDACAO, com as mesmas regras do pedido', async () => {
    const resposta = await request(app('pesquisador'))
      .post(ROTA)
      .send({ ...pedido, machos: 0, femeas: 0 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })
})
