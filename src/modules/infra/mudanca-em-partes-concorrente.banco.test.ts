import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { abrirTransacaoDoTeste, naTransacao } from '../../shared/testes/transacao.ts'
import type { TransacaoDoTeste } from '../../shared/testes/transacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { registrarMudanca } from './mudanca.service.ts'

// Duas mudancas em varias caixas ao mesmo tempo, cada uma na sua conexao, com os destinos cruzados
// (a origem de uma e destino da outra): as caixas sao travadas em ordem de id (travarCaixas), entao
// uma espera a outra e nenhuma cai em deadlock. As outras suites rodam numa transacao so e nao
// enxergam isto.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado, pelo
// npm run test:banco. Sem a variavel, fica de fora.
//
// O mundo (especie, linhagem, usuario, formato, estante, o casal e quatro caixas de estoque) e GRAVADO no
// comeco e apagado no fim, como na reserva concorrente, que tem a explicacao do trigger do animal.

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

const daqui = (dias: number) => somarDias(hojeISO(), dias)

const ESPECIE = 'Rato do teste da mudanca concorrente'
const SALA = 'Sala do teste da mudanca concorrente'
const FORMATO = 'Formato do teste da mudanca concorrente'
const DOMINIO = '@mudanca-concorrente.invalid'

/** O parto nasceu 60 dias atras e desmamou 38 dias atras; os machos estao no estoque ha 30 */
const NASCIMENTO = daqui(-60)

/** Quanto uma mudanca pode demorar: mais que isso, ficou esperando a outra para sempre */
const ESPERA_MAXIMA_EM_MS = 30_000

type Mundo = {
  idEstante: number
  tecnico: number
  /** as quatro caixas de estoque de machos; as duas primeiras com 6 machos cada */
  e1: number
  e2: number
  e3: number
  e4: number
}

const esperar = (ms: number) => new Promise((pronto) => setTimeout(pronto, ms))

/** A promessa, ou a recusa de quem ficou esperando para sempre */
function semFicarEsperando<T>(promessa: Promise<T>): Promise<T> {
  return Promise.race([
    promessa,
    esperar(ESPERA_MAXIMA_EM_MS).then(() => {
      throw new Error('as mudancas ficaram esperando uma a outra')
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
    const ocorrencias = await ids(
      `SELECT DISTINCT o.id FROM colonia.ocorrencia o
         LEFT JOIN colonia.ocorrencia_animal oa ON oa.id_ocorrencia = o.id
        WHERE oa.id_animal = ANY($1) OR o.id_usuario = ANY($2) OR o.id_caixa_origem = ANY($3) OR o.id_caixa_destino = ANY($3)`,
      [animais, usuarios, caixas],
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

    await banco.query(`DELETE FROM auditoria.historico WHERE id_usuario = ANY($1)`, [usuarios])
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

/** Grava o mundo: a caixa do casal e quatro de estoque, duas delas com 6 machos desmamados */
async function gravarOMundo(banco: pg.Client): Promise<Mundo> {
  const id = async (sql: string, valores: unknown[] = []) => Number((await banco.query<{ id: number }>(sql, valores)).rows[0]?.id)

  await banco.query('BEGIN')

  try {
    const especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ($1) RETURNING id`, [ESPECIE])
    const idLinhagem = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'W') RETURNING id`, [especie])
    const tecnico = await id(`INSERT INTO login.usuario (nome, email, perfil) VALUES ('tecnico', $1, 'T') RETURNING id`, [
      `tecnico${DOMINIO}`,
    ])

    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ($1) RETURNING id`, [SALA])
    const formato = await id(`INSERT INTO infra.formato (nome, faces, linhas, colunas) VALUES ($1, 1, 2, 3) RETURNING id`, [FORMATO])
    const idEstante = await id(
      `INSERT INTO infra.estante (id_sala, id_formato, numero_visivel) VALUES ($1, $2, 'MC1') RETURNING id`,
      [sala, formato],
    )
    const caixa = (linha: number, coluna: number, tipo: string) =>
      id(
        `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo, sexo, id_linhagem)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [idEstante, linha, coluna, especie, tipo, tipo === 'estoque' ? 'M' : null, tipo === 'estoque' ? idLinhagem : null],
      )
    const caixaDoCasal = await caixa(1, 1, 'casal')
    const e1 = await caixa(1, 2, 'estoque')
    const e2 = await caixa(1, 3, 'estoque')
    const e3 = await caixa(2, 1, 'estoque')
    const e4 = await caixa(2, 2, 'estoque')

    const casal = await id(
      `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao)
       VALUES ($1, $2, 'A', 'B', 'AB', $3::date) RETURNING id`,
      [caixaDoCasal, idLinhagem, daqui(-103)],
    )
    const parto = await id(
      `INSERT INTO reproducao.parto (id_casal, id_linhagem, ordem, dt_acasalamento, dt_parto_real, dt_desmame_real)
       VALUES ($1, $2, 1, $3::date, $4::date, $5::date) RETURNING id`,
      [casal, idLinhagem, daqui(-83), NASCIMENTO, daqui(-38)],
    )

    // nascem na caixa do casal e mudam para o estoque depois do desmame
    for (const estoque of [e1, e2]) {
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
    }

    await banco.query('COMMIT')

    return { idEstante, tecnico, e1, e2, e3, e4 }
  } catch (erro) {
    await banco.query('ROLLBACK')
    throw erro
  }
}

describe.skipIf(!URL_TESTE)('a mudanca em varias caixas ao mesmo tempo, em conexoes separadas', { timeout: 120_000 }, () => {
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

  const conexao = () => abrirTransacaoDoTeste(URL_TESTE as string)

  /** Quantos vivos ha em cada caixa do mundo, lido pela conexao do proprio teste (so o que foi confirmado) */
  async function vivos(): Promise<Record<number, number>> {
    const linhas = await banco.query<{ id_caixa: number; n: number }>(
      `SELECT a.id_caixa, count(*)::int AS n FROM colonia.animal a JOIN infra.caixa c ON c.id = a.id_caixa
        WHERE a.situacao = 'vivo' AND c.id_estante = $1 GROUP BY a.id_caixa`,
      [m.idEstante],
    )
    return Object.fromEntries(linhas.rows.map((linha) => [linha.id_caixa, linha.n]))
  }

  /** Roda a mudanca na transacao 't' e a confirma assim que termina: cada uma segue o seu caminho */
  async function mudarEConfirmar(t: TransacaoDoTeste, idOrigem: number, destinos: [number, number]) {
    try {
      return await naTransacao(t.tx, () =>
        registrarMudanca(
          idOrigem,
          {
            dtFato: daqui(-10),
            machos: [
              { qtd: 2, destino: { idCaixa: destinos[0] } },
              { qtd: 2, destino: { idCaixa: destinos[1] } },
            ],
          },
          m.tecnico,
        ),
      ).then(
        async (feita) => {
          await t.confirmar()
          return { feita }
        },
        async (erro: unknown) => {
          await t.desfazer()
          return { erro }
        },
      )
    } catch (erro) {
      return { erro }
    }
  }

  it('destinos cruzados (A: E1 para E3 e E2; B: E2 para E4 e E1) ao mesmo tempo: as duas terminam, sem deadlock e sem perder animal', async () => {
    const a = await conexao()
    const b = await conexao()

    const [deA, deB] = await semFicarEsperando(
      Promise.all([mudarEConfirmar(a, m.e1, [m.e3, m.e2]), mudarEConfirmar(b, m.e2, [m.e4, m.e1])]),
    )

    expect(deA).toHaveProperty('feita')
    expect(deB).toHaveProperty('feita')
    // E1: 6 - 4 + 2; E2: 6 + 2 - 4; E3 e E4 recebem 2 cada: ninguem perdeu nem ganhou animal
    expect(await vivos()).toEqual({ [m.e1]: 4, [m.e2]: 4, [m.e3]: 2, [m.e4]: 2 })
  })

  it('a segunda espera a primeira confirmar e ve o que ela gravou: a soma e conferida contra o que sobrou', async () => {
    // estado do teste anterior: E1 4, E2 4, E3 2, E4 2. A tira 4 de E1 (fica vazia e e liberada);
    // B, que ao mesmo tempo quer 2 + 2 de E1, espera e depois nao acha animal
    const a = await conexao()
    const b = await conexao()

    const feitaA = await naTransacao(a.tx, () =>
      registrarMudanca(
        m.e1,
        { dtFato: daqui(-9), machos: [{ qtd: 2, destino: { idCaixa: m.e3 } }, { qtd: 2, destino: { idCaixa: m.e4 } }] },
        m.tecnico,
      ),
    )
    expect(feitaA.liberada).toBe(true)

    const segunda = naTransacao(b.tx, () =>
      registrarMudanca(
        m.e1,
        { dtFato: daqui(-9), machos: [{ qtd: 2, destino: { idCaixa: m.e3 } }, { qtd: 2, destino: { idCaixa: m.e4 } }] },
        m.tecnico,
      ),
    ).then(
      () => 'passou',
      (erro: unknown) => erro,
    )

    // a caixa de origem esta travada pela primeira: a segunda espera
    expect(await Promise.race([segunda, esperar(1_500).then(() => 'esperando')])).toBe('esperando')

    await a.confirmar()

    // a caixa foi liberada pela primeira: a segunda e recusada, e nada do que ela tentou fica
    expect(await semFicarEsperando(segunda)).toEqual(expect.objectContaining({ status: 409, codigo: 'CAIXA_LIBERADA' }))
    await b.desfazer()
    expect(await vivos()).toEqual({ [m.e2]: 4, [m.e3]: 4, [m.e4]: 4 })
  })
})
