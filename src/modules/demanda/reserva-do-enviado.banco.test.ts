import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { abrirTransacaoDoTeste, naTransacao } from '../../shared/testes/transacao.ts'
import type { TransacaoDoTeste } from '../../shared/testes/transacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { aprovarPedido, criarPedido } from './pedido.service.ts'
import { desfazerReserva, reservarAnimais } from './reserva.service.ts'
import type { ItemDaReserva } from './reserva.service.ts'

// A reserva do pedido ENVIADO (aguardando analise) contra o Postgres de verdade: o servico passa o
// pedido por aprovado e reservado na mesma transacao, e os gatilhos do banco aceitam; reservar
// direto no banco um pedido enviado continua recusado.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado, pelo
// npm run test:banco. Sem a variavel, fica de fora. Como na reserva concorrente, o mundo (especie,
// linhagem, usuarios, formato, estante, caixas, casal, parto e 6 machos) e GRAVADO no comeco e apagado no
// fim, para as conexoes verem os mesmos animais (a limpeza desliga o trigger do animal dentro da
// propria transacao, que trava a tabela ate o COMMIT). Os casos rodam em transacoes desfeitas no
// fim, menos os do pedido gravado, que a limpeza apaga.

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

const hoje = hojeISO()
const daqui = (dias: number) => somarDias(hoje, dias)

/** Os nomes que marcam o mundo deste teste no banco */
const ESPECIE = 'Rato do teste da reserva do enviado'
const SALA = 'Sala do teste da reserva do enviado'
const FORMATO = 'Formato do teste da reserva do enviado'
const DOMINIO = '@reserva-do-enviado.invalid'

/** O parto nasceu 60 dias atras e desmamou 38 dias atras; os machos estao no estoque ha 30 */
const NASCIMENTO = daqui(-60)

/** Quanto uma reserva pode demorar: mais que isso, ficou esperando a outra */
const ESPERA_MAXIMA_EM_MS = 30_000

type Mundo = {
  idLinhagem: number
  /** a caixa de estoque com os 6 machos livres */
  estoque: number
  machos: number[]
  tecnico: UsuarioDaSessao
  pesquisador: UsuarioDaSessao
}

const esperar = (ms: number) => new Promise((pronto) => setTimeout(pronto, ms))

/** A promessa, ou a recusa de quem ficou esperando a outra transacao */
function semFicarEsperando<T>(promessa: Promise<T>): Promise<T> {
  return Promise.race([
    promessa,
    esperar(ESPERA_MAXIMA_EM_MS).then(() => {
      throw new Error('a reserva ficou esperando a outra transacao: os animais travados nao foram pulados')
    }),
  ])
}

/** Apaga o mundo do teste, se houver, numa transacao so */
async function apagarOMundo(banco: pg.Client): Promise<void> {
  const ids = async (sql: string, valores: unknown[]) => (await banco.query<{ id: number }>(sql, valores)).rows.map((r) => r.id)

  await banco.query('BEGIN')

  try {
    const especies = await ids(`SELECT id FROM catalogo.especie WHERE nome = $1`, [ESPECIE])
    const usuarios = await ids(`SELECT id FROM login.usuario WHERE email LIKE $1`, [`%${DOMINIO}`])
    const linhagens = await ids(`SELECT id FROM catalogo.linhagem WHERE id_especie = ANY($1)`, [especies])
    const caixas = await ids(`SELECT id FROM infra.caixa WHERE id_especie = ANY($1)`, [especies])
    const animais = await ids(`SELECT id FROM colonia.animal WHERE id_caixa = ANY($1)`, [caixas])
    const pedidos = await ids(`SELECT id FROM demanda.pedido WHERE id_especie = ANY($1) OR id_usuario_solicitante = ANY($2)`, [
      especies,
      usuarios,
    ])
    const ocorrencias = await ids(
      `SELECT DISTINCT o.id FROM colonia.ocorrencia o
         LEFT JOIN colonia.ocorrencia_animal oa ON oa.id_ocorrencia = o.id
        WHERE oa.id_animal = ANY($1) OR o.id_pedido = ANY($2) OR o.id_usuario = ANY($3)
           OR o.id_caixa_origem = ANY($4) OR o.id_caixa_destino = ANY($4)`,
      [animais, pedidos, usuarios, caixas],
    )

    await banco.query(`DELETE FROM colonia.ocorrencia_animal WHERE id_ocorrencia = ANY($1) OR id_animal = ANY($2)`, [
      ocorrencias,
      animais,
    ])
    await banco.query(`DELETE FROM colonia.ocorrencia WHERE id = ANY($1)`, [ocorrencias])

    if (animais.length > 0) {
      await banco.query(`ALTER TABLE colonia.animal DISABLE TRIGGER animal_coerente`)
      await banco.query(`DELETE FROM colonia.animal WHERE id = ANY($1)`, [animais])
      await banco.query(`ALTER TABLE colonia.animal ENABLE TRIGGER animal_coerente`)
    }

    await banco.query(
      `DELETE FROM auditoria.historico WHERE id_usuario = ANY($1) OR (entidade = 'pedido' AND id_entidade = ANY($2))`,
      [usuarios, pedidos],
    )
    await banco.query(`DELETE FROM demanda.pedido WHERE id = ANY($1)`, [pedidos])
    await banco.query(`DELETE FROM reproducao.parto WHERE id_casal IN (SELECT id FROM reproducao.casal WHERE id_linhagem = ANY($1))`, [
      linhagens,
    ])
    await banco.query(`DELETE FROM reproducao.casal WHERE id_linhagem = ANY($1)`, [linhagens])
    await banco.query(`DELETE FROM infra.caixa WHERE id = ANY($1)`, [caixas])
    await banco.query(`DELETE FROM infra.estante WHERE id_sala IN (SELECT id FROM infra.sala WHERE nome = $1)`, [SALA])
    await banco.query(`DELETE FROM infra.sala WHERE nome = $1`, [SALA])
    await banco.query(`DELETE FROM infra.formato WHERE nome = $1`, [FORMATO])
    await banco.query(`DELETE FROM catalogo.linhagem WHERE id = ANY($1)`, [linhagens])
    await banco.query(`DELETE FROM catalogo.especie WHERE id = ANY($1)`, [especies])
    await banco.query(`DELETE FROM login.usuario WHERE id = ANY($1)`, [usuarios])

    await banco.query('COMMIT')
  } catch (erro) {
    await banco.query('ROLLBACK')
    throw erro
  }
}

/** Grava o mundo do teste: 6 machos livres e desmamados numa caixa de estoque */
async function gravarOMundo(banco: pg.Client): Promise<Mundo> {
  const id = async (sql: string, valores: unknown[] = []) => Number((await banco.query<{ id: number }>(sql, valores)).rows[0]?.id)

  await banco.query('BEGIN')

  try {
    const especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ($1) RETURNING id`, [ESPECIE])
    const idLinhagem = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'W') RETURNING id`, [especie])
    const usuario = (nome: string, perfil: string) =>
      id(`INSERT INTO login.usuario (nome, email, perfil) VALUES ($1, $2, $3) RETURNING id`, [nome, `${nome}${DOMINIO}`, perfil])
    const tecnico = await usuario('tecnico', 'T')
    const pesquisador = await usuario('pesquisador', 'P')

    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ($1) RETURNING id`, [SALA])
    const formato = await id(`INSERT INTO infra.formato (nome, faces, linhas, colunas) VALUES ($1, 1, 1, 2) RETURNING id`, [FORMATO])
    const estante = await id(
      `INSERT INTO infra.estante (id_sala, id_formato, numero_visivel) VALUES ($1, $2, 'RE1') RETURNING id`,
      [sala, formato],
    )
    const caixa = (coluna: number, tipo: string) =>
      id(
        `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo, sexo, id_linhagem)
         VALUES ($1, 1, 1, $2, $3, $4, $5, $6) RETURNING id`,
        [estante, coluna, especie, tipo, tipo === 'estoque' ? 'M' : null, tipo === 'estoque' ? idLinhagem : null],
      )
    const caixaDoCasal = await caixa(1, 'casal')
    const estoque = await caixa(2, 'estoque')

    const casal = await id(
      `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao)
       VALUES ($1, $2, 'A', 'B', 'AB', $3::date) RETURNING id`,
      [caixaDoCasal, idLinhagem, daqui(-83)],
    )
    const parto = await id(
      `INSERT INTO reproducao.parto (id_casal, id_linhagem, ordem, dt_acasalamento, dt_parto_real, dt_desmame_real)
       VALUES ($1, $2, 1, $3::date, $4::date, $5::date) RETURNING id`,
      [casal, idLinhagem, daqui(-83), NASCIMENTO, daqui(-38)],
    )

    // nascem na caixa do casal e mudam para o estoque depois do desmame
    const machos = (
      await banco.query<{ id: number }>(
        `INSERT INTO colonia.animal (id_parto, sexo, id_caixa)
         SELECT $1::int, 'M', $2::int FROM generate_series(1, 6) RETURNING id`,
        [parto, caixaDoCasal],
      )
    ).rows.map((linha) => linha.id)
    await banco.query(`UPDATE colonia.animal SET id_caixa = $1, dt_movimento = $2::date WHERE id = ANY($3)`, [
      estoque,
      daqui(-30),
      machos,
    ])

    await banco.query('COMMIT')

    return {
      idLinhagem,
      estoque,
      machos: machos.sort((a, b) => a - b),
      tecnico: { id: tecnico, nome: 'tecnico', email: `tecnico${DOMINIO}`, perfil: 'tecnico' },
      pesquisador: { id: pesquisador, nome: 'pesquisador', email: `pesquisador${DOMINIO}`, perfil: 'pesquisador' },
    }
  } catch (erro) {
    await banco.query('ROLLBACK')
    throw erro
  }
}


describe.skipIf(!URL_TESTE)('a reserva do pedido enviado, contra o banco de verdade', { timeout: 120_000 }, () => {
  let banco: pg.Client
  let m: Mundo

  beforeAll(async () => {
    banco = new pg.Client({ connectionString: URL_TESTE })
    await banco.connect()
    await apagarOMundo(banco)
    m = await gravarOMundo(banco)
  }, 300_000)

  afterAll(async () => {
    if (banco === undefined) return
    await apagarOMundo(banco)
    await banco.end()
  }, 300_000)

  /** Uma transacao numa conexao propria, como a de um tecnico */
  const conexao = () => abrirTransacaoDoTeste(URL_TESTE as string)

  /** Um pedido de machos, criado pelo pesquisador e deixado ENVIADO, dentro da transacao 't' */
  const pedidoEnviado = (t: TransacaoDoTeste, machos: number) =>
    naTransacao(t.tx, async () => {
      const { id } = await criarPedido(
        {
          nomePesquisador: 'Pesquisadora do teste',
          protocoloCeua: '2026000000',
          idLinhagem: m.idLinhagem,
          machos,
          femeas: 0,
          qualquer: 0,
          idadeMin: 60,
          idadeMax: 70,
          dataEntrega: daqui(5),
          observacoes: null,
        },
        m.pesquisador,
      )
      return id
    })

  const doEstoque = (machos: number): ItemDaReserva[] => [{ idCaixa: m.estoque, dtNascimento: NASCIMENTO, machos, femeas: 0 }]

  const consulta = <T>(t: TransacaoDoTeste, sql: string, ...valores: unknown[]) => t.tx.$queryRawUnsafe<T[]>(sql, ...valores)

  const statusDe = async (t: TransacaoDoTeste, idPedido: number) =>
    (await consulta<{ status: string }>(t, `SELECT status FROM demanda.pedido WHERE id = $1`, idPedido))[0]?.status

  const reservadosNa = async (t: TransacaoDoTeste, idPedido: number) =>
    (await consulta<{ id: number }>(t, `SELECT id FROM colonia.animal WHERE id_pedido = $1 ORDER BY id`, idPedido)).map((linha) => linha.id)

  const historicoDe = (t: TransacaoDoTeste, idPedido: number) =>
    consulta<{ id: number; acao: string; id_usuario: number; descricao: string }>(
      t,
      `SELECT id, acao, id_usuario, descricao FROM auditoria.historico WHERE entidade = 'pedido' AND id_entidade = $1 ORDER BY id`,
      idPedido,
    )

  it('enviado, aprovado e animais, depois reservado: os gatilhos aceitam, e o historico grava a aprovacao de quem reservou', async () => {
    const t = await conexao()

    try {
      const pedido = await pedidoEnviado(t, 3)
      expect(await statusDe(t, pedido)).toBe('enviado')

      const resposta = await naTransacao(t.tx, () => reservarAnimais(pedido, doEstoque(3), m.tecnico))

      expect(resposta).toMatchObject({ idPedido: pedido, status: 'reservado', reservados: { m: 3, f: 0 }, falta: null })
      expect(await statusDe(t, pedido)).toBe('reservado')
      expect(await reservadosNa(t, pedido)).toHaveLength(3)

      const historico = await historicoDe(t, pedido)
      expect(historico.map((h) => h.acao)).toEqual(['criacao', 'aprovacao'])
      expect(historico[1]).toMatchObject({
        id_usuario: m.tecnico.id,
        descricao: expect.stringContaining(`Pedido #${pedido} aprovado com os animais reservados`),
      })

      const ocorrencias = await consulta<{ tipo: string; id_usuario: number }>(
        t,
        `SELECT tipo, id_usuario FROM colonia.ocorrencia WHERE id_pedido = $1`,
        pedido,
      )
      expect(ocorrencias).toEqual([{ tipo: 'reserva', id_usuario: m.tecnico.id }])
    } finally {
      await t.desfazer()
    }
  })

  it('a reserva que nao cobre o pedido inteiro nao grava nada: continua enviado, sem aprovacao no historico', async () => {
    const t = await conexao()

    try {
      const pedido = await pedidoEnviado(t, 3)

      await expect(naTransacao(t.tx, () => reservarAnimais(pedido, doEstoque(2), m.tecnico))).rejects.toEqual(
        expect.objectContaining({ status: 409, codigo: 'PEDIDO_INCOMPLETO' }),
      )

      expect(await statusDe(t, pedido)).toBe('enviado')
      expect(await reservadosNa(t, pedido)).toEqual([])
      expect((await historicoDe(t, pedido)).map((h) => h.acao)).toEqual(['criacao'])
    } finally {
      await t.desfazer()
    }
  })

  it('aprovar antes e reservar depois segue o fluxo antigo, e desfazer a reserva volta a aprovado', async () => {
    const t = await conexao()

    try {
      const pedido = await pedidoEnviado(t, 2)
      await naTransacao(t.tx, () => aprovarPedido(pedido, m.tecnico))
      await naTransacao(t.tx, () => reservarAnimais(pedido, doEstoque(2), m.tecnico))

      expect(await statusDe(t, pedido)).toBe('reservado')
      expect((await historicoDe(t, pedido)).map((h) => h.acao)).toEqual(['criacao', 'aprovacao'])

      await naTransacao(t.tx, () => desfazerReserva(pedido, m.tecnico))
      expect(await statusDe(t, pedido)).toBe('aprovado')
      expect(await reservadosNa(t, pedido)).toEqual([])
    } finally {
      await t.desfazer()
    }
  })

  it('o gatilho do animal ainda recusa reservar direto no banco um pedido enviado', async () => {
    const t = await conexao()

    try {
      const pedido = await pedidoEnviado(t, 1)

      await expect(consulta(t, `UPDATE colonia.animal SET id_pedido = $1 WHERE id = $2`, pedido, m.machos[0])).rejects.toThrow(
        /PEDIDO_RESERVA/,
      )
    } finally {
      await t.desfazer()
    }
  })

  it('dois cliques em Reservar no mesmo enviado: o segundo espera, ve o reservado e recebe PEDIDO_JA_RESERVADO, sem animais em dobro', async () => {
    // o pedido gravado, para as duas conexoes o verem
    const criacao = await conexao()
    const pedido = await pedidoEnviado(criacao, 2)
    await criacao.confirmar()

    const a = await conexao()
    const b = await conexao()
    let aConfirmada = false

    try {
      expect(await naTransacao(a.tx, () => reservarAnimais(pedido, doEstoque(2), m.tecnico))).toMatchObject({
        status: 'reservado',
        reservados: { m: 2, f: 0 },
      })

      const segunda = naTransacao(b.tx, () => reservarAnimais(pedido, doEstoque(2), m.tecnico)).then(
        () => 'reservou de novo',
        (erro: unknown) => erro,
      )

      // o pedido esta travado pela primeira: a segunda espera
      expect(await Promise.race([segunda, esperar(2_000).then(() => 'esperando')])).toBe('esperando')

      await a.confirmar()
      aConfirmada = true

      // com a primeira gravada, a segunda ve o pedido reservado
      expect(await semFicarEsperando(segunda)).toEqual(expect.objectContaining({ status: 409, codigo: 'PEDIDO_JA_RESERVADO' }))
    } finally {
      if (!aConfirmada) await a.desfazer()
      await b.desfazer()
    }

    const gravado = await banco.query<{ status: string; reservados: number }>(
      `SELECT p.status, count(a.id)::int AS reservados
         FROM demanda.pedido p LEFT JOIN colonia.animal a ON a.id_pedido = p.id AND a.situacao = 'vivo'
        WHERE p.id = $1 GROUP BY p.status`,
      [pedido],
    )
    expect(gravado.rows).toEqual([{ status: 'reservado', reservados: 2 }])

    const aprovacoes = await banco.query(
      `SELECT id FROM auditoria.historico WHERE entidade = 'pedido' AND id_entidade = $1 AND acao = 'aprovacao'`,
      [pedido],
    )
    expect(aprovacoes.rows).toHaveLength(1)
  })

  it('duas reservas do mesmo enviado largadas juntas: so uma passa, a outra e PEDIDO_JA_RESERVADO', async () => {
    const criacao = await conexao()
    const pedido = await pedidoEnviado(criacao, 2)
    await criacao.confirmar()

    const a = await conexao()
    const b = await conexao()
    const reservarEConfirmar = (t: TransacaoDoTeste) =>
      naTransacao(t.tx, async () => {
        const resposta = await reservarAnimais(pedido, doEstoque(2), m.tecnico)
        await t.confirmar()
        return resposta
      })

    try {
      const resultados = await semFicarEsperando(Promise.allSettled([reservarEConfirmar(a), reservarEConfirmar(b)]))

      const perdedoras = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(perdedoras).toHaveLength(1)
      expect(perdedoras[0]?.reason).toEqual(expect.objectContaining({ status: 409, codigo: 'PEDIDO_JA_RESERVADO' }))
    } finally {
      await a.desfazer().catch(() => undefined)
      await b.desfazer().catch(() => undefined)
    }

    const gravado = await banco.query<{ reservados: number }>(
      `SELECT count(*)::int AS reservados FROM colonia.animal WHERE id_pedido = $1 AND situacao = 'vivo'`,
      [pedido],
    )
    expect(gravado.rows).toEqual([{ reservados: 2 }])
  })
})
