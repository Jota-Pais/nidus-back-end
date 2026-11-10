import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { anulacao, baixa } from './colonia.routes.ts'

// Autorizacao e validacao de forma, como nas outras suites de rota: o servico nao e chamado

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) => criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

const baixaValida = { dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 2 }] }

describe('autorizacao da baixa e da anulacao', () => {
  it('sem sessao e 401; pesquisador e 403', async () => {
    expect((await request(app()).post('/api/caixas/6/baixa').send(baixaValida)).status).toBe(401)
    expect((await request(app('pesquisador')).post('/api/caixas/6/baixa').send(baixaValida)).status).toBe(403)
    expect(
      (await request(app('pesquisador')).post('/api/ocorrencias/3/anulacao').send({ motivo: 'engano' })).status,
    ).toBe(403)
  })
})

describe('validacao da baixa', () => {
  it('aceita sexo, quantidade, idade e pedido opcionais', () => {
    expect(
      baixa.safeParse({
        dtFato: '2026-11-02',
        motivo: 'morte',
        itens: [{ sexo: 'F', qtd: 1, dtNascimento: '2026-09-01', idPedido: 3 }],
      }).success,
    ).toBe(true)
  })

  it('recusa baixa sem animal, quantidade zero e sexo fora de M/F', () => {
    expect(baixa.safeParse({ dtFato: '2026-11-02', itens: [] }).success).toBe(false)
    expect(baixa.safeParse({ dtFato: '2026-11-02', itens: [{ sexo: 'M', qtd: 0 }] }).success).toBe(false)
    expect(baixa.safeParse({ dtFato: '2026-11-02', itens: [{ sexo: 'X', qtd: 1 }] }).success).toBe(false)
  })

  it('nada no futuro: a baixa de amanha volta 400 no campo da data, antes do banco', async () => {
    const resposta = await request(app('tecnico'))
      .post('/api/caixas/6/baixa')
      .send({ ...baixaValida, dtFato: somarDias(hojeISO(), 1) })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos.dtFato).toBe('A data não pode ser depois de hoje.')
  })

  it('id da caixa que nao e numero vira 400', async () => {
    const resposta = await request(app('tecnico')).post('/api/caixas/abc/baixa').send(baixaValida)

    expect(resposta.status).toBe(400)
  })
})

describe('validacao da anulacao', () => {
  it('o motivo e obrigatorio; a caixa de cada sexo e opcional', async () => {
    expect(anulacao.safeParse({ motivo: 'engano' }).success).toBe(true)
    expect(anulacao.safeParse({ motivo: 'engano', idCaixaMachos: 7, idCaixaFemeas: 9 }).data).toEqual({
      motivo: 'engano',
      idCaixaMachos: 7,
      idCaixaFemeas: 9,
    })

    const resposta = await request(app('tecnico')).post('/api/ocorrencias/3/anulacao').send({ motivo: ' ' })

    expect(resposta.status).toBe(400)
    expect(Object.keys(resposta.body.erro.campos)).toContain('motivo')
  })

  it('a caixa de um sexo que nao e um id e recusada no campo dele', async () => {
    const resposta = await request(app('tecnico'))
      .post('/api/ocorrencias/3/anulacao')
      .send({ motivo: 'engano', idCaixaFemeas: 0 })

    expect(resposta.status).toBe(400)
    expect(Object.keys(resposta.body.erro.campos)).toEqual(['idCaixaFemeas'])
  })
})
