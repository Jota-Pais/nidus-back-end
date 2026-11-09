import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { abrirCaso, abrirTransacaoDoTeste, desfazerCaso } from '../../shared/testes/transacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { registrarBaixa } from '../colonia/baixa.service.ts'
import { linhasQueForamParaATrilha, listarHistorico } from '../historico/historico.service.ts'
import { buscarAtendimento } from '../motor/motor.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { registrarEntrega } from './entrega.service.ts'
import {
  aprovarPedido,
  criarPedido,
  listarPedidos,
  recusarPedido,
  recusarSemResposta,
} from './pedido.service.ts'
import type { PedidoNovo } from './pedido.service.ts'
import { desfazerReserva, reservarAnimais } from './reserva.service.ts'
import type { ItemDaReserva } from './reserva.service.ts'
import { retiradaDoPedido } from './retirada.service.ts'

// Os servicos do pedido contra um banco de verdade, com os triggers e os CHECKs da migration
// 20261108200000_colonia_por_animal: o SQL das travas e da escolha, a ordem das escritas que o
// trigger do pedido confere e a liberacao da caixa. As regras, caso a caso, ficam no
// pedido.regras.test.ts, contra a colonia de mentira; aqui so o caminho inteiro de cada uma.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado (um branch
// de teste da Neon ou um Postgres local), pelo npm run test:banco. Sem a variavel, fica de fora.
//
// Nada fica gravado: o Prisma dos servicos e trocado pela transacao do teste (shared/testes/transacao.ts),
// desfeita no fim, e cada caso roda num SAVEPOINT. O mundo (especie, estante, caixas, casal, parto,
// animais e usuarios) nasce dentro dela, com nomes proprios

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

/** Os ids do mundo de teste */
type Mundo = {
  especie: string
  idLinhagem: number
  tecnico: UsuarioDaSessao
  pesquisador: UsuarioDaSessao
  /** a caixa do casal, com 3 machos e 3 femeas do parto */
  caixaCasal: number
  /** as caixas de estoque, com 2 machos e 2 femeas do mesmo parto */
  estoqueM: number
  estoqueF: number
  codigoEstoqueF: string
  /** 'aaaa-mm-dd': o parto nasceu 60 dias atras e desmamou 38 dias atras */
  nascimento: string
}

const hoje = hojeISO()
const daqui = (dias: number) => somarDias(hoje, dias)

describe.skipIf(!URL_TESTE)('o pedido no banco de verdade', { timeout: 60_000 }, () => {
  let teste: Awaited<ReturnType<typeof abrirTransacaoDoTeste>>
  let m: Mundo

  const tx = () => teste.tx

  const id = async (sql: string, ...valores: unknown[]) =>
    Number((await tx().$queryRawUnsafe<{ id: number }[]>(sql, ...valores))[0]?.id)

  const linhas = <T,>(sql: string, ...valores: unknown[]) => tx().$queryRawUnsafe<T[]>(sql, ...valores)

  beforeAll(async () => {
    teste = await abrirTransacaoDoTeste(URL_TESTE as string)

    const nomeDaEspecie = 'Rato do teste dos pedidos'
    const especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ($1) RETURNING id`, nomeDaEspecie)
    const idLinhagem = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'W') RETURNING id`, especie)
    await tx().$executeRawUnsafe(
      `INSERT INTO catalogo.grupo_genetico_par (grupo_macho, grupo_femea) VALUES ('A', 'B') ON CONFLICT DO NOTHING`,
    )

    const usuario = async (nome: string, perfil: 'T' | 'P') =>
      id(`INSERT INTO login.usuario (nome, email, perfil) VALUES ($1, $2, $3) RETURNING id`, nome, `${nome}@pedido-no-banco.invalid`, perfil)
    const tecnico = await usuario('tecnico', 'T')
    const pesquisador = await usuario('pesquisador', 'P')

    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ('Sala do teste dos pedidos') RETURNING id`)
    const estante = await id(
      `INSERT INTO infra.estante (id_sala, fabricante, modelo, numero_visivel, faces, linhas, colunas, capacidade)
       VALUES ($1, 'Teste', 'Teste', 'P1', 2, 4, 4, 32) RETURNING id`,
      sala,
    )
    const caixa = (coluna: number, tipo: string, sexo: string | null) =>
      id(
        `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo, sexo, id_linhagem)
         VALUES ($1, 1, 1, $2, $3, $4, $5, $6) RETURNING id`,
        estante, coluna, especie, tipo, sexo, tipo === 'estoque' ? idLinhagem : null,
      )
    const caixaCasal = await caixa(1, 'casal', null)
    const estoqueM = await caixa(2, 'estoque', 'M')
    const estoqueF = await caixa(3, 'estoque', 'F')

    const casal = await id(
      `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao)
       VALUES ($1, $2, 'A', 'B', 'AB', $3::date) RETURNING id`,
      caixaCasal, idLinhagem, daqui(-83),
    )
    const parto = await id(
      `INSERT INTO reproducao.parto (id_casal, ordem, dt_acasalamento, dt_parto_real, dt_desmame_real)
       VALUES ($1, 1, $2::date, $3::date, $4::date) RETURNING id`,
      casal, daqui(-83), daqui(-60), daqui(-38),
    )

    // nascem na caixa do casal; 2 machos e 2 femeas vao para o estoque depois do desmame
    const nascer = async (sexo: 'M' | 'F', n: number) =>
      (
        await linhas<{ id: number }>(
          `INSERT INTO colonia.animal (id_parto, sexo, id_caixa)
           SELECT $1::int, $2::char(1), $3::int FROM generate_series(1, $4::int) RETURNING id`,
          parto, sexo, caixaCasal, n,
        )
      ).map((linha) => linha.id)
    const machos = await nascer('M', 5)
    const femeas = await nascer('F', 5)
    const mudar = (ids: number[], destino: number) =>
      tx().$executeRawUnsafe(
        `UPDATE colonia.animal SET id_caixa = $1, dt_movimento = $2::date WHERE id = ANY($3::int[])`,
        destino, daqui(-30), ids,
      )
    await mudar(machos.slice(3), estoqueM)
    await mudar(femeas.slice(3), estoqueF)

    const [codigo] = await linhas<{ codigo: string }>(`SELECT codigo FROM infra.caixa WHERE id = $1`, estoqueF)

    m = {
      especie: 'rato-do-teste-dos-pedidos',
      idLinhagem,
      tecnico: { id: tecnico, nome: 'tecnico', email: 'tecnico@pedido-no-banco.invalid', perfil: 'tecnico' },
      pesquisador: { id: pesquisador, nome: 'pesquisador', email: 'pesquisador@pedido-no-banco.invalid', perfil: 'pesquisador' },
      caixaCasal,
      estoqueM,
      estoqueF,
      codigoEstoqueF: codigo?.codigo ?? '',
      nascimento: daqui(-60),
    }
  }, 180_000)

  afterAll(() => teste.desfazer())
  beforeEach(abrirCaso)
  afterEach(desfazerCaso)

  // ------------------------------------------------------------------ ajudantes

  /** O pedido do pesquisador, aprovado pela equipe: 60 dias em 5 dias, salvo outra idade e data */
  async function pedidoAprovado(
    animais: Pick<PedidoNovo, 'machos' | 'femeas' | 'qualquer'>,
    idade = 60,
    dataEntrega = daqui(5),
  ): Promise<number> {
    const { id: idPedido } = await criarPedido(
      {
        nomePesquisador: 'Pesquisadora do teste',
        protocoloCeua: '2026000000',
        idLinhagem: m.idLinhagem,
        ...animais,
        idadeMin: idade,
        idadeMax: idade,
        dataEntrega,
        observacoes: null,
      },
      m.pesquisador,
    )
    await aprovarPedido(idPedido, m.tecnico)
    return idPedido
  }

  const doLugar = (idCaixa: number, machos: number, femeas: number): ItemDaReserva => ({
    idCaixa,
    dtNascimento: m.nascimento,
    machos,
    femeas,
  })

  /** Os vivos reservados para o pedido, por caixa e sexo */
  const reservadosDo = (idPedido: number) =>
    linhas<{ idCaixa: number; sexo: string; n: number }>(
      `SELECT id_caixa AS "idCaixa", sexo, count(*)::int AS n FROM colonia.animal
        WHERE id_pedido = $1 AND situacao = 'vivo' GROUP BY 1, 2 ORDER BY 1, 2`,
      idPedido,
    )

  const statusDo = async (idPedido: number) =>
    (await linhas<{ status: string }>(`SELECT status FROM demanda.pedido WHERE id = $1`, idPedido))[0]?.status

  /** O pedido A, de 2 machos, reservado na caixa do casal e em falta de 1 macho depois de uma baixa */
  async function pedidoEmFalta(): Promise<number> {
    const pedidoA = await pedidoAprovado({ machos: 2, femeas: 0, qualquer: 0 })
    await reservarAnimais(pedidoA, [doLugar(m.caixaCasal, 2, 0)], m.tecnico)

    // a caixa do casal tem 3 machos, 2 deles de A: a baixa de 2 leva o livre e um de A
    const baixa = await registrarBaixa(
      m.caixaCasal,
      { dtFato: hoje, motivo: 'morte', itens: [{ sexo: 'M', qtd: 2, idPedido: pedidoA }] },
      m.tecnico.id,
    )
    expect(baixa.faltas).toEqual([{ idPedido: pedidoA, m: 1, f: 0, qualquer: 0 }])

    return pedidoA
  }

  // ------------------------------------------------------------------ os casos

  it('o caso do Arthur: com A em falta de macho, a busca sugere a femea da mesma caixa para B e a reserva passa', async () => {
    const pedidoA = await pedidoEmFalta()
    const pedidoB = await pedidoAprovado({ machos: 0, femeas: 1, qualquer: 0 })

    const busca = await buscarAtendimento({
      especie: m.especie,
      idLinhagem: m.idLinhagem,
      machos: 0,
      femeas: 1,
      qualquer: 0,
      idadeMin: 60,
      idadeMax: 60,
      dataEntrega: daqui(5),
    })
    const sugeridas = busca.candidatas.filter((candidata) => candidata.sugerida)
    expect(sugeridas.map((c) => [c.idCaixa, c.alocar])).toEqual([[m.caixaCasal, { m: 0, f: 1 }]])

    const reserva = await reservarAnimais(
      pedidoB,
      sugeridas.map((c) => ({ idCaixa: c.idCaixa, dtNascimento: c.dtNascimento, machos: c.alocar.m, femeas: c.alocar.f })),
      m.tecnico,
    )

    expect(reserva).toEqual({ idPedido: pedidoB, status: 'reservado', reservados: { m: 0, f: 1 }, falta: null })
    expect(await statusDo(pedidoB)).toBe('reservado')

    const { pedidos } = await listarPedidos(m.tecnico)
    const falta = (idPedido: number) => pedidos.find((pedido) => pedido.id === idPedido)?.reservaEmFalta
    expect(falta(pedidoA)).toEqual({ m: 1, f: 0, qualquer: 0 })
    expect(falta(pedidoB)).toBeNull()
  })

  it('a reserva em falta se completa com outro lugar, so ate cobrir, e a retirada mostra onde os animais estao', async () => {
    const pedidoA = await pedidoEmFalta()

    expect(await reservarAnimais(pedidoA, [doLugar(m.estoqueM, 1, 0)], m.tecnico)).toEqual(
      expect.objectContaining({ status: 'reservado', reservados: { m: 1, f: 0 }, falta: null }),
    )
    await expect(reservarAnimais(pedidoA, [doLugar(m.estoqueM, 1, 0)], m.tecnico)).rejects.toEqual(
      expect.objectContaining({ codigo: 'PEDIDO_JA_RESERVADO' }),
    )

    const { retirada } = await retiradaDoPedido(pedidoA)
    expect(retirada.map((lugar) => [lugar.sexo, lugar.qtd, lugar.dtNascimento])).toEqual([
      ['M', 1, m.nascimento],
      ['M', 1, m.nascimento],
    ])
    expect(await reservadosDo(pedidoA)).toEqual([
      { idCaixa: m.caixaCasal, sexo: 'M', n: 1 },
      { idCaixa: m.estoqueM, sexo: 'M', n: 1 },
    ])
  })

  it('a reserva so do pedido inteiro: a que nao cobre nao grava nada', async () => {
    const pedido = await pedidoAprovado({ machos: 1, femeas: 1, qualquer: 0 })

    await expect(reservarAnimais(pedido, [doLugar(m.caixaCasal, 1, 0)], m.tecnico)).rejects.toEqual(
      expect.objectContaining({ codigo: 'PEDIDO_INCOMPLETO' }),
    )
    expect(await statusDo(pedido)).toBe('aprovado')
    expect(await reservadosDo(pedido)).toEqual([])
  })

  it('a entrega leva os reservados, grava a data e libera a caixa de estoque que esvaziou', async () => {
    const pedido = await pedidoAprovado({ machos: 0, femeas: 2, qualquer: 0 })
    await reservarAnimais(pedido, [doLugar(m.estoqueF, 0, 2)], m.tecnico)

    expect(await registrarEntrega(pedido, hoje, m.tecnico.id)).toEqual({
      idPedido: pedido,
      status: 'entregue',
      dtEntrega: hoje,
      entregues: { m: 0, f: 2 },
      caixasLiberadas: [m.codigoEstoqueF],
    })

    const [gravado] = await linhas<{ status: string; dtEntrega: string }>(
      `SELECT status, dt_entrega::text AS "dtEntrega" FROM demanda.pedido WHERE id = $1`,
      pedido,
    )
    expect(gravado).toEqual({ status: 'entregue', dtEntrega: hoje })

    const [caixa] = await linhas<{ ativa: boolean; motivo: string; dtLiberacao: string }>(
      `SELECT ativa, motivo_liberacao AS motivo, dt_liberacao::text AS "dtLiberacao" FROM infra.caixa WHERE id = $1`,
      m.estoqueF,
    )
    expect(caixa).toEqual({ ativa: false, motivo: 'entrega', dtLiberacao: hoje })

    const entregues = await linhas<{ n: number }>(
      `SELECT count(*)::int AS n FROM colonia.animal WHERE id_pedido = $1 AND situacao = 'entregue' AND dt_saida = $2::date`,
      pedido, hoje,
    )
    expect(entregues).toEqual([{ n: 2 }])

    // o pedido no Historico: o que mudou no pedido e o que aconteceu com os animais dele
    const { historico } = await listarHistorico({ entidade: 'pedido', idEntidade: pedido, limite: 20 })
    expect(historico.map((linha) => [linha.fonte, linha.acao]).sort()).toEqual([
      ['historico', 'aprovacao'],
      ['historico', 'criacao'],
      ['trilha', 'entrega'],
      ['trilha', 'reserva'],
    ])
  })

  it('a caixa que ainda tem animal continua ativa depois da entrega', async () => {
    const pedido = await pedidoAprovado({ machos: 0, femeas: 1, qualquer: 0 })
    await reservarAnimais(pedido, [doLugar(m.estoqueF, 0, 1)], m.tecnico)

    expect((await registrarEntrega(pedido, hoje, m.tecnico.id)).caixasLiberadas).toEqual([])
    expect(await linhas(`SELECT ativa FROM infra.caixa WHERE id = $1`, m.estoqueF)).toEqual([{ ativa: true }])
  })

  it('a entrega confere a idade na data real: fora da faixa e IDADE_FORA_DA_FAIXA, e nada sai', async () => {
    // 75 dias aceita de 65 a 85: em 10 dias os animais terao 70, mas hoje tem 60
    const pedido = await pedidoAprovado({ machos: 0, femeas: 1, qualquer: 0 }, 75, daqui(10))
    await reservarAnimais(pedido, [doLugar(m.caixaCasal, 0, 1)], m.tecnico)

    await expect(registrarEntrega(pedido, hoje, m.tecnico.id)).rejects.toEqual(
      expect.objectContaining({ status: 409, codigo: 'IDADE_FORA_DA_FAIXA' }),
    )
    expect(await statusDo(pedido)).toBe('reservado')
    expect(await reservadosDo(pedido)).toEqual([{ idCaixa: m.caixaCasal, sexo: 'F', n: 1 }])
  })

  it('a recusa do pedido reservado solta os animais onde estao, e a trilha guarda a reserva desfeita', async () => {
    const pedido = await pedidoAprovado({ machos: 1, femeas: 1, qualquer: 0 })
    await reservarAnimais(pedido, [doLugar(m.caixaCasal, 1, 1)], m.tecnico)

    expect(await recusarPedido(pedido, 'Sem espaco no transporte', m.tecnico.id)).toEqual({
      idPedido: pedido,
      status: 'recusado',
      motivo: 'Sem espaco no transporte',
      soltos: { m: 1, f: 1 },
    })
    expect(await statusDo(pedido)).toBe('recusado')
    expect(await reservadosDo(pedido)).toEqual([])
    expect(
      await linhas(
        `SELECT o.tipo, count(oa.id_animal)::int AS animais FROM colonia.ocorrencia o
           JOIN colonia.ocorrencia_animal oa ON oa.id_ocorrencia = o.id
          WHERE o.id_pedido = $1 GROUP BY o.id, o.tipo ORDER BY o.id`,
        pedido,
      ),
    ).toEqual([
      { tipo: 'reserva', animais: 2 },
      { tipo: 'reserva_desfeita', animais: 2 },
    ])
  })

  it('desfazer a reserva sem falta volta o pedido a aprovado, e ele reserva de novo', async () => {
    const pedido = await pedidoAprovado({ machos: 0, femeas: 1, qualquer: 0 })
    await reservarAnimais(pedido, [doLugar(m.caixaCasal, 0, 1)], m.tecnico)

    expect(await desfazerReserva(pedido, m.tecnico)).toEqual({ idPedido: pedido, status: 'aprovado', soltos: { m: 0, f: 1 } })
    expect(await reservadosDo(pedido)).toEqual([])

    await reservarAnimais(pedido, [doLugar(m.estoqueF, 0, 1)], m.tecnico)
    expect(await statusDo(pedido)).toBe('reservado')
  })

  it('a recusa automatica pega o pedido enviado ha 14 dias, sem usuario', async () => {
    const { id: pedido } = await criarPedido(
      {
        nomePesquisador: 'Pesquisadora do teste',
        protocoloCeua: '2026000000',
        idLinhagem: m.idLinhagem,
        machos: 1,
        femeas: 0,
        qualquer: 0,
        idadeMin: 60,
        idadeMax: 60,
        dataEntrega: daqui(30),
        observacoes: null,
      },
      m.pesquisador,
    )
    await tx().$executeRawUnsafe(`UPDATE demanda.pedido SET dt_criacao = now() - interval '15 days' WHERE id = $1`, pedido)

    expect(await recusarSemResposta()).toBeGreaterThanOrEqual(1)
    expect(await statusDo(pedido)).toBe('recusado')
    expect(
      await linhas(
        `SELECT id_usuario AS "idUsuario" FROM auditoria.historico WHERE entidade = 'pedido' AND id_entidade = $1 AND acao = 'recusa'`,
        pedido,
      ),
    ).toEqual([{ idUsuario: null }])
  })

  it('o historico de antes do modelo por rato sai da tela so quando a conversao virou o fato ocorrencia: pelos dados de cada linha', async () => {
    const comReserva = await pedidoAprovado({ machos: 1, femeas: 0, qualquer: 0 })
    await reservarAnimais(comReserva, [doLugar(m.estoqueM, 1, 0)], m.tecnico)
    const semReserva = await pedidoAprovado({ machos: 1, femeas: 0, qualquer: 0 })
    const [parto] = await linhas<{ id: number }>(`SELECT id_parto AS id FROM colonia.animal WHERE id_caixa = $1 LIMIT 1`, m.caixaCasal)
    const idParto = parto?.id ?? 0
    // a selecao convertida: a baixa da selecao do parto
    await tx().$executeRawUnsafe(
      `INSERT INTO colonia.ocorrencia (tipo, dt_fato, id_parto, id_caixa_origem, motivo) VALUES ('baixa', $1::date, $2, $3, 'eutanasia de selecao')`,
      daqui(-59),
      idParto,
      m.caixaCasal,
    )

    const antiga = (entidade: string, idEntidade: number, acao: string, dados: unknown) =>
      id(
        `INSERT INTO auditoria.historico (entidade, id_entidade, acao, descricao, dados) VALUES ($1, $2, $3, 'linha antiga', $4::jsonb) RETURNING id`,
        entidade,
        idEntidade,
        acao,
        JSON.stringify(dados),
      )
    const foramParaATrilha = [
      await antiga('parto', idParto, 'nascimento', { nascidoM: 5, nascidoF: 5 }),
      await antiga('parto', idParto, 'selecao', { eutanasiadoM: 1, eutanasiadoF: 0 }),
      await antiga('caixa', m.estoqueM, 'estoque', { idParto, idCaixaDoCasal: m.caixaCasal, sexo: 'M', qtd: 2 }),
      await antiga('pedido', comReserva, 'alocacao', { itens: [{ idParto, machos: 1, femeas: 0 }] }),
      await antiga('pedido', comReserva, 'entrega', { dtEntrega: hoje }),
    ]
    // o virar estoque antigo, a reserva do compromisso cancelado e a selecao sem baixa nao viraram nada
    const virada = await antiga('caixa', m.estoqueM, 'estoque', { sexo: 'M', total: 2 })
    const ficam = [
      virada,
      await antiga('pedido', semReserva, 'alocacao', { itens: [{ idParto, machos: 1, femeas: 0 }] }),
      await antiga('parto', m.caixaCasal + 1_000_000, 'selecao', { eutanasiadoM: 0, eutanasiadoF: 0 }),
    ]

    const naTrilha = await linhasQueForamParaATrilha()

    expect(foramParaATrilha.filter((linha) => !naTrilha.includes(linha))).toEqual([])
    expect(ficam.filter((linha) => naTrilha.includes(linha))).toEqual([])

    // na tela, da caixa de estoque sobra o virar estoque antigo
    const { historico } = await listarHistorico({ entidade: 'caixa', idEntidade: m.estoqueM, limite: 50 })
    expect(historico.filter((linha) => linha.fonte === 'historico').map((linha) => linha.id)).toEqual([virada])
  })
})
