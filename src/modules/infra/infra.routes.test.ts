import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { capacidadeDerivada } from './infra.service.ts'
import { alteracaoDeEstante, estanteNova } from './infra.routes.ts'

// Autorizacao decidida no servidor. E o que este arquivo cobra

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

describe('autorizacao das rotas de infraestrutura', () => {
  it('sem sessao devolve 401, nao 403', async () => {
    // A ordem importa: 403 aqui contaria a quem nem esta logado que o recurso existe
    const resposta = await request(app()).get('/api/estantes')

    expect(resposta.status).toBe(401)
    expect(resposta.body.erro.codigo).toBe('NAO_AUTENTICADO')
  })

  it('pesquisador nao enxerga a colonia - 403', async () => {
    // Ele recebe MENOS dados, nao os mesmos filtrados no cliente
    const resposta = await request(app('pesquisador')).get('/api/estantes')

    expect(resposta.status).toBe(403)
    expect(resposta.body.erro.codigo).toBe('SEM_PERMISSAO')
  })

  it('pesquisador tambem nao alcanca a grade', async () => {
    const resposta = await request(app('pesquisador')).get('/api/estantes/1/grade')

    expect(resposta.status).toBe(403)
  })

  it('cadastrar estante e so do gestor - tecnico recebe 403', async () => {
    // Cadastro de modelo novo e operacao de admin
    const resposta = await request(app('tecnico')).post('/api/estantes').send({
      idSala: 2,
      fabricante: 'ALESCO',
      modelo: 'Modelo 2',
      numeroVisivel: 'E-07',
      faces: 2,
      linhas: 5,
      colunas: 5,
    })

    expect(resposta.status).toBe(403)
  })

  it('cadastrar, renomear e remover sala e so do gestor - tecnico recebe 403', async () => {
    const tecnico = app('tecnico')
    const respostas = await Promise.all([
      request(tecnico).post('/api/salas').send({ nome: 'Sala 4' }),
      request(tecnico).patch('/api/salas/1').send({ nome: 'Sala A' }),
      request(tecnico).delete('/api/salas/1'),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual([403, 403, 403])
  })

  it('editar e remover estante e so do gestor - tecnico recebe 403', async () => {
    const tecnico = app('tecnico')
    const respostas = await Promise.all([
      request(tecnico).patch('/api/estantes/1').send({ numeroVisivel: 'E-09' }),
      request(tecnico).delete('/api/estantes/1'),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual([403, 403])
  })

  it('pesquisador nao le as salas - 403', async () => {
    const resposta = await request(app('pesquisador')).get('/api/salas')

    expect(resposta.status).toBe(403)
  })

  it('rota inexistente sob /api nao vira 401 pela autenticacao', async () => {
    // A autenticacao esta montada em '/api' inteiro e nao pode transformar "essa rota nao
    // existe" em "faca login"
    const resposta = await request(app('tecnico')).get('/api/nao-existe')

    expect(resposta.status).toBe(404)
    expect(resposta.body.erro.codigo).toBe('NAO_ENCONTRADO')
  })
})

describe('validacao de entrada das rotas de infraestrutura', () => {
  it('recusa cadastro sem os campos obrigatorios, com campo a campo', async () => {
    const resposta = await request(app('gestor')).post('/api/estantes').send({ idSala: 2 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(Object.keys(resposta.body.erro.campos)).toContain('fabricante')
  })

  it('recusa topologia que estoura o alfabeto do endereco', async () => {
    // 2 faces x 20 colunas = 40 letras e o alfabeto tem 26. Sobraria coluna
    // sem letra no endereco.
    const resposta = await request(app('gestor')).post('/api/estantes').send({
      idSala: 2,
      fabricante: 'GENERICA',
      modelo: 'Modelo X',
      numeroVisivel: 'E-99',
      faces: 2,
      linhas: 4,
      colunas: 20,
    })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos.colunas).toMatch(/sem letra/)
  })

  it('recusa id nao numerico na grade', async () => {
    const resposta = await request(app('tecnico')).get('/api/estantes/abc/grade')

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('o cadastro pede a sala pelo id, e o nome solto e recusado', async () => {
    // A sala virou tabela: mandar so o nome, como antes, criaria estante sem sala
    const resposta = await request(app('gestor')).post('/api/estantes').send({
      sala: 'Sala 2',
      fabricante: 'ALESCO',
      modelo: 'Modelo 2',
      numeroVisivel: 'E-07',
      faces: 2,
      linhas: 5,
      colunas: 5,
    })

    expect(resposta.status).toBe(400)
    expect(Object.keys(resposta.body.erro.campos)).toContain('idSala')
  })

  it('edicao sem numero nem sala e recusada', async () => {
    const resposta = await request(app('gestor')).patch('/api/estantes/1').send({})

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos.numeroVisivel).toBe('Informe o que alterar.')
  })

  it('remocao de estante com id nao numerico e recusada', async () => {
    const resposta = await request(app('gestor')).delete('/api/estantes/abc')

    expect(resposta.status).toBe(400)
  })

  it('sala sem nome, so com espaco ou com id invalido e recusada', async () => {
    const respostas = await Promise.all([
      request(app('gestor')).post('/api/salas').send({}),
      request(app('gestor')).post('/api/salas').send({ nome: '   ' }),
      request(app('gestor')).patch('/api/salas/1').send({ nome: '' }),
      request(app('gestor')).delete('/api/salas/0'),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual([400, 400, 400, 400])
    expect(Object.keys(respostas[0]?.body.erro.campos)).toContain('nome')
  })
})

describe('o modelo da estante nao muda depois do cadastro', () => {
  it('a edicao descarta fabricante, modelo e topologia mandados no corpo', () => {
    // Para trocar o modelo, remove e cadastra de novo: a grade e as caixas dependem da topologia
    const validado = alteracaoDeEstante.parse({
      numeroVisivel: 'E-09',
      fabricante: 'TECNIPLAST',
      modelo: 'Modelo 1',
      faces: 1,
      linhas: 8,
      colunas: 7,
    })

    expect(validado).toEqual({ numeroVisivel: 'E-09' })
  })
})

describe('capacidade da estante e derivada, nunca do cliente', () => {
  const topologia = {
    idSala: 2,
    fabricante: 'ALESCO',
    modelo: 'Modelo 2',
    numeroVisivel: 'E-07',
    faces: 2,
    linhas: 5,
    colunas: 5,
  }

  it('o schema descarta `capacidade` mandada no corpo', () => {
    // sem isto, capacidade: 1 numa estante 2x5x5 entraria no banco e o
    // CHECK 'estante_capacidade_derivada' recusaria o insert - erro 500 no
    // lugar de um campo simplesmente ignorado. Conferido no schema, sem
    // tocar o banco
    const validado = estanteNova.parse({ ...topologia, capacidade: 1 })

    expect(validado).not.toHaveProperty('capacidade')
    expect(validado).toEqual(topologia)
  })

  it('deriva faces x linhas x colunas, como os quatro modelos de estante', () => {
    expect(capacidadeDerivada(2, 8, 8)).toBe(128)
    expect(capacidadeDerivada(2, 5, 5)).toBe(50)
    expect(capacidadeDerivada(2, 8, 7)).toBe(112)
    expect(capacidadeDerivada(2, 5, 4)).toBe(40)
  })
})
