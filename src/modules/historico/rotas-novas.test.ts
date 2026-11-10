import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

describe('so o gestor administra', () => {
  it('historico, contas, projetos e linhagens recusam o tecnico', async () => {
    const tecnico = app('tecnico')
    const respostas = await Promise.all([
      request(tecnico).get('/api/historico'),
      request(tecnico).get('/api/usuarios'),
      request(tecnico).post('/api/usuarios').send({}),
      request(tecnico).patch('/api/usuarios/1').send({ ativo: false }),
      request(tecnico).post('/api/usuarios/1/redefinicao-de-senha'),
      request(tecnico).post('/api/projetos').send({}),
      request(tecnico).put('/api/projetos/1').send({}),
      request(tecnico).post('/api/catalogo/linhagens').send({}),
      request(tecnico).patch('/api/catalogo/linhagens/1').send({ ativa: false }),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual(Array(9).fill(403))
  })
})

describe('o pesquisador nao opera a colonia', () => {
  it('nao recusa pedido nem corrige evento', async () => {
    const pesquisador = app('pesquisador')
    const respostas = await Promise.all([
      request(pesquisador).post('/api/pedidos/1/recusa').send({ motivo: 'x' }),
      request(pesquisador)
        .patch('/api/partos/1/nascimento')
        .send({ dtPartoReal: '2026-10-01', nascidoM: 1, nascidoF: 1, motivo: 'x' }),
      request(pesquisador)
        .patch('/api/partos/1/acasalamento')
        .send({ dtAcasalamento: '2026-10-01', motivo: 'x' }),
      request(pesquisador)
        .patch('/api/partos/1/desmame')
        .send({ dtDesmameReal: '2026-10-01', motivo: 'x' }),
      request(pesquisador).post('/api/ocorrencias/1/anulacao').send({ motivo: 'x' }),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual([403, 403, 403, 403, 403])
  })

  it('nao le a colonia: visao geral, busca, estantes, caixas, projetos nem historico', async () => {
    // ele so ve o proprio pedido (GET /api/pedidos) e o catalogo do formulario
    const pesquisador = app('pesquisador')
    const respostas = await Promise.all([
      request(pesquisador).get('/api/visao-geral'),
      request(pesquisador)
        .get('/api/busca')
        .query({ especie: 'rato', machos: 1, femeas: 1, qualquer: 0, idadeMin: 28, idadeMax: 28 }),
      request(pesquisador).get('/api/estantes'),
      request(pesquisador).get('/api/estantes/1/grade'),
      request(pesquisador).get('/api/caixas/1'),
      request(pesquisador).get('/api/projetos'),
      request(pesquisador).get('/api/historico'),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual(Array(7).fill(403))
  })
})

describe('forma da entrada', () => {
  it('recusa sem motivo e correcao sem motivo sao VALIDACAO', async () => {
    const tecnico = app('tecnico')
    const recusa = await request(tecnico).post('/api/pedidos/1/recusa').send({ motivo: ' ' })
    const correcao = await request(tecnico)
      .patch('/api/partos/1/nascimento')
      .send({ dtPartoReal: '2026-10-01', nascidoM: 1, nascidoF: 1 })

    expect(recusa.status).toBe(400)
    expect(correcao.status).toBe(400)
    expect(correcao.body.erro.campos).toHaveProperty('motivo')
  })

  it('conta nova com e-mail invalido e VALIDACAO', async () => {
    const email = await request(app('gestor'))
      .post('/api/usuarios')
      .send({ nome: 'Bia', email: 'bia', perfil: 'tecnico' })

    expect(email.status).toBe(400)
  })

  it('a rota antiga de senha do gestor nao existe mais', async () => {
    const resposta = await request(app('gestor')).post('/api/usuarios/1/senha').send({ senha: '12345678' })

    expect(resposta.status).toBe(404)
  })

  it('o estoque entrou na visao geral: /api/estoque nao existe mais', async () => {
    const resposta = await request(app('tecnico')).get('/api/estoque').query({ especie: 'rato' })

    expect(resposta.status).toBe(404)
  })
})
