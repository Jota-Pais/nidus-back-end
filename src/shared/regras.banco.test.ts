import pg from 'pg'
import type { DatabaseError } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// O que o banco cobra sozinho no modelo por rato (migration 20261108200000_colonia_por_animal): os
// tres triggers (a topologia da caixa, o animal coerente e o pedido coerente) e os CHECKs da linha.
// Os testes de servico mockam o Prisma e nao enxergam nada disto.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado, um branch
// de teste da Neon ou um Postgres local. Sem a variavel, a suite fica de fora (skip).
//
//   DATABASE_URL_TESTE="postgresql://..." npm run test:banco
//
// Nada fica gravado: tudo roda numa transacao que termina em ROLLBACK. O mundo minimo (especies,
// estante, caixas, casais, partos, animais e pedidos) nasce dentro dela, com nomes proprios, e cada
// caso roda num SAVEPOINT desfeito no fim. Os ids do banco nao importam; so as sequencias andam.

const URL_TESTE = process.env.DATABASE_URL_TESTE

/** Os ids do mundo de teste */
type Mundo = {
  usuario: number
  estante: number
  rato: number
  linhagemW: number
  linhagemK: number
  /** caixas de rato: as dos dois casais e tres de estoque (machos W, femeas W, machos K) */
  caixaCasal1: number
  caixaCasal2: number
  estoqueMachosW: number
  estoqueFemeasW: number
  estoqueMachosK: number
  /** estoque de machos de camundongo */
  estoqueCamundongo: number
  /** parto 1 do casal 1 (Wistar): nasceu e desmamou. O parto 2 do casal 1 ainda nao nasceu */
  parto1: number
  partoNaoNascido: number
  /** parto do casal 2 (Kyoto) */
  partoK: number
  /** os 3 machos do parto 1 que ficaram na caixa do casal e os 3 que foram para o estoque */
  machosNoCasal: number[]
  machosNoEstoque: number[]
  /** as 6 femeas do parto 1, na caixa do casal */
  femeas: number[]
  /** os 3 machos do parto K, na caixa do casal 2 */
  machosK: number[]
  /** Wistar, aprovado: 1 macho, 1 femea e 2 de qualquer sexo */
  pedido: number
  /** Kyoto, aprovado, 1 macho */
  pedidoK: number
  /** Wistar, ainda enviado, 1 macho */
  pedidoEnviado: number
  /** uma baixa registrada na trilha, para as anulacoes */
  baixa: number
}

type Comando = string | { sql: string; valores: unknown[] }

describe.skipIf(!URL_TESTE)('regras do banco', { timeout: 30_000 }, () => {
  let banco: pg.Client
  let m: Mundo

  /** Roda os comandos em ordem e devolve as linhas do ultimo */
  async function rodar(...comandos: Comando[]): Promise<Record<string, unknown>[]> {
    let linhas: Record<string, unknown>[] = []

    for (const comando of comandos) {
      const resultado = typeof comando === 'string'
        ? await banco.query(comando)
        : await banco.query(comando.sql, comando.valores)
      linhas = resultado.rows
    }

    return linhas
  }

  /** O primeiro valor da primeira linha do ultimo comando */
  async function valor(...comandos: Comando[]): Promise<unknown> {
    const [linha] = await rodar(...comandos)

    return linha === undefined ? undefined : Object.values(linha)[0]
  }

  /** Roda os comandos esperando que o banco recuse algum deles, e devolve o erro */
  async function recusa(...comandos: Comando[]): Promise<DatabaseError> {
    try {
      await rodar(...comandos)
    } catch (erro) {
      return erro as DatabaseError
    }

    throw new Error('o banco aceitou, e devia recusar')
  }

  /** O RAISE de um trigger nosso: check_violation com a mensagem 'PREFIXO: ...' */
  async function recusaDoTrigger(prefixo: string, ...comandos: Comando[]) {
    const erro = await recusa(...comandos)

    expect(erro.code).toBe('23514')
    expect(erro.message).toMatch(new RegExp(`^${prefixo}: `))
  }

  /** CHECK (23514) ou unicidade (23505), pelo nome */
  async function recusaDaConstraint(nome: string, ...comandos: Comando[]) {
    const erro = await recusa(...comandos)

    expect(['23514', '23505']).toContain(erro.code)
    expect(erro.constraint).toBe(nome)
  }

  const id = async (sql: string, valores: unknown[] = []) =>
    Number((await banco.query(sql, valores)).rows[0].id)

  const ids = async (sql: string, valores: unknown[] = []) =>
    (await banco.query(sql, valores)).rows.map((linha) => Number(linha.id))

  /** n animais vivos nascidos do parto, na caixa do casal dele */
  const nascer = (parto: number, sexo: 'M' | 'F', n: number, caixa: number) =>
    ids(
      `INSERT INTO colonia.animal (id_parto, sexo, id_caixa)
       SELECT $1::int, $2::char(1), $3::int FROM generate_series(1, $4::int) RETURNING id`,
      [parto, sexo, caixa, n],
    )

  const caixa = (face: number, linha: number, coluna: number, especie: number, tipo = 'casal', sexo: string | null = null, linhagem: number | null = null) =>
    id(
      `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo, sexo, id_linhagem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [m.estante, face, linha, coluna, especie, tipo, sexo, linhagem],
    )

  const pedido = (linhagem: number, especie: number, status: string, qtdM: number, qtdF: number, qtdQualquer: number) =>
    id(
      `INSERT INTO demanda.pedido (protocolo_ceua, id_usuario_solicitante, id_especie, id_linhagem, nome_pesquisador,
                                   qtd_m, qtd_f, qtd_qualquer, idade_min_dias, idade_max_dias, dt_desejada, status)
       VALUES ('2026000000', $1, $2, $3, 'Teste', $4, $5, $6, 21, 90, '2026-12-01', $7) RETURNING id`,
      [m.usuario, especie, linhagem, qtdM, qtdF, qtdQualquer, status],
    )

  beforeAll(async () => {
    banco = new pg.Client({ connectionString: URL_TESTE })
    await banco.connect()
    await banco.query('BEGIN')

    m = {} as Mundo
    const rato = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Rato do teste') RETURNING id`)
    const camundongo = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Camundongo do teste') RETURNING id`)
    m.rato = rato
    m.linhagemW = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'W') RETURNING id`, [rato])
    m.linhagemK = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'K') RETURNING id`, [rato])
    const linhagemS = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'S') RETURNING id`, [camundongo])
    // os pares da rotacao em anel ja existem num banco com a carga inicial
    await banco.query(`INSERT INTO catalogo.grupo_genetico_par (grupo_macho, grupo_femea) VALUES ('A', 'B'), ('B', 'C') ON CONFLICT DO NOTHING`)
    m.usuario = await id(`INSERT INTO login.usuario (nome, email, perfil) VALUES ('Teste', 'regras-do-banco@teste.invalid', 'T') RETURNING id`)
    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ('Sala do teste') RETURNING id`)
    m.estante = await id(
      `INSERT INTO infra.estante (id_sala, fabricante, modelo, numero_visivel, faces, linhas, colunas, capacidade)
       VALUES ($1, 'Teste', 'Teste', 'T1', 2, 4, 4, 32) RETURNING id`,
      [sala],
    )

    m.caixaCasal1 = await caixa(1, 1, 1, rato)
    m.caixaCasal2 = await caixa(1, 1, 2, rato)
    m.estoqueMachosW = await caixa(1, 1, 3, rato, 'estoque', 'M', m.linhagemW)
    m.estoqueFemeasW = await caixa(1, 1, 4, rato, 'estoque', 'F', m.linhagemW)
    m.estoqueMachosK = await caixa(1, 2, 1, rato, 'estoque', 'M', m.linhagemK)
    m.estoqueCamundongo = await caixa(1, 2, 2, camundongo, 'estoque', 'M', linhagemS)

    const casal1 = await id(
      `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao)
       VALUES ($1, $2, 'A', 'B', 'AB', '2026-08-01') RETURNING id`,
      [m.caixaCasal1, m.linhagemW],
    )
    const casal2 = await id(
      `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao)
       VALUES ($1, $2, 'B', 'C', 'BC', '2026-08-01') RETURNING id`,
      [m.caixaCasal2, m.linhagemK],
    )
    m.parto1 = await id(
      `INSERT INTO reproducao.parto (id_casal, ordem, dt_acasalamento, dt_parto_real, dt_desmame_real)
       VALUES ($1, 1, '2026-08-01', '2026-08-22', '2026-09-12') RETURNING id`,
      [casal1],
    )
    m.partoNaoNascido = await id(
      `INSERT INTO reproducao.parto (id_casal, ordem, dt_acasalamento) VALUES ($1, 2, '2026-09-13') RETURNING id`,
      [casal1],
    )
    m.partoK = await id(
      `INSERT INTO reproducao.parto (id_casal, ordem, dt_acasalamento, dt_parto_real, dt_desmame_real)
       VALUES ($1, 1, '2026-08-01', '2026-08-22', '2026-09-12') RETURNING id`,
      [casal2],
    )

    const machos = await nascer(m.parto1, 'M', 6, m.caixaCasal1)
    m.machosNoCasal = machos.slice(0, 3)
    m.machosNoEstoque = machos.slice(3)
    await banco.query(
      `UPDATE colonia.animal SET id_caixa = $1, dt_movimento = '2026-10-01' WHERE id = ANY($2)`,
      [m.estoqueMachosW, m.machosNoEstoque],
    )
    m.femeas = await nascer(m.parto1, 'F', 6, m.caixaCasal1)
    m.machosK = await nascer(m.partoK, 'M', 3, m.caixaCasal2)

    m.pedido = await pedido(m.linhagemW, rato, 'aprovado', 1, 1, 2)
    m.pedidoK = await pedido(m.linhagemK, rato, 'aprovado', 1, 0, 0)
    m.pedidoEnviado = await pedido(m.linhagemW, rato, 'enviado', 1, 0, 0)
    m.baixa = await id(
      `INSERT INTO colonia.ocorrencia (tipo, dt_fato, id_parto, motivo) VALUES ('baixa', '2026-11-01', $1, 'teste') RETURNING id`,
      [m.parto1],
    )
  }, 120_000)

  afterAll(async () => {
    if (banco !== undefined) {
      await banco.query('ROLLBACK')
      await banco.end()
    }
  })

  beforeEach(async () => {
    await banco.query('SAVEPOINT caso')
  })

  afterEach(async () => {
    await banco.query('ROLLBACK TO SAVEPOINT caso')
  })

  /** reserva os animais para o pedido */
  const reservar = (pedidoId: number, animais: number[]): Comando => ({
    sql: 'UPDATE colonia.animal SET id_pedido = $1 WHERE id = ANY($2)',
    valores: [pedidoId, animais],
  })

  const morrer = (animais: number[]): Comando => ({
    sql: `UPDATE colonia.animal SET situacao = 'morto', dt_saida = '2026-11-05' WHERE id = ANY($1)`,
    valores: [animais],
  })

  /** muda o status; o entregue leva a data da entrega, e os outros ficam sem ela */
  const statusDo = (pedidoId: number, status: string): Comando => ({
    sql: 'UPDATE demanda.pedido SET status = $2, dt_entrega = $3 WHERE id = $1',
    valores: [pedidoId, status, status === 'entregue' ? '2026-11-06' : null],
  })

  const entregarReservados = (pedidoId: number): Comando => ({
    sql: `UPDATE colonia.animal SET situacao = 'entregue', dt_saida = '2026-11-06' WHERE id_pedido = $1 AND situacao = 'vivo'`,
    valores: [pedidoId],
  })

  /** 1 macho, 1 femea e 2 de qualquer sexo: 2 machos e 2 femeas cobrem o pedido exatamente */
  const coberturaExata = () => [...m.machosNoEstoque.slice(0, 2), ...m.femeas.slice(0, 2)]

  describe('a caixa cabe na estante e o codigo e o da posicao (infra.caixa_dentro_da_topologia)', () => {
    it('recusa a posicao fora da estante', async () => {
      await recusaDoTrigger('TOPOLOGIA', {
        sql: `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie) VALUES ($1, 1, 9, 1, (SELECT id_especie FROM infra.caixa WHERE id = $2))`,
        valores: [m.estante, m.caixaCasal1],
      })
    })

    it('recusa a estante com colunas demais para as 26 letras do endereco', async () => {
      await recusaDoTrigger('TOPOLOGIA',
        `UPDATE infra.estante SET colunas = 14, capacidade = faces * linhas * 14 WHERE id = ${m.estante}`,
        `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie)
         SELECT id_estante, 2, 1, 14, id_especie FROM infra.caixa WHERE id = ${m.caixaCasal1}`)
    })

    it('escreve o codigo no INSERT, a traseira continuando as letras da frontal', async () => {
      expect(await valor({
        sql: `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie)
              SELECT $1, 2, 4, 4, id_especie FROM infra.caixa WHERE id = $2 RETURNING codigo`,
        valores: [m.estante, m.caixaCasal1],
      })).toBe('T4H')
    })

    it('reescreve o codigo quando a caixa muda de posicao, e o escrito a mao volta ao da posicao', async () => {
      expect(await valor(`UPDATE infra.caixa SET linha = 3 WHERE id = ${m.caixaCasal1} RETURNING codigo`)).toBe('F3A')
      expect(await valor(`UPDATE infra.caixa SET codigo = 'XYZ' WHERE id = ${m.caixaCasal1} RETURNING codigo`)).toBe('F3A')
    })
  })

  describe('a vida do animal (colonia.animal_coerente)', () => {
    it('todo animal entra vivo', async () => {
      await recusaDoTrigger('ANIMAL_SITUACAO',
        `INSERT INTO colonia.animal (id_parto, sexo, id_caixa, situacao, dt_saida) VALUES (${m.parto1}, 'M', ${m.caixaCasal1}, 'morto', '2026-11-05')`)
    })

    it('so nasce animal de parto que ja nasceu', async () => {
      await recusaDoTrigger('ANIMAL_ORIGEM',
        `INSERT INTO colonia.animal (id_parto, sexo, id_caixa) VALUES (${m.partoNaoNascido}, 'M', ${m.caixaCasal1})`)
    })

    it('o parto de origem nao muda', async () => {
      await recusaDoTrigger('ANIMAL_ORIGEM', `UPDATE colonia.animal SET id_parto = ${m.partoK} WHERE id = ${m.machosNoCasal[0]}`)
    })

    it('entregue e final', async () => {
      await recusaDoTrigger('ANIMAL_SITUACAO',
        reservar(m.pedido, coberturaExata()),
        statusDo(m.pedido, 'reservado'),
        entregarReservados(m.pedido),
        `UPDATE colonia.animal SET situacao = 'vivo', dt_saida = NULL WHERE id = ${m.femeas[0]}`)
    })

    it('o animal nao se apaga, nem o que ainda nao tem nada na trilha', async () => {
      await recusaDoTrigger('ANIMAL_SITUACAO', `DELETE FROM colonia.animal WHERE id = ${m.machosNoCasal[0]}`)
    })

    it('anulado e final', async () => {
      await recusaDoTrigger('ANIMAL_SITUACAO',
        `UPDATE colonia.animal SET situacao = 'anulado' WHERE id = ${m.femeas[0]}`,
        `UPDATE colonia.animal SET situacao = 'vivo' WHERE id = ${m.femeas[0]}`)
    })

    it('morto so volta a vivo: nao vira entregue nem muda de caixa', async () => {
      await recusaDoTrigger('ANIMAL_SITUACAO', morrer([m.femeas[0]!]),
        `UPDATE colonia.animal SET situacao = 'entregue', id_pedido = ${m.pedido} WHERE id = ${m.femeas[0]}`)
      await banco.query('ROLLBACK TO SAVEPOINT caso')
      await recusaDoTrigger('ANIMAL_SITUACAO', morrer([m.femeas[0]!]),
        `UPDATE colonia.animal SET id_caixa = ${m.estoqueFemeasW} WHERE id = ${m.femeas[0]}`)
    })

    it('a anulacao da baixa traz o morto de volta a vida, na caixa onde estava', async () => {
      expect(await valor(morrer([m.femeas[0]!]),
        `UPDATE colonia.animal SET situacao = 'vivo', dt_saida = NULL WHERE id = ${m.femeas[0]} RETURNING situacao`)).toBe('vivo')
    })
  })

  describe('onde um vivo pode estar (colonia.animal_coerente)', () => {
    it('na caixa de estoque, so do sexo dela', async () => {
      await recusaDoTrigger('ANIMAL_CAIXA', `UPDATE colonia.animal SET id_caixa = ${m.estoqueMachosW} WHERE id = ${m.femeas[0]}`)
    })

    it('na caixa de estoque, so da linhagem dela', async () => {
      await recusaDoTrigger('ANIMAL_CAIXA', `UPDATE colonia.animal SET id_caixa = ${m.estoqueMachosK} WHERE id = ${m.machosNoCasal[0]}`)
    })

    it('so em caixa da especie dele', async () => {
      await recusaDoTrigger('ANIMAL_CAIXA', `UPDATE colonia.animal SET id_caixa = ${m.estoqueCamundongo} WHERE id = ${m.machosNoCasal[0]}`)
    })

    it('na caixa de casal, so a ninhada do proprio casal', async () => {
      await recusaDoTrigger('ANIMAL_CAIXA', `UPDATE colonia.animal SET id_caixa = ${m.caixaCasal2} WHERE id = ${m.machosNoCasal[0]}`)
    })

    it('o sexo nao troca dentro da caixa de estoque', async () => {
      await recusaDoTrigger('ANIMAL_CAIXA', `UPDATE colonia.animal SET sexo = 'F' WHERE id = ${m.machosNoEstoque[0]}`)
    })

    it('so em caixa ativa', async () => {
      await recusaDoTrigger('ANIMAL_CAIXA',
        `UPDATE infra.caixa SET ativa = false, dt_liberacao = '2026-11-05', motivo_liberacao = 'mudanca' WHERE id = ${m.estoqueFemeasW}`,
        `UPDATE colonia.animal SET id_caixa = ${m.estoqueFemeasW}, dt_movimento = '2026-11-05' WHERE id = ${m.femeas[0]}`)
    })

    it('o morto nao volta a viver numa caixa ja liberada', async () => {
      await recusaDoTrigger('ANIMAL_CAIXA',
        morrer(m.machosNoEstoque),
        `UPDATE infra.caixa SET ativa = false, dt_liberacao = '2026-11-05', motivo_liberacao = 'baixa' WHERE id = ${m.estoqueMachosW}`,
        `UPDATE colonia.animal SET situacao = 'vivo', dt_saida = NULL WHERE id = ${m.machosNoEstoque[0]}`)
    })

    it('a mudanca para o estoque do sexo e da linhagem certos passa', async () => {
      expect(await valor(
        `UPDATE colonia.animal SET id_caixa = ${m.estoqueFemeasW}, dt_movimento = '2026-11-05' WHERE id = ANY('{${m.femeas.join(',')}}')`,
        `SELECT count(*)::int FROM colonia.animal WHERE id_caixa = ${m.estoqueFemeasW} AND situacao = 'vivo'`)).toBe(6)
    })
  })

  describe('a reserva (colonia.animal_coerente)', () => {
    it('so de animal vivo', async () => {
      await recusaDoTrigger('PEDIDO_RESERVA', morrer([m.femeas[0]!]), reservar(m.pedido, [m.femeas[0]!]))
    })

    it('so para pedido da linhagem do animal', async () => {
      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedidoK, [m.machosNoCasal[0]!]))
    })

    it('so para pedido aprovado ou reservado', async () => {
      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedidoEnviado, [m.machosNoCasal[0]!]))
    })

    it('nao troca de pedido sem desfazer antes', async () => {
      const outro = await pedido(m.linhagemW, m.rato, 'aprovado', 1, 0, 0)

      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedido, [m.machosNoCasal[0]!]), reservar(outro, [m.machosNoCasal[0]!]))
    })

    it('o sexo de animal reservado nao muda', async () => {
      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedido, [m.machosNoCasal[0]!]),
        `UPDATE colonia.animal SET sexo = 'F' WHERE id = ${m.machosNoCasal[0]}`)
    })

    it('o morto guarda o pedido como registro: a reserva dele nao se desfaz', async () => {
      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedido, [m.femeas[0]!]), morrer([m.femeas[0]!]),
        `UPDATE colonia.animal SET id_pedido = NULL WHERE id = ${m.femeas[0]}`)
    })

    it('nao passa do pedido num comando so', async () => {
      await recusaDoTrigger('PEDIDO_EXCEDIDO', reservar(m.pedido, [...coberturaExata(), m.femeas[5]!]))
    })

    it('nao passa do pedido somando comandos', async () => {
      await recusaDoTrigger('PEDIDO_EXCEDIDO', reservar(m.pedido, coberturaExata()), reservar(m.pedido, [m.femeas[5]!]))
    })

    it('machos nao passam de qtd_m + qualquer, mesmo com o total folgado', async () => {
      // o pedido aceita 1 macho e 2 de qualquer sexo: o 4o macho passa do que cabe para machos
      await recusaDoTrigger('PEDIDO_EXCEDIDO', reservar(m.pedido, [...m.machosNoEstoque, m.machosNoCasal[0]!]))
    })

    it('femeas nao passam de qtd_f + qualquer: o macho pedido nunca vira femea', async () => {
      // 4 femeas fecham o total, mas o pedido quer 1 macho. Por isso o teto com o total exato ja
      // garante a cobertura que o pedido reservado exige
      await recusaDoTrigger('PEDIDO_EXCEDIDO', reservar(m.pedido, m.femeas.slice(0, 4)))
    })

    it('a anulacao da baixa de um reservado traz a reserva junto', async () => {
      expect(await valor(reservar(m.pedido, [m.femeas[0]!]), morrer([m.femeas[0]!]),
        `UPDATE colonia.animal SET situacao = 'vivo', dt_saida = NULL WHERE id = ${m.femeas[0]} RETURNING id_pedido`)).toBe(m.pedido)
    })

    it('a anulacao nao passa do pedido quando a falta ja foi completada', async () => {
      const [morta, ...resto] = coberturaExata().reverse()

      await recusaDoTrigger('PEDIDO_EXCEDIDO',
        reservar(m.pedido, [morta!, ...resto]),
        morrer([morta!]),
        reservar(m.pedido, [m.femeas[5]!]),
        `UPDATE colonia.animal SET situacao = 'vivo', dt_saida = NULL WHERE id = ${morta}`)
    })

    it('desfazer a reserva de um vivo passa', async () => {
      expect(await valor(reservar(m.pedido, coberturaExata()),
        `UPDATE colonia.animal SET id_pedido = NULL WHERE id = ${m.femeas[0]}`,
        `SELECT count(*)::int FROM colonia.animal WHERE id_pedido = ${m.pedido}`)).toBe(3)
    })

    it('a entrega so sai de pedido reservado: o aprovado, mesmo com a reserva inteira, passa a reservado antes', async () => {
      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedido, coberturaExata()), entregarReservados(m.pedido))
    })
  })

  // O defeito achado pelo Arthur no modelo antigo: o trigger da oferta somava as reservas do parto
  // inteiro e conferia os dois sexos, e reservar so femeas falhava porque outro pedido tinha machos
  // em falta na mesma ninhada. Aqui cada reserva confere so o teto do proprio pedido
  describe('o caso do Arthur: a reserva confere so o proprio pedido (colonia.animal_coerente)', () => {
    const vivosReservados = (pedidos: number[]): Comando => ({
      sql: `SELECT id_pedido AS pedido, sexo, count(*)::int AS vivos FROM colonia.animal
             WHERE id_pedido = ANY($1) AND situacao = 'vivo' GROUP BY 1, 2 ORDER BY 1, 2`,
      valores: [pedidos],
    })

    it('com o pedido A em falta de um macho da ninhada, reservar 1 femea dela para o pedido B passa', async () => {
      const pedidoA = await pedido(m.linhagemW, m.rato, 'aprovado', 2, 0, 0)
      const pedidoB = await pedido(m.linhagemW, m.rato, 'aprovado', 0, 1, 0)
      const [morto, vivo] = m.machosNoCasal

      expect(await rodar(
        reservar(pedidoA, [morto!, vivo!]),
        statusDo(pedidoA, 'reservado'),
        morrer([morto!]),
        reservar(pedidoB, [m.femeas[0]!]),
        statusDo(pedidoB, 'reservado'),
        vivosReservados([pedidoA, pedidoB]),
      )).toEqual([
        { pedido: pedidoA, sexo: 'M', vivos: 1 },
        { pedido: pedidoB, sexo: 'F', vivos: 1 },
      ])
    })

    it('a reserva de outro pedido na ninhada nao pesa no teto: B recebe o macho e a femea que pede', async () => {
      // somando a ninhada, seriam 3 machos reservados para o 1 macho de B
      const pedidoA = await pedido(m.linhagemW, m.rato, 'aprovado', 2, 0, 0)
      const pedidoB = await pedido(m.linhagemW, m.rato, 'aprovado', 1, 1, 0)
      const [machoA1, machoA2, machoB] = m.machosNoCasal

      expect(await valor(
        reservar(pedidoA, [machoA1!, machoA2!]),
        reservar(pedidoB, [machoB!, m.femeas[0]!]),
        statusDo(pedidoB, 'reservado'),
        `SELECT status FROM demanda.pedido WHERE id = ${pedidoB}`,
      )).toBe('reservado')
    })

    it('o teto conta os machos e as femeas do pedido da linha: o 2o macho de B passa do que B pede', async () => {
      const pedidoA = await pedido(m.linhagemW, m.rato, 'aprovado', 2, 0, 0)
      const pedidoB = await pedido(m.linhagemW, m.rato, 'aprovado', 1, 1, 0)
      const [machoA1, machoA2, machoB] = m.machosNoCasal

      await rodar(reservar(pedidoA, [machoA1!, machoA2!]), reservar(pedidoB, [machoB!, m.femeas[0]!]))
      await recusaDoTrigger('PEDIDO_EXCEDIDO', reservar(pedidoB, [m.machosNoEstoque[0]!]))
    })
  })

  describe('o pedido coerente com os seus animais (demanda.pedido_coerente)', () => {
    it('nao nasce reservado nem entregue, porque o pedido novo nao tem animal', async () => {
      const novo = (status: string, dtEntrega: string | null): Comando => ({
        sql: `INSERT INTO demanda.pedido (protocolo_ceua, id_usuario_solicitante, id_especie, id_linhagem, nome_pesquisador,
                                          qtd_m, qtd_f, idade_min_dias, idade_max_dias, dt_desejada, status, dt_entrega)
              VALUES ('2026000000', $1, $2, $3, 'Teste', 1, 0, 21, 90, '2026-12-01', $4, $5)`,
        valores: [m.usuario, m.rato, m.linhagemW, status, dtEntrega],
      })

      await recusaDoTrigger('PEDIDO_INCOMPLETO', novo('reservado', null))
      await banco.query('ROLLBACK TO SAVEPOINT caso')
      await recusaDoTrigger('PEDIDO_INCOMPLETO', novo('entregue', '2026-11-06'))
    })

    it('reservado exige os vivos reservados cobrindo o pedido exatamente', async () => {
      await recusaDoTrigger('PEDIDO_INCOMPLETO', statusDo(m.pedido, 'reservado'))
      await banco.query('ROLLBACK TO SAVEPOINT caso')
      await recusaDoTrigger('PEDIDO_INCOMPLETO', reservar(m.pedido, coberturaExata().slice(1)), statusDo(m.pedido, 'reservado'))
    })

    it('entregue exige nenhum vivo reservado', async () => {
      await recusaDoTrigger('PEDIDO_INCOMPLETO',
        reservar(m.pedido, coberturaExata()), statusDo(m.pedido, 'reservado'), statusDo(m.pedido, 'entregue'))
    })

    it('entregue exige os entregues cobrindo o pedido exatamente', async () => {
      const [morta, ...resto] = coberturaExata().reverse()

      await recusaDoTrigger('PEDIDO_INCOMPLETO',
        reservar(m.pedido, [morta!, ...resto]), statusDo(m.pedido, 'reservado'), morrer([morta!]),
        entregarReservados(m.pedido), statusDo(m.pedido, 'entregue'))
    })

    it('sair de reservado para aprovado ou recusado exige desfazer a reserva antes', async () => {
      await recusaDoTrigger('PEDIDO_COM_RESERVA',
        reservar(m.pedido, coberturaExata()), statusDo(m.pedido, 'reservado'), statusDo(m.pedido, 'aprovado'))
      await banco.query('ROLLBACK TO SAVEPOINT caso')
      await recusaDoTrigger('PEDIDO_COM_RESERVA',
        reservar(m.pedido, coberturaExata()), statusDo(m.pedido, 'reservado'), statusDo(m.pedido, 'recusado'))
    })

    it('so o pedido reservado segura animal: aprovado com reserva nao vai para recusado', async () => {
      await recusaDoTrigger('PEDIDO_COM_RESERVA', reservar(m.pedido, [m.femeas[0]!]), statusDo(m.pedido, 'recusado'))
    })

    it('o pedido que ja entregou animais continua entregue', async () => {
      await recusaDoTrigger('PEDIDO_ENTREGUE',
        reservar(m.pedido, coberturaExata()), statusDo(m.pedido, 'reservado'), entregarReservados(m.pedido),
        statusDo(m.pedido, 'entregue'), statusDo(m.pedido, 'enviado'))
    })

    it('a linhagem do pedido nao muda depois da reserva, nem com o reservado morto', async () => {
      const outraLinhagem = `UPDATE demanda.pedido SET id_linhagem = ${m.linhagemK} WHERE id = ${m.pedido}`

      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedido, [m.femeas[0]!]), outraLinhagem)
      await banco.query('ROLLBACK TO SAVEPOINT caso')
      await recusaDoTrigger('PEDIDO_RESERVA', reservar(m.pedido, [m.femeas[0]!]), morrer([m.femeas[0]!]), outraLinhagem)
    })

    it('a linhagem do pedido sem animais muda', async () => {
      expect(await valor(
        `UPDATE demanda.pedido SET id_linhagem = ${m.linhagemK} WHERE id = ${m.pedidoEnviado} RETURNING id_linhagem`)).toBe(m.linhagemK)
    })

    it('a quantidade nao baixa para menos do que ja foi reservado', async () => {
      await recusaDoTrigger('PEDIDO_EXCEDIDO',
        reservar(m.pedido, coberturaExata()), `UPDATE demanda.pedido SET qtd_qualquer = 1 WHERE id = ${m.pedido}`)
    })

    it('o pedido reservado continua coberto exatamente quando a quantidade muda', async () => {
      await recusaDoTrigger('PEDIDO_INCOMPLETO',
        reservar(m.pedido, coberturaExata()), statusDo(m.pedido, 'reservado'),
        `UPDATE demanda.pedido SET qtd_qualquer = 3 WHERE id = ${m.pedido}`)
    })

    it('reservar, entregar e concluir passa', async () => {
      expect(await valor(
        reservar(m.pedido, coberturaExata()), statusDo(m.pedido, 'reservado'), entregarReservados(m.pedido),
        statusDo(m.pedido, 'entregue'),
        `SELECT status FROM demanda.pedido WHERE id = ${m.pedido}`)).toBe('entregue')
    })

    it('desfazer a reserva e voltar a aprovado passa, e a reserva em falta se completa', async () => {
      const [morta, ...resto] = coberturaExata().reverse()

      expect(await valor(
        reservar(m.pedido, [morta!, ...resto]), statusDo(m.pedido, 'reservado'), morrer([morta!]),
        reservar(m.pedido, [m.femeas[5]!]),
        `UPDATE colonia.animal SET id_pedido = NULL WHERE id_pedido = ${m.pedido} AND situacao = 'vivo'`,
        statusDo(m.pedido, 'aprovado'),
        `SELECT status FROM demanda.pedido WHERE id = ${m.pedido}`)).toBe('aprovado')
    })
  })

  describe('os CHECKs da linha', () => {
    it.each([
      ['caixa_tipo_dominio', () => `UPDATE infra.caixa SET tipo = 'gaiola' WHERE id = ${m.caixaCasal1}`],
      ['caixa_estoque_completo', () => `UPDATE infra.caixa SET id_linhagem = NULL WHERE id = ${m.estoqueMachosW}`],
      ['caixa_estoque_completo', () => `UPDATE infra.caixa SET sexo = 'M' WHERE id = ${m.caixaCasal1}`],
      ['caixa_motivo_liberacao_dominio', () => `UPDATE infra.caixa SET ativa = false, dt_liberacao = '2026-11-05', motivo_liberacao = 'sumiu' WHERE id = ${m.estoqueFemeasW}`],
      ['caixa_liberacao_coerente', () => `UPDATE infra.caixa SET ativa = false WHERE id = ${m.estoqueFemeasW}`],
      ['casal_ativo_coerente', () => `UPDATE reproducao.casal SET ativo = false WHERE id_caixa = ${m.caixaCasal1}`],
      ['casal_encerra_depois_de_formar', () => `UPDATE reproducao.casal SET ativo = false, dt_encerramento = '2026-07-01' WHERE id_caixa = ${m.caixaCasal1}`],
      ['parto_datas_em_ordem', () => `UPDATE reproducao.parto SET dt_desmame_real = '2026-08-21' WHERE id = ${m.parto1}`],
      ['parto_datas_em_ordem', () => `UPDATE reproducao.parto SET dt_sem_ninhada = '2026-11-05', motivo_sem_ninhada = 'x' WHERE id = ${m.parto1}`],
      ['parto_sem_ninhada_tem_motivo', () => `UPDATE reproducao.parto SET dt_sem_ninhada = '2026-11-05' WHERE id = ${m.partoNaoNascido}`],
      ['animal_sexo_dominio', () => `UPDATE colonia.animal SET sexo = 'X' WHERE id = ${m.machosNoCasal[0]}`],
      ['animal_situacao_dominio', () => `UPDATE colonia.animal SET situacao = 'fugiu' WHERE id = ${m.machosNoCasal[0]}`],
      ['animal_saida_coerente', () => `UPDATE colonia.animal SET situacao = 'morto' WHERE id = ${m.machosNoCasal[0]}`],
      ['animal_sai_depois_de_chegar', () => `UPDATE colonia.animal SET situacao = 'morto', dt_saida = '2026-09-30' WHERE id = ${m.machosNoEstoque[0]}`],
      ['animal_entregue_tem_pedido', () => `UPDATE colonia.animal SET situacao = 'entregue', dt_saida = '2026-11-05' WHERE id = ${m.machosNoCasal[0]}`],
      ['ocorrencia_tipo_dominio', () => `INSERT INTO colonia.ocorrencia (tipo, dt_fato) VALUES ('sumico', '2026-11-05')`],
      ['ocorrencia_mudanca_tem_dois_lugares', () => `INSERT INTO colonia.ocorrencia (tipo, dt_fato, id_caixa_origem, id_caixa_destino) VALUES ('mudanca', '2026-11-05', ${m.caixaCasal1}, ${m.caixaCasal1})`],
      ['ocorrencia_demanda_tem_pedido', () => `INSERT INTO colonia.ocorrencia (tipo, dt_fato) VALUES ('reserva', '2026-11-05')`],
      ['ocorrencia_anulacao_aponta', () => `INSERT INTO colonia.ocorrencia (tipo, dt_fato, motivo) VALUES ('anulacao', '2026-11-05', 'erro')`],
      ['ocorrencia_anulacao_aponta', () => `INSERT INTO colonia.ocorrencia (tipo, dt_fato, id_anulada) VALUES ('baixa', '2026-11-05', ${m.baixa})`],
      ['ocorrencia_correcao_tem_motivo', () => `INSERT INTO colonia.ocorrencia (tipo, dt_fato) VALUES ('correcao', '2026-11-05')`],
      ['pedido_status_dominio', () => `UPDATE demanda.pedido SET status = 'cancelado' WHERE id = ${m.pedido}`],
      ['pedido_entregue_tem_data', () => `UPDATE demanda.pedido SET dt_entrega = '2026-11-05' WHERE id = ${m.pedido}`],
      ['pedido_qtd_nao_negativa', () => `UPDATE demanda.pedido SET qtd_m = -1, qtd_qualquer = 3 WHERE id = ${m.pedido}`],
      // os de antes do modelo por rato, que continuam valendo
      ['estante_capacidade_derivada', () => `UPDATE infra.estante SET capacidade = capacidade + 1 WHERE id = ${m.estante}`],
      ['caixa_posicao_positiva', () => `UPDATE infra.caixa SET linha = 0 WHERE id = ${m.caixaCasal1}`],
      ['estante_topologia_positiva', () => `UPDATE infra.estante SET linhas = 0, capacidade = 0 WHERE id = ${m.estante}`],
      ['caixa_uma_por_posicao', () => `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo)
                                       SELECT id_estante, face, linha, coluna, id_especie, 'casal' FROM infra.caixa WHERE id = ${m.caixaCasal1}`],
      ['casal_grupo_macho_dominio', () => `UPDATE reproducao.casal SET grupo_macho = 'Z', identificacao = 'Z' || grupo_femea WHERE id_caixa = ${m.caixaCasal1}`],
      ['casal_grupo_femea_dominio', () => `UPDATE reproducao.casal SET grupo_femea = 'Z', identificacao = grupo_macho || 'Z' WHERE id_caixa = ${m.caixaCasal1}`],
      ['casal_identificacao_derivada', () => `UPDATE reproducao.casal SET identificacao = 'XX' WHERE id_caixa = ${m.caixaCasal1}`],
      ['casal_um_ativo_por_caixa', () => `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao)
                                          SELECT id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao FROM reproducao.casal WHERE id_caixa = ${m.caixaCasal1}`],
      ['parto_ordem_ciclo', () => `UPDATE reproducao.parto SET ordem = 6 WHERE id = ${m.partoNaoNascido}`],
      ['parto_id_casal_ordem_key', () => `INSERT INTO reproducao.parto (id_casal, ordem, dt_acasalamento)
                                          SELECT id_casal, ordem, dt_acasalamento FROM reproducao.parto WHERE id = ${m.parto1}`],
      ['usuario_perfil_dominio', () => `UPDATE login.usuario SET perfil = 'X' WHERE id = ${m.usuario}`],
      ['pedido_ao_menos_um_animal', () => `UPDATE demanda.pedido SET qtd_m = 0, qtd_f = 0, qtd_qualquer = 0 WHERE id = ${m.pedidoEnviado}`],
      ['pedido_faixa_de_idade', () => `UPDATE demanda.pedido SET idade_min_dias = 10 WHERE id = ${m.pedidoEnviado}`],
      ['pedido_qtd_qualquer_nao_negativa', () => `UPDATE demanda.pedido SET qtd_qualquer = -1, qtd_m = 5, qtd_f = 5 WHERE id = ${m.pedidoEnviado}`],
    ])('%s recusa o que nao cabe nele', async (constraint, sql) => {
      await recusaDaConstraint(constraint, sql())
    })

    it('o pedido entregue sem data de entrega cai no CHECK', async () => {
      await recusaDaConstraint('pedido_entregue_tem_data',
        reservar(m.pedido, coberturaExata()), statusDo(m.pedido, 'reservado'), entregarReservados(m.pedido),
        statusDo(m.pedido, 'entregue'), `UPDATE demanda.pedido SET dt_entrega = NULL WHERE id = ${m.pedido}`)
    })

    it('a baixa aceita uma anulacao por caixa de destino: que ela se anula uma vez so e do codigo', async () => {
      const anular = `INSERT INTO colonia.ocorrencia (tipo, dt_fato, id_anulada, motivo) VALUES ('anulacao', '2026-11-05', ${m.baixa}, 'erro')`

      await rodar(anular, anular)
      expect(await valor(`SELECT count(*)::int FROM colonia.ocorrencia WHERE id_anulada = ${m.baixa}`)).toBe(2)
    })
  })
})
