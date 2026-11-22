import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { abrirTransacaoDoTeste, naTransacao } from '../../shared/testes/transacao.ts'
import type { TransacaoDoTeste } from '../../shared/testes/transacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { somarDias } from './cadeiaTemporal.ts'
import { levarParaViuvas } from './viuva.service.ts'

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

const daqui = (dias: number) => somarDias(hojeISO(), dias)

const ESPECIE = 'Rato do teste das viuvas concorrentes'
const SALA = 'Sala do teste das viuvas concorrentes'
const DOMINIO = '@viuvas-concorrente.invalid'

const ESPERA_MAXIMA_EM_MS = 30_000

type Mundo = { tecnico: number; caixaDeViuvas: number; candidatos: [number, number] }

const esperar = (ms: number) => new Promise((pronto) => setTimeout(pronto, ms))

function semFicarEsperando<T>(promessa: Promise<T>): Promise<T> {
  return Promise.race([
    promessa,
    esperar(ESPERA_MAXIMA_EM_MS).then(() => {
      throw new Error('as idas ficaram esperando uma a outra')
    }),
  ])
}

async function apagarOMundo(banco: pg.Client): Promise<void> {
  const ids = async (sql: string, valores: unknown[]) => (await banco.query<{ id: number }>(sql, valores)).rows.map((r) => r.id)

  await banco.query('BEGIN')

  try {
    const especies = await ids(`SELECT id FROM catalogo.especie WHERE nome = $1`, [ESPECIE])
    const usuarios = await ids(`SELECT id FROM login.usuario WHERE email LIKE $1`, [`%${DOMINIO}`])
    const linhagens = await ids(`SELECT id FROM catalogo.linhagem WHERE id_especie = ANY($1)`, [especies])
    const caixas = await ids(`SELECT id FROM infra.caixa WHERE id_especie = ANY($1)`, [especies])

    await banco.query(`DELETE FROM auditoria.historico WHERE id_usuario = ANY($1)`, [usuarios])
    await banco.query(`DELETE FROM reproducao.parto WHERE id_linhagem = ANY($1)`, [linhagens])
    await banco.query(`DELETE FROM reproducao.viuva WHERE id_linhagem = ANY($1)`, [linhagens])
    await banco.query(`DELETE FROM reproducao.casal WHERE id_linhagem = ANY($1)`, [linhagens])
    await banco.query(`DELETE FROM infra.caixa WHERE id = ANY($1)`, [caixas])
    await banco.query(`DELETE FROM infra.estante WHERE id_sala IN (SELECT id FROM infra.sala WHERE nome = $1)`, [SALA])
    await banco.query(`DELETE FROM infra.sala WHERE nome = $1`, [SALA])
    await banco.query(`DELETE FROM catalogo.linhagem WHERE id = ANY($1)`, [linhagens])
    await banco.query(`DELETE FROM catalogo.especie WHERE id = ANY($1)`, [especies])
    await banco.query(`DELETE FROM login.usuario WHERE id = ANY($1)`, [usuarios])

    await banco.query('COMMIT')
  } catch (erro) {
    await banco.query('ROLLBACK')
    throw erro
  }
}

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
    const idEstante = await id(
      `INSERT INTO infra.estante (id_sala, fabricante, modelo, numero_visivel, faces, linhas, colunas, capacidade)
       VALUES ($1, 'Teste', 'Teste', 'VC1', 1, 2, 5, 10) RETURNING id`,
      [sala],
    )
    const caixa = (linha: number, coluna: number, tipo: string) =>
      id(
        `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo, sexo, id_linhagem)
         VALUES ($1, 1, $2, $3, $4, $5, NULL, $6) RETURNING id`,
        [idEstante, linha, coluna, especie, tipo, tipo === 'viuvas' ? idLinhagem : null],
      )
    const caixaDeViuvas = await caixa(2, 5, 'viuvas')

    const grupos = ['A', 'B', 'C', 'D', 'E']
    const casal = async (n: number) => {
      const idCaixa = await caixa(1, n, 'casal')
      const identificacao = `${grupos[n - 1]}${grupos[n]}`
      const idCasal = await id(
        `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao, dt_encerramento, ativo)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, false) RETURNING id`,
        [idCaixa, idLinhagem, grupos[n - 1], grupos[n], identificacao, daqui(-100), daqui(-70)],
      )
      await banco.query(
        `INSERT INTO reproducao.parto (id_casal, id_linhagem, ordem, dt_acasalamento, dt_parto_real, dt_desmame_real)
         VALUES ($1, $2, 5, $3::date, $4::date, $5::date)`,
        [idCasal, idLinhagem, daqui(-93), daqui(-70), daqui(-48)],
      )
      return idCasal
    }

    for (const n of [1, 2]) {
      await banco.query(
        `INSERT INTO reproducao.viuva (id_caixa, id_casal, id_linhagem, dt_viuvez) VALUES ($1, $2, $3, $4::date)`,
        [caixaDeViuvas, await casal(n), idLinhagem, daqui(-40)],
      )
    }

    const candidatos: [number, number] = [await casal(3), await casal(4)]
    await banco.query('COMMIT')

    return { tecnico, caixaDeViuvas, candidatos }
  } catch (erro) {
    await banco.query('ROLLBACK')
    throw erro
  }
}

describe.skipIf(!URL_TESTE)('duas idas para a ultima vaga da caixa de viuvas, em conexoes separadas', { timeout: 120_000 }, () => {
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

  async function irEConfirmar(t: TransacaoDoTeste, idCasal: number) {
    try {
      const feita = await naTransacao(t.tx, () =>
        levarParaViuvas(idCasal, { dtViuvez: daqui(-40), idCaixa: m.caixaDeViuvas }, m.tecnico),
      )
      await t.confirmar()
      return { feita }
    } catch (erro) {
      await t.desfazer()
      return { erro }
    }
  }

  it('as duas disputam a ultima vaga: uma entra, a outra e recusada com a caixa cheia, sem deadlock', async () => {
    const a = await conexao()
    const b = await conexao()

    const [deA, deB] = await semFicarEsperando(Promise.all([irEConfirmar(a, m.candidatos[0]), irEConfirmar(b, m.candidatos[1])]))

    const entraram = [deA, deB].filter((r) => 'feita' in r)
    const recusadas = [deA, deB].filter((r) => 'erro' in r)
    expect(entraram).toHaveLength(1)
    expect(recusadas).toHaveLength(1)
    expect(recusadas[0]).toEqual({ erro: expect.objectContaining({ status: 409, codigo: 'CAIXA_DE_VIUVAS' }) })

    const naCaixa = await banco.query<{ n: number }>(`SELECT count(*)::int AS n FROM reproducao.viuva WHERE id_caixa = $1`, [m.caixaDeViuvas])
    expect(naCaixa.rows[0]?.n).toBe(3)

    const viuvas = await banco.query<{ n: number }>(`SELECT count(*)::int AS n FROM reproducao.viuva WHERE id_casal = ANY($1)`, [m.candidatos])
    expect(viuvas.rows[0]?.n).toBe(1)
  })
})
