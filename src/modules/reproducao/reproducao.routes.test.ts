import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { casalNovo, desmame } from './reproducao.routes.ts'

// Autorizacao e validacao de forma - o mesmo recorte de
// 'infra.routes.test.ts'. Sucesso com dado real (as regras
// encadeadas) precisa de banco e fica fora desta suite

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

const corpoValido = {
  idCaixa: 1,
  idLinhagem: 1,
  grupoMacho: 'A',
  grupoFemea: 'B',
  dtFormacao: '2026-05-02',
}

describe('autorizacao das rotas de reproducao', () => {
  it('formar casal sem sessao devolve 401', async () => {
    const resposta = await request(app()).post('/api/casais').send(corpoValido)

    expect(resposta.status).toBe(401)
    expect(resposta.body.erro.codigo).toBe('NAO_AUTENTICADO')
  })

  it('pesquisador nao forma casal - ele nao enxerga a colonia', async () => {
    const resposta = await request(app('pesquisador')).post('/api/casais').send(corpoValido)

    expect(resposta.status).toBe(403)
    expect(resposta.body.erro.codigo).toBe('SEM_PERMISSAO')
  })

  it('pesquisador tambem nao registra parto, selecao, desmame ou encerramento', async () => {
    const rotas = [
      ['/api/partos/1/nascimento', { dtPartoReal: '2026-05-25', nascidoM: 5, nascidoF: 6 }],
      ['/api/partos/1/selecao', { dtSelecao: '2026-05-25', eutanasiadoM: 1, eutanasiadoF: 1 }],
      ['/api/partos/1/desmame', { dtDesmameReal: '2026-06-16', desmamadoM: 4, desmamadoF: 5 }],
      ['/api/casais/1/encerramento', { dtEncerramento: '2026-05-25', motivo: 'Teste' }],
    ] as const

    for (const [caminho, corpo] of rotas) {
      const resposta = await request(app('pesquisador')).post(caminho).send(corpo)
      expect(resposta.status).toBe(403)
    }
  })
})

describe('validacao de entrada - formacao de casal', () => {
  it('recusa corpo sem os campos obrigatorios, campo a campo', async () => {
    const resposta = await request(app('tecnico')).post('/api/casais').send({ idCaixa: 1 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(Object.keys(resposta.body.erro.campos)).toContain('idLinhagem')
  })

  it('recusa grupo genetico fora do dominio A-E', () => {
    const resultado = casalNovo.safeParse({ ...corpoValido, grupoMacho: 'Z' })

    expect(resultado.success).toBe(false)
  })

  it('aceita formar casal numa posicao vazia, sem caixa', () => {
    const { idCaixa: _semCaixa, ...semCaixa } = corpoValido
    const resultado = casalNovo.safeParse({
      ...semCaixa,
      posicao: { idEstante: 2, face: 'traseira', linha: 1, coluna: 3 },
    })

    expect(resultado.success).toBe(true)
  })

  it('recusa caixa e posicao juntas, e recusa nenhuma das duas', () => {
    const posicao = { idEstante: 2, face: 'frontal', linha: 1, coluna: 1 }
    const { idCaixa: _semCaixa, ...semCaixa } = corpoValido

    expect(casalNovo.safeParse({ ...corpoValido, posicao }).success).toBe(false)
    expect(casalNovo.safeParse(semCaixa).success).toBe(false)
  })

  it('recusa data fora do formato aaaa-mm-dd', () => {
    const resultado = casalNovo.safeParse({ ...corpoValido, dtFormacao: '02/05/2026' })

    expect(resultado.success).toBe(false)
  })

  it('id de caixa nao numerico na URL vira 400, nao 500', async () => {
    const resposta = await request(app('tecnico'))
      .post('/api/partos/abc/nascimento')
      .send({ dtPartoReal: '2026-05-25', nascidoM: 5, nascidoF: 6 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })
})

describe('validacao de entrada - desmame', () => {
  it('descarta o idCaixaRecria que o front ainda manda', () => {
    const resultado = desmame.safeParse({
      dtDesmameReal: '2026-06-16',
      desmamadoM: 4,
      desmamadoF: 5,
      idCaixaRecria: null,
    })

    expect(resultado.success).toBe(true)
    expect(resultado.data).toEqual({ dtDesmameReal: '2026-06-16', desmamadoM: 4, desmamadoF: 5 })
  })

  it('recusa desmame sem a contagem, campo a campo', async () => {
    // a validacao barra antes do servico: nada chega ao banco
    const resposta = await request(app('tecnico'))
      .post('/api/partos/1/desmame')
      .send({ dtDesmameReal: '2026-06-16', desmamadoM: 4 })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(Object.keys(resposta.body.erro.campos)).toContain('desmamadoF')
  })
})
