import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { somarDias } from './cadeiaTemporal.ts'
import {
  casalNovo,
  correcaoDoAcasalamento,
  correcaoDoDesmame,
  correcaoDoNascimento,
  desmame,
  selecao,
} from './reproducao.routes.ts'

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

  it('o parto atual e opcional, inteiro de 1 a 5, com a mensagem no campo dele', () => {
    expect(casalNovo.safeParse(corpoValido).data?.partoAtual).toBeUndefined()
    expect(casalNovo.safeParse({ ...corpoValido, partoAtual: 1 }).success).toBe(true)
    expect(casalNovo.safeParse({ ...corpoValido, partoAtual: 5 }).success).toBe(true)

    for (const partoAtual of [0, 6, 2.5, '3']) {
      const resultado = casalNovo.safeParse({ ...corpoValido, partoAtual })
      expect(resultado.success).toBe(false)
      expect(resultado.error?.issues.map((issue) => issue.path)).toEqual([['partoAtual']])
    }
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

describe('validacao de entrada - nada se registra no futuro', () => {
  const amanha = somarDias(hojeISO(), 1)

  it('o casal se forma hoje, nao amanha', () => {
    expect(casalNovo.safeParse({ ...corpoValido, dtFormacao: hojeISO() }).success).toBe(true)
    expect(casalNovo.safeParse({ ...corpoValido, dtFormacao: amanha }).success).toBe(false)
  })

  it('parto, selecao, desmame e encerramento com data de amanha voltam 400', async () => {
    const rotas = [
      [
        'post',
        '/api/partos/1/nascimento',
        { dtPartoReal: amanha, nascidoM: 5, nascidoF: 6 },
        'dtPartoReal',
      ],
      [
        'post',
        '/api/partos/1/selecao',
        { dtSelecao: amanha, eutanasiadoM: 1, eutanasiadoF: 1 },
        'dtSelecao',
      ],
      [
        'post',
        '/api/partos/1/desmame',
        { dtDesmameReal: amanha, desmamadoM: 4, desmamadoF: 5 },
        'dtDesmameReal',
      ],
      [
        'post',
        '/api/casais/1/encerramento',
        { dtEncerramento: amanha, motivo: 'Teste' },
        'dtEncerramento',
      ],
      [
        'patch',
        '/api/partos/1/nascimento',
        { dtPartoReal: amanha, nascidoM: 5, nascidoF: 6, motivo: 'Erro' },
        'dtPartoReal',
      ],
      [
        'patch',
        '/api/partos/1/desmame',
        { dtDesmameReal: amanha, motivo: 'Erro' },
        'dtDesmameReal',
      ],
      ['patch', '/api/partos/1/acasalamento', { dtAcasalamento: amanha, motivo: 'Erro' }, 'dtAcasalamento'],
      ['post', '/api/partos/1/sem-ninhada', { dtSemNinhada: amanha, motivo: 'Não pariu' }, 'dtSemNinhada'],
    ] as const

    // a validacao barra antes do servico: nada chega ao banco
    for (const [metodo, caminho, corpo, campo] of rotas) {
      const resposta = await request(app('tecnico'))[metodo](caminho).send(corpo)
      expect(resposta.status, caminho).toBe(400)
      expect(resposta.body.erro.campos[campo], caminho).toBe('A data não pode ser depois de hoje.')
    }
  })

  it('o acasalamento nao se registra mais: abre sozinho no nascimento, e so se corrige', async () => {
    const resposta = await request(app('tecnico')).post('/api/casais/1/acasalamento').send({ dtAcasalamento: hojeISO() })

    expect(resposta.status).toBe(404)
  })

  it('o desmame de hoje passa', () => {
    expect(
      desmame.safeParse({ dtDesmameReal: hojeISO(), desmamadoM: 4, desmamadoF: 5 }).success,
    ).toBe(true)
  })
})

describe('validacao de entrada - modelo por rato', () => {
  it('a rodada de selecao tem ao menos um animal, e o pedido dos reservados e opcional', () => {
    expect(selecao.safeParse({ dtSelecao: '2026-05-25', eutanasiadoM: 0, eutanasiadoF: 0 }).success).toBe(false)
    expect(
      selecao.safeParse({ dtSelecao: '2026-05-25', eutanasiadoM: 1, eutanasiadoF: 0, idPedido: 3 }).success,
    ).toBe(true)
  })

  it('a correcao do desmame e so a data: a contagem se corrige pelas baixas', () => {
    const resultado = correcaoDoDesmame.safeParse({
      dtDesmameReal: '2026-06-16',
      desmamadoM: 4,
      desmamadoF: 5,
      motivo: 'data errada',
    })

    expect(resultado.data).toEqual({ dtDesmameReal: '2026-06-16', motivo: 'data errada' })
  })

  it('a correcao do nascimento aceita a caixa dos animais a mais', () => {
    const resultado = correcaoDoNascimento.safeParse({
      dtPartoReal: '2026-05-25',
      nascidoM: 6,
      nascidoF: 5,
      motivo: 'faltou um',
      idCaixa: 7,
    })

    expect(resultado.success).toBe(true)
  })

  it('a correcao sem motivo volta 400 no campo do motivo', async () => {
    const resposta = await request(app('tecnico'))
      .patch('/api/partos/1/desmame')
      .send({ dtDesmameReal: '2026-05-02', motivo: '' })

    expect(resposta.status).toBe(400)
    expect(Object.keys(resposta.body.erro.campos)).toContain('motivo')
  })

  it('a data do acasalamento se edita sem motivo', () => {
    expect(correcaoDoAcasalamento.safeParse({ dtAcasalamento: '2026-05-02' }).success).toBe(true)
    expect(correcaoDoAcasalamento.safeParse({ dtAcasalamento: '2026-05-02', motivo: 'x' }).success).toBe(true)
  })

  it('as rotas do modelo por caixa sairam: passagem por parto, destinos e correcao da selecao', async () => {
    const tecnico = request(app('tecnico'))

    expect((await tecnico.post('/api/partos/1/estoque').send({})).status).toBe(404)
    expect((await request(app('tecnico')).get('/api/partos/1/destinos-do-estoque')).status).toBe(404)
    expect(
      (await request(app('tecnico')).patch('/api/partos/1/selecao').send({ dtSelecao: '2026-05-25' })).status,
    ).toBe(404)
  })
})
