import type { RequestHandler } from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { criarApp } from '../../app.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { Perfil } from '../../shared/traducao.ts'
import { filtroDaBusca } from '../motor/motor.routes.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { alocacao, entrega, pedidoNovo, projetoNovo } from './demanda.routes.ts'

// Autorizacao e forma da entrada. Nenhum teste aqui chega ao banco

const como = (perfil: Perfil): RequestHandler => (req, _res, next) => {
  req.usuario = { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil }
  next()
}

const app = (perfil?: Perfil) =>
  criarApp(perfil === undefined ? {} : { autenticacao: como(perfil) })

const pedido = {
  nomePesquisador: 'Paula Lima',
  protocoloCeua: '23080.001234/2026-74',
  idLinhagem: 1,
  machos: 10,
  femeas: 5,
  qualquer: 0,
  idadeMin: 28,
  idadeMax: 28,
  // a entrega nao pode estar no passado: o teste anda junto com o calendario
  dataEntrega: somarDias(hojeISO(), 30),
}

/** os erros de campo de um corpo recusado, como a API manda em VALIDACAO */
async function camposRecusados(corpo: object) {
  const resposta = await request(app('pesquisador')).post('/api/pedidos').send(corpo)

  expect(resposta.status).toBe(400)
  expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  return resposta.body.erro.campos as Record<string, string>
}

describe('autorizacao', () => {
  it('sem sessao nao lista nem cria pedido', async () => {
    expect((await request(app()).get('/api/pedidos')).status).toBe(401)
    expect((await request(app()).post('/api/pedidos').send(pedido)).status).toBe(401)
  })

  it('o pesquisador nao usa a busca de atendimento nem aloca caixa', async () => {
    const busca = await request(app('pesquisador'))
      .get('/api/busca')
      .query({ especie: 'rato', machos: 1, femeas: 1, qualquer: 0, idadeMin: 28, idadeMax: 28 })
    const alocacao = await request(app('pesquisador'))
      .post('/api/pedidos/1/alocacao')
      .send({ itens: [{ idCaixa: 1, dtNascimento: '2026-09-01', machos: 1, femeas: 0 }] })

    expect(busca.status).toBe(403)
    expect(alocacao.status).toBe(403)
  })

  it('o pesquisador nao aprova pedido nem desfaz reserva', async () => {
    const aprovacao = await request(app('pesquisador')).post('/api/pedidos/1/aprovacao')
    const devolucao = await request(app('pesquisador')).post('/api/pedidos/1/devolucao')

    expect(aprovacao.status).toBe(403)
    expect(devolucao.status).toBe(403)
  })

  it('so o pesquisador cria pedido', async () => {
    expect((await request(app('tecnico')).post('/api/pedidos').send(pedido)).status).toBe(403)
    expect((await request(app('gestor')).post('/api/pedidos').send(pedido)).status).toBe(403)
  })

  it('o pesquisador nao registra entrega', async () => {
    const resposta = await request(app('pesquisador'))
      .post('/api/pedidos/1/entrega')
      .send({ dtEntrega: '2026-10-30' })

    expect(resposta.status).toBe(403)
  })
})

describe('lista de projetos', () => {
  it('so o gestor lista: quem pede digita o protocolo e nao ve o dos outros', async () => {
    const pesquisador = await request(app('pesquisador')).get('/api/projetos')
    const tecnico = await request(app('tecnico')).get('/api/projetos')

    expect(pesquisador.status).toBe(403)
    expect(tecnico.status).toBe(403)
  })
})

describe('forma do projeto', () => {
  const projeto = {
    numero: '23080.001234/2026-74',
    titulo: 'Estudo',
    idUsuarioResponsavel: 5,
    dtVigenciaInicio: '2026-01-01',
    dtVigenciaFim: '2026-12-31',
    cotaAutorizada: 120,
    situacao: 'vigente',
  }

  it('o numero segue a regra do protocolo: o que o gestor cadastra, o pesquisador consegue pedir', async () => {
    expect(projetoNovo.safeParse(projeto).success).toBe(true)
    expect(projetoNovo.safeParse({ ...projeto, numero: '3106240920' }).success).toBe(true)

    const resposta = await request(app('gestor'))
      .post('/api/projetos')
      .send({ ...projeto, numero: '23080.001234/2026-11' })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos.numero).toBe('Dígito verificador errado. Confira o número do processo.')
  })
})

describe('forma do pedido', () => {
  it('aceita o pedido completo', () => {
    expect(pedidoNovo.safeParse(pedido).success).toBe(true)
  })

  it('aceita faixa de idade e pedido so de qualquer sexo', () => {
    const faixa = pedidoNovo.safeParse({ ...pedido, machos: 0, femeas: 0, qualquer: 10, idadeMin: 21, idadeMax: 40 })

    expect(faixa.success).toBe(true)
    expect(faixa.data).toMatchObject({ qualquer: 10, idadeMin: 21, idadeMax: 40 })
  })

  it('soma zero e VALIDACAO no campo machos', async () => {
    const campos = await camposRecusados({ ...pedido, machos: 0, femeas: 0, qualquer: 0 })

    expect(campos.machos).toBe('Peça ao menos um animal.')
  })

  it('numero de animais negativo ou quebrado e VALIDACAO com mensagem em portugues', async () => {
    const campos = await camposRecusados({ ...pedido, femeas: -1, qualquer: 2.5 })

    expect(campos.femeas).toBe('O número de animais não pode ser negativo.')
    expect(campos.qualquer).toBe('Use um número inteiro de animais.')
  })

  it('idade maxima menor que a minima e VALIDACAO no campo idadeMax', async () => {
    const campos = await camposRecusados({ ...pedido, idadeMin: 30, idadeMax: 25 })

    expect(campos.idadeMax).toBe('A idade máxima não pode ser menor que a mínima.')
  })

  it('data de entrega no passado e VALIDACAO no campo dataEntrega', async () => {
    const campos = await camposRecusados({ ...pedido, dataEntrega: somarDias(hojeISO(), -1) })

    expect(campos.dataEntrega).toBe('A data de entrega já passou.')
  })

  it('a entrega pode ser hoje', () => {
    expect(pedidoNovo.safeParse({ ...pedido, dataEntrega: hojeISO() }).success).toBe(true)
  })

  describe('hoje e o dia de Brasilia, nao o de UTC', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('das 21h a meia-noite de Brasilia, a entrega para hoje passa, mesmo com o UTC no dia seguinte', () => {
      // 30/10 as 23h30 em Brasilia, 31/10 as 02h30 em UTC
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-31T02:30:00.000Z'))

      expect(pedidoNovo.safeParse({ ...pedido, dataEntrega: '2026-10-30' }).success).toBe(true)
      expect(pedidoNovo.safeParse({ ...pedido, dataEntrega: '2026-10-29' }).success).toBe(false)
    })

    it('depois da meia-noite de Brasilia, o dia anterior ja passou', () => {
      // 31/10 a 00h30 em Brasilia
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-31T03:30:00.000Z'))

      expect(pedidoNovo.safeParse({ ...pedido, dataEntrega: '2026-10-31' }).success).toBe(true)
      expect(pedidoNovo.safeParse({ ...pedido, dataEntrega: '2026-10-30' }).success).toBe(false)
    })
  })

  it('protocolo fora do formato e VALIDACAO no campo protocoloCeua', async () => {
    const campos = await camposRecusados({ ...pedido, protocoloCeua: '23080.1234/2026-11' })

    expect(campos).toHaveProperty('protocoloCeua')
  })

  it('protocolo com verificador errado e VALIDACAO, e o numero do Sistema CEUA passa', async () => {
    const campos = await camposRecusados({ ...pedido, protocoloCeua: '23080.001234/2026-11' })

    expect(campos.protocoloCeua).toBe('Dígito verificador errado. Confira o número do processo.')
    expect(pedidoNovo.safeParse({ ...pedido, protocoloCeua: '3106240920' }).success).toBe(true)
  })

  it('o nome e obrigatorio e vai ate 120 caracteres, sem contar os espacos das pontas', () => {
    expect(pedidoNovo.safeParse({ ...pedido, nomePesquisador: '   ' }).success).toBe(false)
    expect(pedidoNovo.safeParse({ ...pedido, nomePesquisador: 'a'.repeat(121) }).success).toBe(false)
    expect(pedidoNovo.parse({ ...pedido, nomePesquisador: `  ${'a'.repeat(120)}  ` }).nomePesquisador).toHaveLength(120)
  })

  it('recusa idade fora de 21 a 300 dias e mais de 9999 animais', () => {
    expect(pedidoNovo.safeParse({ ...pedido, idadeMin: 20, idadeMax: 28 }).success).toBe(false)
    expect(pedidoNovo.safeParse({ ...pedido, idadeMin: 28, idadeMax: 301 }).success).toBe(false)
    expect(pedidoNovo.safeParse({ ...pedido, idadeMin: 301, idadeMax: 301 }).success).toBe(false)
    expect(pedidoNovo.safeParse({ ...pedido, qualquer: 10_000 }).success).toBe(false)
    expect(pedidoNovo.safeParse({ ...pedido, machos: 9999, femeas: 9999, qualquer: 9999, idadeMin: 300, idadeMax: 300 }).success).toBe(true)
  })

  it('observacoes vazias, ausentes ou null viram null, e passam de 500 caracteres e VALIDACAO', () => {
    expect(pedidoNovo.parse(pedido).observacoes).toBeNull()
    expect(pedidoNovo.parse({ ...pedido, observacoes: null }).observacoes).toBeNull()
    expect(pedidoNovo.parse({ ...pedido, observacoes: '   ' }).observacoes).toBeNull()
    expect(pedidoNovo.parse({ ...pedido, observacoes: ' Machos do mesmo parto. ' }).observacoes).toBe('Machos do mesmo parto.')
    expect(pedidoNovo.safeParse({ ...pedido, observacoes: 'a'.repeat(501) }).success).toBe(false)
  })

  it('o corpo antigo, com idProjeto e idade, e VALIDACAO', async () => {
    const campos = await camposRecusados({
      idProjeto: 1,
      idLinhagem: 1,
      machos: 10,
      femeas: 5,
      idade: 28,
      dataEntrega: pedido.dataEntrega,
      cronograma: 'unica',
    })

    expect(Object.keys(campos)).toEqual(
      expect.arrayContaining(['nomePesquisador', 'protocoloCeua', 'qualquer', 'idadeMin', 'idadeMax']),
    )
  })

})

describe('forma da reserva e da entrega', () => {
  const item = { idCaixa: 2, dtNascimento: '2026-09-01', machos: 3, femeas: 0 }

  it('a reserva fala do lugar: a caixa e a data de nascimento, com machos e femeas', () => {
    expect(alocacao.safeParse({ itens: [item, { ...item, idCaixa: 3, machos: 0, femeas: 2 }] }).success).toBe(true)
  })

  it('alocacao sem item e VALIDACAO', async () => {
    const resposta = await request(app('tecnico')).post('/api/pedidos/1/alocacao').send({ itens: [] })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('o item sem animal, sem data ou no corpo antigo (idParto) e VALIDACAO no campo', async () => {
    const semAnimal = alocacao.safeParse({ itens: [{ ...item, machos: 0 }] })
    expect(semAnimal.error?.issues[0]).toMatchObject({ path: ['itens', 0, 'machos'], message: 'Escolha ao menos um animal deste lugar.' })

    expect(alocacao.safeParse({ itens: [{ ...item, dtNascimento: '01/09/2026' }] }).success).toBe(false)
    expect(alocacao.safeParse({ itens: [{ idParto: 1, machos: 1, femeas: 0 }] }).success).toBe(false)
  })

  it('entrega sem data valida e VALIDACAO', async () => {
    const resposta = await request(app('tecnico'))
      .post('/api/pedidos/1/entrega')
      .send({ dtEntrega: '30/10/2026' })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
  })

  it('a entrega e de algo que ja aconteceu: no futuro e VALIDACAO no campo', async () => {
    const amanha = somarDias(hojeISO(), 1)

    expect(entrega.safeParse({ dtEntrega: hojeISO() }).success).toBe(true)

    const resposta = await request(app('tecnico')).post('/api/pedidos/1/entrega').send({ dtEntrega: amanha })

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.campos.dtEntrega).toBe('A data não pode ser depois de hoje.')
  })
})

describe('forma da busca', () => {
  const busca = { especie: 'rato', idLinhagem: '3', machos: '10', femeas: '5', qualquer: '3', idadeMin: '20', idadeMax: '40' }

  it('converte a query string', () => {
    const filtro = filtroDaBusca.parse(busca)

    expect(filtro).toEqual({ especie: 'rato', idLinhagem: 3, machos: 10, femeas: 5, qualquer: 3, idadeMin: 20, idadeMax: 40 })
  })

  it('a linhagem e obrigatoria: a busca le os vivos de uma linhagem', () => {
    const { idLinhagem: _idLinhagem, ...semLinhagem } = busca

    expect(filtroDaBusca.safeParse(semLinhagem).success).toBe(false)
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
