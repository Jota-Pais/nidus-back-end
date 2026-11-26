import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { abrirCaso, abrirTransacaoDoTeste, desfazerCaso } from '../../shared/testes/transacao.ts'
import { trilhaDaCaixa } from './trilhaDoEstoque.ts'

// A trilha da caixa de estoque contra um banco de verdade: o where do Prisma (OR, anulacoes none,
// animais some), o select aninhado e a ordem. Uma caixa de estoque com a entrada do cadastro
// inicial, a mudanca de parte dos animais para outra caixa, a entrega, uma baixa anulada (que nao
// conta) e uma baixa de verdade
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado, pelo
// npm run test:banco. A transacao do teste e desfeita no fim; o mundo nasce dentro dela

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

describe.skipIf(!URL_TESTE)('a trilha da caixa de estoque no banco de verdade', () => {
  let teste: Awaited<ReturnType<typeof abrirTransacaoDoTeste>>
  let caixaA: number
  let caixaB: number
  let codigoB: string
  let pedido: number
  let parto: number

  const tx = () => teste.tx
  const id = async (sql: string, ...valores: unknown[]) =>
    Number((await tx().$queryRawUnsafe<{ id: number }[]>(sql, ...valores))[0]?.id)
  const executar = (sql: string, ...valores: unknown[]) => tx().$executeRawUnsafe(sql, ...valores)

  async function ocorrencia(
    tipo: string,
    dtFato: string,
    campos: { origem?: number; destino?: number; pedido?: number; causa?: string; motivo?: string; anulada?: number; parto?: number },
    animais: number[],
  ) {
    const idOcorrencia = await id(
      `INSERT INTO colonia.ocorrencia (tipo, dt_fato, id_parto, id_caixa_origem, id_caixa_destino, id_pedido, causa, motivo, id_anulada)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      tipo,
      dtFato,
      campos.parto ?? null,
      campos.origem ?? null,
      campos.destino ?? null,
      campos.pedido ?? null,
      campos.causa ?? null,
      campos.motivo ?? null,
      campos.anulada ?? null,
    )
    for (const idAnimal of animais) {
      await executar(`INSERT INTO colonia.ocorrencia_animal (id_ocorrencia, id_animal) VALUES ($1, $2)`, idOcorrencia, idAnimal)
    }

    return idOcorrencia
  }

  beforeAll(async () => {
    teste = await abrirTransacaoDoTeste(URL_TESTE as string)

    const especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Rato do teste da trilha') RETURNING id`)
    const linhagem = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'LT') RETURNING id`, especie)
    const usuario = await id(
      `INSERT INTO login.usuario (nome, email, perfil) VALUES ('trilha', 'trilha@trilha-no-banco.invalid', 'P') RETURNING id`,
    )
    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ('Sala do teste da trilha') RETURNING id`)
    const formato = await id(
      `INSERT INTO infra.formato (nome, faces, linhas, colunas) VALUES ('Formato do teste da trilha', 1, 1, 9) RETURNING id`,
    )
    const estante = await id(
      `INSERT INTO infra.estante (id_sala, id_formato, numero_visivel) VALUES ($1, $2, 'T9') RETURNING id`,
      sala,
      formato,
    )
    const caixa = (coluna: number) =>
      id(
        `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo, sexo, id_linhagem)
         VALUES ($1, 1, 1, $2, $3, 'estoque', 'M', $4) RETURNING id`,
        estante,
        coluna,
        especie,
        linhagem,
      )
    caixaA = await caixa(1)
    caixaB = await caixa(2)
    codigoB = (await tx().$queryRawUnsafe<{ codigo: string }[]>(`SELECT codigo FROM infra.caixa WHERE id = $1`, caixaB))[0]?.codigo as string

    // a ninhada do cadastro inicial: sem casal, sem ordem, sem acasalamento
    parto = await id(
      `INSERT INTO reproducao.parto (id_linhagem, dt_parto_real) VALUES ($1, '2026-09-01'::date) RETURNING id`,
      linhagem,
    )
    pedido = await id(
      `INSERT INTO demanda.pedido (protocolo_ceua, id_usuario_solicitante, id_especie, id_linhagem, nome_pesquisador,
                                   qtd_m, qtd_f, qtd_qualquer, idade_min_dias, idade_max_dias, dt_desejada, status)
       VALUES ('2026000001', $1, $2, $3, 'Teste', 2, 0, 0, 21, 90, '2026-12-01', 'aprovado') RETURNING id`,
      usuario,
      especie,
      linhagem,
    )

    // seis machos entram na caixa A: a1 a a6
    const animais: number[] = []
    for (let i = 0; i < 6; i++) {
      animais.push(await id(`INSERT INTO colonia.animal (id_parto, sexo, id_caixa) VALUES ($1, 'M', $2) RETURNING id`, parto, caixaA))
    }
    const [a1, a2, a3, a4, a5] = animais as [number, number, number, number, number, number]
    await ocorrencia('entrada', '2026-10-01', { destino: caixaA, parto }, animais)

    // a1 e a2 passam para a caixa B
    await executar(`UPDATE colonia.animal SET id_caixa = $2, dt_movimento = '2026-10-05'::date WHERE id = ANY($1::int[])`, [a1, a2], caixaB)
    await ocorrencia('mudanca', '2026-10-05', { origem: caixaA, destino: caixaB }, [a1, a2])

    // a3 (da A) e a1 (agora da B) ficam reservados para o pedido, que passa a reservado, e sao entregues
    await executar(`UPDATE colonia.animal SET id_pedido = $2 WHERE id = ANY($1::int[])`, [a3, a1], pedido)
    await executar(`UPDATE demanda.pedido SET status = 'reservado' WHERE id = $1`, pedido)
    await executar(
      `UPDATE colonia.animal SET situacao = 'entregue', dt_saida = '2026-10-10'::date, id_pedido = $2 WHERE id = ANY($1::int[])`,
      [a3, a1],
      pedido,
    )
    await ocorrencia('entrega', '2026-10-10', { pedido }, [a3, a1])

    // a4: a baixa foi anulada e o animal voltou para a propria caixa
    await executar(`UPDATE colonia.animal SET situacao = 'morto', dt_saida = '2026-10-12'::date WHERE id = $1`, a4)
    const baixaAnulada = await ocorrencia('baixa', '2026-10-12', { origem: caixaA, causa: 'morte', motivo: 'engano' }, [a4])
    await executar(`UPDATE colonia.animal SET situacao = 'vivo', dt_saida = NULL WHERE id = $1`, a4)
    await ocorrencia('anulacao', '2026-10-13', { origem: caixaA, destino: caixaA, anulada: baixaAnulada, motivo: 'lancada por engano' }, [a4])

    // a5: a baixa de verdade, na mesma data de um fato anterior para conferir a ordem
    await executar(`UPDATE colonia.animal SET situacao = 'morto', dt_saida = '2026-10-15'::date WHERE id = $1`, a5)
    await ocorrencia('baixa', '2026-10-15', { origem: caixaA, causa: 'eutanasia', motivo: 'eutanasia de selecao' }, [a5])
  })

  afterAll(() => teste?.desfazer())
  beforeEach(abrirCaso)
  afterEach(desfazerCaso)

  it('a caixa de origem: a entrada, a mudanca, a entrega so dos animais dela e a baixa de verdade', async () => {
    const trilha = await trilhaDaCaixa(caixaA)

    expect(trilha.map((p) => [p.dtFato, p.tipo, p.sentido, p.m, p.f])).toEqual([
      ['2026-10-01', 'entrada', 'chegada', 6, 0],
      ['2026-10-05', 'mudanca', 'saida', 2, 0],
      ['2026-10-10', 'entrega', 'saida', 1, 0],
      ['2026-10-15', 'baixa', 'saida', 1, 0],
    ])
    expect(trilha[0]?.origens).toEqual([
      { idParto: parto, ordem: null, casal: null, dtNascimento: '2026-09-01', m: 6, f: 0 },
    ])
    expect(trilha[1]?.outraCaixa).toMatchObject({ id: caixaB, codigo: codigoB, numeroVisivel: 'T9' })
    expect(trilha[2]).toMatchObject({ idPedido: pedido, outraCaixa: null })
    expect(trilha[3]).toMatchObject({ causa: 'eutanasia', motivo: 'eutanásia de seleção' })
  })

  it('a baixa anulada e a anulacao para a propria caixa nao entram na trilha', async () => {
    const trilha = await trilhaDaCaixa(caixaA)

    expect(trilha.some((p) => p.tipo === 'anulacao')).toBe(false)
    expect(trilha.filter((p) => p.tipo === 'baixa')).toHaveLength(1)
  })

  it('a caixa de destino: a mudanca que chegou e a entrega do animal que estava nela', async () => {
    const trilha = await trilhaDaCaixa(caixaB)

    expect(trilha.map((p) => [p.dtFato, p.tipo, p.sentido, p.m])).toEqual([
      ['2026-10-05', 'mudanca', 'chegada', 2],
      ['2026-10-10', 'entrega', 'saida', 1],
    ])
    expect(trilha[0]?.outraCaixa).toMatchObject({ id: caixaA })
  })
})
