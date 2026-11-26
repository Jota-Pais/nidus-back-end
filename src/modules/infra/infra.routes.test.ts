import type { RequestHandler } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { alteracaoDeFormato, formatoNovo } from './formato.routes.ts'
import { alteracaoDeEstante, estanteNova } from './infra.routes.ts'

// Autorizacao decidida no servidor e a forma da entrada das salas, dos formatos e das estantes. E o
// que este arquivo cobra: os servicos sao de mentira, e as regras deles ficam nos testes de cada um

const mocks = vi.hoisted(() => ({
  cadastrarEstante: vi.fn(async (_dados: unknown, _idUsuario: number) => ({ id: 9 })),
  alterarEstante: vi.fn(async (_id: number, _dados: unknown, _idUsuario: number) => ({ id: 1 })),
  removerEstante: vi.fn(async (_id: number, _idUsuario: number) => undefined),
  criarSala: vi.fn(async (_dados: unknown, _idUsuario: number) => ({ id: 5, nome: 'Sala 4' })),
  renomearSala: vi.fn(async (_id: number, _dados: unknown, _idUsuario: number) => ({ id: 1, nome: 'Sala A' })),
  removerSala: vi.fn(async (_id: number, _idUsuario: number) => undefined),
  listarFormatos: vi.fn(async () => ({ formatos: [] })),
  cadastrarFormato: vi.fn(async (_dados: unknown, _idUsuario: number) => ({ id: 5 })),
  alterarFormato: vi.fn(async (_id: number, _dados: unknown, _idUsuario: number) => ({ id: 1 })),
  removerFormato: vi.fn(async (_id: number, _idUsuario: number) => undefined),
}))

vi.mock('./infra.service.ts', () => ({
  listarEstantes: async () => ({ estantes: [] }),
  montarGrade: async () => ({ faces: [] }),
  cadastrarEstante: mocks.cadastrarEstante,
  alterarEstante: mocks.alterarEstante,
  removerEstante: mocks.removerEstante,
}))

vi.mock('./sala.service.ts', () => ({
  listarSalas: async () => ({ salas: [] }),
  criarSala: mocks.criarSala,
  renomearSala: mocks.renomearSala,
  removerSala: mocks.removerSala,
}))

vi.mock('./formato.service.ts', () => ({
  listarFormatos: mocks.listarFormatos,
  cadastrarFormato: mocks.cadastrarFormato,
  alterarFormato: mocks.alterarFormato,
  removerFormato: mocks.removerFormato,
}))

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

const estante = { idSala: 2, idFormato: 3, numeroVisivel: 'E-07' }
const formato = { nome: 'ALESCO Modelo 3', faces: 2, linhas: 6, colunas: 6 }

/** Cada escrita de sala, formato e estante, com um corpo valido */
const escritas = (perfil: Perfil) => {
  const quem = app(perfil)

  return Promise.all([
    request(quem).post('/api/estantes').send(estante),
    request(quem).patch('/api/estantes/1').send({ idFormato: 4 }),
    request(quem).delete('/api/estantes/1'),
    request(quem).post('/api/salas').send({ nome: 'Sala 4' }),
    request(quem).patch('/api/salas/1').send({ nome: 'Sala A' }),
    request(quem).delete('/api/salas/1'),
    request(quem).post('/api/formatos').send(formato),
    request(quem).patch('/api/formatos/1').send({ colunas: 7 }),
    request(quem).delete('/api/formatos/1'),
  ])
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear()
})

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

  it('pesquisador nao le as salas nem os formatos - 403', async () => {
    const respostas = await Promise.all([
      request(app('pesquisador')).get('/api/salas'),
      request(app('pesquisador')).get('/api/formatos'),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual([403, 403])
    expect(mocks.listarFormatos).not.toHaveBeenCalled()
  })

  it.each(['tecnico', 'gestor'] as const)('%s cadastra, edita e remove estante, sala e formato', async (perfil) => {
    const respostas = await escritas(perfil)

    expect(respostas.map((resposta) => resposta.status)).toEqual([201, 200, 204, 201, 200, 204, 201, 200, 204])
    expect(mocks.cadastrarEstante).toHaveBeenCalledWith(estante, 1)
    expect(mocks.alterarEstante).toHaveBeenCalledWith(1, { idFormato: 4 }, 1)
    expect(mocks.cadastrarFormato).toHaveBeenCalledWith(formato, 1)
    expect(mocks.alterarFormato).toHaveBeenCalledWith(1, { colunas: 7 }, 1)
    expect(mocks.removerFormato).toHaveBeenCalledWith(1, 1)
  })

  it('pesquisador nao escreve estante, sala nem formato - 403, sem chegar ao servico', async () => {
    const respostas = await escritas('pesquisador')

    expect(respostas.map((resposta) => resposta.status)).toEqual(Array(9).fill(403))
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled()
  })

  it('tecnico le os formatos', async () => {
    const resposta = await request(app('tecnico')).get('/api/formatos')

    expect(resposta.status).toBe(200)
    expect(resposta.body).toEqual({ formatos: [] })
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
  it('recusa cadastro de estante sem os campos obrigatorios, com campo a campo', async () => {
    const resposta = await request(app('gestor')).post('/api/estantes').send({ idSala: 2 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(Object.keys(resposta.body.erro.campos).sort()).toEqual(['idFormato', 'numeroVisivel'])
    expect(mocks.cadastrarEstante).not.toHaveBeenCalled()
  })

  it('recusa id nao numerico na grade', async () => {
    const resposta = await request(app('tecnico')).get('/api/estantes/abc/grade')

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('o cadastro pede a sala pelo id, e o nome solto e recusado', async () => {
    // A sala virou tabela: mandar so o nome, como antes, criaria estante sem sala
    const resposta = await request(app('gestor'))
      .post('/api/estantes')
      .send({ sala: 'Sala 2', idFormato: 3, numeroVisivel: 'E-07' })

    expect(resposta.status).toBe(400)
    expect(Object.keys(resposta.body.erro.campos)).toContain('idSala')
  })

  it('edicao de estante sem numero, sala nem formato e recusada', async () => {
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

  it('formato com id invalido na rota e recusado', async () => {
    const respostas = await Promise.all([
      request(app('tecnico')).patch('/api/formatos/abc').send({ nome: 'X' }),
      request(app('tecnico')).delete('/api/formatos/0'),
    ])

    expect(respostas.map((resposta) => resposta.status)).toEqual([400, 400])
    expect(mocks.alterarFormato).not.toHaveBeenCalled()
    expect(mocks.removerFormato).not.toHaveBeenCalled()
  })
})

describe('a estante aponta para o formato', () => {
  it('o cadastro descarta fabricante, modelo, medidas e capacidade mandados no corpo', () => {
    // As medidas sao as do formato: o que vier solto no corpo nao chega ao banco
    const validado = estanteNova.parse({
      ...estante,
      fabricante: 'ALESCO',
      modelo: 'Modelo 2',
      faces: 2,
      linhas: 5,
      colunas: 5,
      capacidade: 1,
    })

    expect(validado).toEqual(estante)
  })

  it('a edicao muda o numero, a sala e o formato, e descarta as medidas soltas', () => {
    expect(alteracaoDeEstante.parse({ idFormato: 4, faces: 1, linhas: 8, colunas: 7 })).toEqual({ idFormato: 4 })
    expect(alteracaoDeEstante.parse({ numeroVisivel: ' E-09 ', idSala: 2 })).toEqual({ numeroVisivel: 'E-09', idSala: 2 })
  })

  it('o formato vem pelo id', () => {
    expect(estanteNova.safeParse({ ...estante, idFormato: 'ALESCO Modelo 1' }).success).toBe(false)
    expect(estanteNova.safeParse({ ...estante, idFormato: 0 }).success).toBe(false)
  })
})

describe('o formato da estante', () => {
  /** As mensagens de cada campo recusado, como o tratador de erros monta */
  const campos = (resultado: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
    Object.fromEntries((resultado.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]))

  it('o nome vem sem espaco nas pontas, e o que nao e do formato e descartado', () => {
    expect(formatoNovo.parse({ ...formato, nome: '  ALESCO Modelo 3 ', capacidade: 72 })).toEqual(formato)
  })

  it('1 ou 2 faces, e linhas e colunas de 1 a 26', () => {
    expect(formatoNovo.safeParse({ ...formato, faces: 3 }).success).toBe(false)
    expect(formatoNovo.safeParse({ ...formato, faces: 0 }).success).toBe(false)
    expect(formatoNovo.safeParse({ ...formato, linhas: 27 }).success).toBe(false)
    expect(formatoNovo.safeParse({ ...formato, colunas: 0 }).success).toBe(false)
    expect(formatoNovo.safeParse({ ...formato, linhas: 2.5 }).success).toBe(false)
    expect(formatoNovo.safeParse({ ...formato, nome: '   ' }).success).toBe(false)
    expect(formatoNovo.safeParse({ ...formato, nome: 'x'.repeat(61) }).success).toBe(false)
    expect(formatoNovo.parse({ nome: 'Uma face', faces: 1, linhas: 26, colunas: 26 })).toMatchObject({ faces: 1, colunas: 26 })
  })

  it('faces x colunas nao passa das 26 letras do endereco, com a mensagem no campo das colunas', () => {
    // 2 faces x 14 colunas = 28 letras: a traseira continua as letras da frontal e faltariam duas
    expect(campos(formatoNovo.safeParse({ ...formato, faces: 2, colunas: 14 }))).toEqual({
      colunas: 'Faces x colunas não pode passar de 26 - o endereço ficaria sem letra.',
    })
    expect(formatoNovo.safeParse({ ...formato, faces: 2, colunas: 13 }).success).toBe(true)
  })

  it('a mesma recusa chega pela rota, como 400 VALIDACAO', async () => {
    const resposta = await request(app('tecnico')).post('/api/formatos').send({ ...formato, colunas: 20 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos).toEqual({ colunas: 'Faces x colunas não pode passar de 26 - o endereço ficaria sem letra.' })
    expect(mocks.cadastrarFormato).not.toHaveBeenCalled()
  })

  it('a edicao pede ao menos um campo, e cada um vem com as mesmas faixas do cadastro', () => {
    expect(campos(alteracaoDeFormato.safeParse({}))).toEqual({ nome: 'Informe o que alterar.' })
    expect(alteracaoDeFormato.safeParse({ faces: 3 }).success).toBe(false)
    expect(alteracaoDeFormato.safeParse({ nome: '' }).success).toBe(false)
    expect(alteracaoDeFormato.parse({ linhas: 6, fabricante: 'X' })).toEqual({ linhas: 6 })
  })

  it('a edicao deixa faces x colunas para o servico, que combina com o que o formato ja tem', () => {
    // So o servico sabe as faces de hoje: 14 colunas passa aqui, e e la que 2 faces x 14 e recusado
    expect(alteracaoDeFormato.parse({ colunas: 14 })).toEqual({ colunas: 14 })
  })
})
