import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { criarApp } from '../../app.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { PARTES_POR_SEXO, caixaDeEstoqueNova, edicaoDoEstoque, mudanca } from './caixa.routes.ts'

// Autorizacao e validacao de forma. Nenhum teste aqui chega ao banco

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

describe('autorizacao da ficha e da posicao', () => {
  it('o kanban saiu: /api/quadro nao existe mais', async () => {
    const resposta = await request(app('tecnico')).get('/api/quadro').query({ especie: 'rato' })

    expect(resposta.status).toBe(404)
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

describe('mudanca de animais em varias caixas: a forma do corpo', () => {
  const ontem = somarDias(hojeISO(), -1)
  const parte = (n: number) => ({ qtd: 1, destino: { idCaixa: n } })
  const campos = (corpo: Record<string, unknown>) =>
    mudanca.safeParse({ dtFato: ontem, ...corpo }).error?.issues.map((issue) => issue.path.join('.'))

  it('o objeto antigo e a lista de 1 a 20 partes passam, nos dois sexos', () => {
    expect(mudanca.safeParse({ dtFato: ontem, machos: parte(2) }).success).toBe(true)
    expect(mudanca.safeParse({ dtFato: ontem, machos: [parte(2)] }).success).toBe(true)
    expect(mudanca.safeParse({ dtFato: ontem, machos: [parte(2), parte(3)], femeas: [parte(4), parte(5)] }).success).toBe(true)
    expect(
      mudanca.safeParse({ dtFato: ontem, femeas: Array.from({ length: PARTES_POR_SEXO }, (_, i) => parte(i + 2)) }).success,
    ).toBe(true)
  })

  it('cada parte da lista traz a data, o pedido e o so do pedido', () => {
    const lida = mudanca.safeParse({
      dtFato: ontem,
      machos: [
        { qtd: 2, dtNascimento: '2026-09-01', idPedido: 9, soDoPedido: true, destino: { idCaixa: 2 } },
        { qtd: 1, destino: { posicao: { idEstante: 1, face: 'frontal', linha: 2, coluna: 1 } } },
      ],
    })

    expect(lida.success).toBe(true)
    expect(lida.data?.machos).toEqual([
      { qtd: 2, dtNascimento: '2026-09-01', idPedido: 9, soDoPedido: true, destino: { idCaixa: 2 } },
      { qtd: 1, destino: { posicao: { idEstante: 1, face: 'frontal', linha: 2, coluna: 1 } } },
    ])
  })

  it('lista vazia: "Informe ao menos uma caixa." no campo do sexo', () => {
    const lida = mudanca.safeParse({ dtFato: ontem, machos: [] })

    expect(lida.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['machos', 'Informe ao menos uma caixa.']])
  })

  it('21 partes: "No maximo 20 caixas por sexo."', () => {
    const lida = mudanca.safeParse({ dtFato: ontem, femeas: Array.from({ length: PARTES_POR_SEXO + 1 }, (_, i) => parte(i + 2)) })

    expect(lida.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['femeas', 'No máximo 20 caixas por sexo.']])
  })

  it('o erro de uma parte cai no campo dela: quantidade zero, destino faltando', () => {
    expect(campos({ machos: [parte(2), { qtd: 0, destino: { idCaixa: 3 } }] })).toEqual(['machos.1.qtd'])
    expect(campos({ machos: [parte(2), { qtd: 1 }] })).toEqual(['machos.1.destino'])
    expect(campos({ femeas: [{ qtd: 1.5, destino: { idCaixa: 3 } }, parte(2)] })).toEqual(['femeas.0.qtd'])
    expect(campos({ machos: [{ qtd: 1, destino: { posicao: { idEstante: 1, face: 'lateral', linha: 1, coluna: 1 } } }] })).toEqual([
      'machos.0.destino',
    ])
  })

  it('so do pedido sem pedido: o erro vai em machos.N.idPedido, e no objeto antigo em machos.idPedido', () => {
    expect(campos({ machos: [parte(2), { ...parte(3), soDoPedido: true }] })).toEqual(['machos.1.idPedido'])
    expect(campos({ machos: { ...parte(2), soDoPedido: true } })).toEqual(['machos.idPedido'])
    expect(campos({ machos: [{ ...parte(2), soDoPedido: true }] })).toEqual(['machos.0.idPedido'])
  })

  it('o que nao e objeto nem lista e recusado no campo do sexo', () => {
    expect(campos({ machos: 'tres' })).toEqual(['machos'])
    expect(campos({ femeas: 3 })).toEqual(['femeas'])
    expect(campos({ machos: null })).toEqual(['machos'])
  })

  it('os erros de varias partes e dos dois sexos vem juntos, cada um no seu campo', () => {
    expect(campos({ machos: [{ qtd: 0, destino: { idCaixa: 3 } }, { qtd: 1 }], femeas: [{ qtd: 0, destino: { idCaixa: 4 } }] })).toEqual([
      'machos.0.qtd',
      'machos.1.destino',
      'femeas.0.qtd',
    ])
  })

  it('sem nenhum dos dois sexos, e uma lista vazia de um nao basta', () => {
    expect(campos({})).toEqual(['machos'])
    expect(campos({ femeas: [] })).toEqual(['femeas'])
  })

  it('pela rota, o erro de parte volta 400 VALIDACAO com o campo da parte', async () => {
    const resposta = await request(app('tecnico'))
      .post('/api/caixas/1/mudanca')
      .send({ dtFato: ontem, machos: [parte(2), { qtd: 0, destino: { idCaixa: 3 } }] })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(resposta.body.erro.campos).toHaveProperty(['machos.1.qtd'])
  })

  it('pela rota, lista vazia e 21 partes voltam 400 no campo do sexo', async () => {
    const vazia = await request(app('tecnico')).post('/api/caixas/1/mudanca').send({ dtFato: ontem, machos: [] })
    expect(vazia.status).toBe(400)
    expect(vazia.body.erro.campos).toEqual({ machos: 'Informe ao menos uma caixa.' })

    const muitas = await request(app('tecnico'))
      .post('/api/caixas/1/mudanca')
      .send({ dtFato: ontem, femeas: Array.from({ length: 21 }, (_, i) => parte(i + 2)) })
    expect(muitas.status).toBe(400)
    expect(muitas.body.erro.campos).toEqual({ femeas: 'No máximo 20 caixas por sexo.' })
  })

  it('pela rota, o formato antigo do pedido sem soDoPedido ainda e aceito (so falha no banco)', () => {
    expect(mudanca.safeParse({ dtFato: ontem, machos: { ...parte(2), idPedido: 9 } }).success).toBe(true)
  })
})

describe('o cadastro inicial do estoque', () => {
  const nascimento = somarDias(hojeISO(), -35)
  const nova = {
    posicao: { idEstante: 1, face: 'frontal', linha: 2, coluna: 1 },
    idLinhagem: 3,
    sexo: 'M',
    quantidade: 6,
    dtNascimento: nascimento,
  }

  it('so tecnico e gestor: o pesquisador recebe 403, sem sessao 401', async () => {
    expect((await request(app('pesquisador')).post('/api/caixas/estoque').send(nova)).status).toBe(403)
    expect((await request(app()).post('/api/caixas/estoque').send(nova)).status).toBe(401)
  })

  it('a posicao no formato do formar casal, o sexo, a quantidade de 1 a 999 e o nascimento ate hoje', () => {
    expect(caixaDeEstoqueNova.safeParse(nova).success).toBe(true)
    expect(caixaDeEstoqueNova.safeParse({ ...nova, sexo: 'F', quantidade: 999 }).success).toBe(true)

    const campos = (corpo: Record<string, unknown>) =>
      caixaDeEstoqueNova.safeParse(corpo).error?.issues.map((issue) => issue.path.join('.'))

    expect(campos({ ...nova, quantidade: 0 })).toEqual(['quantidade'])
    expect(campos({ ...nova, quantidade: 1000 })).toEqual(['quantidade'])
    expect(campos({ ...nova, quantidade: 1.5 })).toEqual(['quantidade'])
    expect(campos({ ...nova, sexo: 'X' })).toEqual(['sexo'])
    expect(campos({ ...nova, dtNascimento: somarDias(hojeISO(), 1) })).toEqual(['dtNascimento'])
    expect(campos({ ...nova, posicao: { ...nova.posicao, face: 'lateral' } })).toEqual(['posicao.face'])
    expect(campos({ ...nova, posicao: undefined })).toEqual(['posicao'])
  })

  it('acrescentar animais numa caixa que existe saiu: o cadastro so entra com a caixa nascendo', async () => {
    const resposta = await request(app('tecnico')).post('/api/caixas/1/entrada').send({ quantidade: 3, dtNascimento: nascimento })

    expect(resposta.status).toBe(404)
  })
})

describe('edicao da caixa de estoque', () => {
  it('pesquisador nao edita a caixa, e sem sessao e 401', async () => {
    expect((await request(app()).patch('/api/caixas/1').send({ sexo: 'M' })).status).toBe(401)

    const resposta = await request(app('pesquisador')).patch('/api/caixas/1').send({ sexo: 'M' })
    expect(resposta.status).toBe(403)
    expect(resposta.body.erro.codigo).toBe('SEM_PERMISSAO')
  })

  it('corpo vazio volta 400: ao menos um dado muda', async () => {
    const resposta = await request(app('gestor')).patch('/api/caixas/1').send({})

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('cada campo e opcional e sem motivo; sexo M ou F, nascimento nunca no futuro e uma vez por ninhada', () => {
    expect(edicaoDoEstoque.safeParse({ sexo: 'F' }).success).toBe(true)
    expect(edicaoDoEstoque.safeParse({ idLinhagem: 2, nascimentos: [{ idParto: 3, dtNascimento: '2026-09-01' }] }).success).toBe(true)
    expect(edicaoDoEstoque.safeParse({ sexo: 'X' }).success).toBe(false)
    expect(edicaoDoEstoque.safeParse({ nascimentos: [] }).success).toBe(false)
    expect(edicaoDoEstoque.safeParse({ nascimentos: [{ idParto: 3, dtNascimento: somarDias(hojeISO(), 1) }] }).success).toBe(false)
    expect(
      edicaoDoEstoque.safeParse({
        nascimentos: [
          { idParto: 3, dtNascimento: '2026-09-01' },
          { idParto: 3, dtNascimento: '2026-09-02' },
        ],
      }).success,
    ).toBe(false)
  })

  it('a quantidade de cada ninhada do cadastro e de 1 a 999, uma vez por ninhada, e basta sozinha', () => {
    expect(edicaoDoEstoque.safeParse({ quantidades: [{ idParto: 3, quantidade: 8 }] }).success).toBe(true)

    const campos = (quantidades: unknown) =>
      edicaoDoEstoque.safeParse({ quantidades }).error?.issues.map((issue) => issue.path.join('.'))

    expect(campos([{ idParto: 3, quantidade: 0 }])).toEqual(['quantidades.0.quantidade'])
    expect(campos([{ idParto: 3, quantidade: 1000 }])).toEqual(['quantidades.0.quantidade'])
    expect(campos([{ idParto: 3, quantidade: 1.5 }])).toEqual(['quantidades.0.quantidade'])
    expect(campos([])).toEqual(['quantidades'])
    expect(
      campos([
        { idParto: 3, quantidade: 2 },
        { idParto: 3, quantidade: 4 },
      ]),
    ).toEqual(['quantidades'])
  })
})
