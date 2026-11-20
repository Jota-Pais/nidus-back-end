import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { abrirCaso, abrirTransacaoDoTeste, desfazerCaso } from '../../shared/testes/transacao.ts'
import { listarLiberadas } from './liberadas.service.ts'

// A lista das caixas liberadas contra um banco de verdade: o where do Prisma (OR, AND, insensitive,
// datas), a ordem com nulls last, o corte do temMais e a contagem dos nascidos sem os anulados.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado, pelo
// npm run test:banco. A transacao do teste e desfeita no fim; o mundo nasce dentro dela

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

describe.skipIf(!URL_TESTE)('as caixas liberadas no banco de verdade', () => {
  let teste: Awaited<ReturnType<typeof abrirTransacaoDoTeste>>
  let especie: number
  let outraEspecie: number
  let linhagemA: number
  let linhagemB: number
  let linhagemDeFora: number
  /** as caixas do mundo, pelo nome */
  const caixas: Record<string, number> = {}

  const tx = () => teste.tx
  const id = async (sql: string, ...valores: unknown[]) =>
    Number((await tx().$queryRawUnsafe<{ id: number }[]>(sql, ...valores))[0]?.id)

  let estante = 0
  let proximaColuna = 1

  async function novaEstante(sala: number, numero: string) {
    return id(
      `INSERT INTO infra.estante (id_sala, fabricante, modelo, numero_visivel, faces, linhas, colunas, capacidade)
       VALUES ($1, 'Teste', 'Teste', $2, 1, 1, 9, 9) RETURNING id`,
      sala,
      numero,
    )
  }

  /** Uma caixa na proxima coluna da estante do teste */
  async function caixa(nome: string, campos: {
    especie?: number
    tipo?: 'casal' | 'estoque'
    sexo?: 'M' | 'F'
    linhagem?: number
    ativa?: boolean
    liberada?: string | null
    motivo?: string
    estante?: number
  }) {
    const ativa = campos.ativa ?? false
    const idCaixa = await id(
      `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie, tipo, sexo, id_linhagem, ativa, dt_liberacao, motivo_liberacao)
       VALUES ($1, 1, 1, $2, $3, $4, $5, $6, $7, $8::date, $9) RETURNING id`,
      campos.estante ?? estante,
      proximaColuna++,
      campos.especie ?? especie,
      campos.tipo ?? 'casal',
      campos.sexo ?? null,
      campos.linhagem ?? null,
      ativa,
      ativa ? null : (campos.liberada ?? null),
      ativa ? null : (campos.motivo ?? 'casal_encerrado'),
    )
    caixas[nome] = idCaixa

    return idCaixa
  }

  async function casal(idCaixa: number, idLinhagem: number, grupos: string, ativo = false) {
    return id(
      `INSERT INTO reproducao.casal (id_caixa, id_linhagem, grupo_macho, grupo_femea, identificacao, dt_formacao, dt_encerramento, motivo_encerramento, ativo)
       VALUES ($1, $2, $3, $4, $5, '2026-01-10', $6::date, $7, $8) RETURNING id`,
      idCaixa,
      idLinhagem,
      grupos[0],
      grupos[1],
      grupos,
      ativo ? null : '2026-03-01',
      ativo ? null : 'fim do ciclo',
      ativo,
    )
  }

  async function parto(idCasal: number, idLinhagem: number, ordem: number, nascimento: string | null) {
    return id(
      `INSERT INTO reproducao.parto (id_casal, id_linhagem, ordem, dt_acasalamento, dt_parto_real)
       VALUES ($1, $2, $3, '2026-01-10', $4::date) RETURNING id`,
      idCasal,
      idLinhagem,
      ordem,
      nascimento,
    )
  }

  async function animal(idParto: number, idCaixa: number, situacao: string) {
    // todo animal entra vivo; a saida vem depois, como no servico
    const idAnimal = await id(
      `INSERT INTO colonia.animal (id_parto, sexo, id_caixa) VALUES ($1, 'M', $2) RETURNING id`,
      idParto,
      idCaixa,
    )
    if (situacao !== 'vivo') {
      await tx().$executeRawUnsafe(
        `UPDATE colonia.animal SET situacao = $2::varchar, dt_saida = CASE WHEN $2::varchar = 'morto' THEN '2026-02-20'::date END WHERE id = $1`,
        idAnimal,
        situacao,
      )
    }
  }

  beforeAll(async () => {
    teste = await abrirTransacaoDoTeste(URL_TESTE as string)

    especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Rato do teste das liberadas') RETURNING id`)
    outraEspecie = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Camundongo do teste das liberadas') RETURNING id`)
    linhagemA = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'LA') RETURNING id`, especie)
    linhagemB = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'LB') RETURNING id`, especie)
    linhagemDeFora = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'LF') RETURNING id`, outraEspecie)
    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ('Sala do teste das liberadas') RETURNING id`)
    estante = await novaEstante(sala, 'Q7')
    const estanteDeFora = await novaEstante(sala, 'Q8')

    // Do mais recente para o mais antigo (data, depois id): ativa, empate pelo id, antiga
    // - 'ativa': na estante, nunca na lista
    await caixa('ativa', { ativa: true, linhagem: undefined })
    // - 'antiga': casal da linhagem A, dois partos nascidos (3 vivos/mortos + 1 anulado, 1 animal) e um sem nascer
    // nasce ativa para receber os animais, e e liberada depois, como no servico
    const antiga = await caixa('antiga', { ativa: true })
    const casalAntigo = await casal(antiga, linhagemA, 'AB')
    const p1 = await parto(casalAntigo, linhagemA, 1, '2026-01-20')
    const p2 = await parto(casalAntigo, linhagemA, 2, '2026-02-10')
    await parto(casalAntigo, linhagemA, 3, null)
    await animal(p1, antiga, 'morto')
    await animal(p1, antiga, 'morto')
    await animal(p1, antiga, 'anulado')
    await animal(p2, antiga, 'morto')
    await tx().$executeRawUnsafe(
      `UPDATE infra.caixa SET ativa = false, dt_liberacao = '2026-02-01'::date, motivo_liberacao = 'casal_encerrado' WHERE id = $1`,
      antiga,
    )
    // - 'empateB' e 'empateA': mesma data, a de id maior vem primeiro; B e estoque da linhagem B, A e casal da linhagem B
    await caixa('empateA', { liberada: '2026-04-01', motivo: 'casal_encerrado' }).then((c) => casal(c, linhagemB, 'CD'))
    await caixa('empateB', { tipo: 'estoque', sexo: 'F', linhagem: linhagemB, liberada: '2026-04-01', motivo: 'entrega' })
    // - outra especie
    await caixa('deFora', { especie: outraEspecie, liberada: '2026-05-01', motivo: 'baixa', estante: estanteDeFora })
    await casal(caixas.deFora as number, linhagemDeFora, 'AB')
  })

  afterAll(() => teste?.desfazer())
  beforeEach(abrirCaso)
  afterEach(desfazerCaso)

  const ids = async (filtro: Partial<Parameters<typeof listarLiberadas>[0]> = {}) =>
    (await listarLiberadas({ idEspecie: especie, limite: 50, ...filtro })).caixas.map((c) => c.id)

  const noMundo = (...nomes: string[]) => nomes.map((nome) => caixas[nome])

  it('so as caixas liberadas da especie, a mais recente primeiro, com empate pelo id', async () => {
    expect(await ids()).toEqual(noMundo('empateB', 'empateA', 'antiga'))
  })

  it('limite corta e diz que ha mais; o limite justo nao diz', async () => {
    const duas = await listarLiberadas({ idEspecie: especie, limite: 2 })

    expect(duas.caixas.map((c) => c.id)).toEqual(noMundo('empateB', 'empateA'))
    expect(duas.temMais).toBe(true)
    expect((await listarLiberadas({ idEspecie: especie, limite: 4 })).temMais).toBe(false)
  })

  it('a linhagem acha a caixa de estoque e a caixa pelo casal dela', async () => {
    expect(await ids({ idLinhagem: linhagemB })).toEqual(noMundo('empateB', 'empateA'))
    expect(await ids({ idLinhagem: linhagemA })).toEqual(noMundo('antiga'))
  })

  it('a busca acha pelo codigo, pela estante e pelo casal, sem diferenciar maiusculas', async () => {
    const codigoAntiga = (await listarLiberadas({ idEspecie: especie, limite: 50 })).caixas.find((c) => c.id === caixas.antiga)?.codigo as string

    expect(await ids({ busca: codigoAntiga.toLowerCase() })).toContain(caixas.antiga)
    expect(await ids({ busca: 'q7' })).toEqual(noMundo('empateB', 'empateA', 'antiga'))
    expect(await ids({ busca: 'q8' })).toEqual([])
    expect(await ids({ busca: 'cd' })).toEqual(noMundo('empateA'))
    expect(await ids({ busca: 'Ab' })).toEqual(noMundo('antiga'))
  })

  it('o periodo vale pela data de liberacao ', async () => {
    expect(await ids({ de: '2026-03-01' })).toEqual(noMundo('empateB', 'empateA'))
    expect(await ids({ ate: '2026-03-01' })).toEqual(noMundo('antiga'))
    expect(await ids({ de: '2026-02-01', ate: '2026-04-01' })).toEqual(noMundo('empateB', 'empateA', 'antiga'))
  })

  it('filtros juntos valem todos (AND)', async () => {
    expect(await ids({ idLinhagem: linhagemB, busca: 'cd', de: '2026-04-01' })).toEqual(noMundo('empateA'))
    expect(await ids({ idLinhagem: linhagemA, busca: 'cd' })).toEqual([])
  })

  it('os casais trazem so os partos nascidos e os nascidos sem o anulado', async () => {
    const linha = (await listarLiberadas({ idEspecie: especie, limite: 50 })).caixas.find((c) => c.id === caixas.antiga)

    expect(linha?.casais).toHaveLength(1)
    expect(linha?.casais[0]).toMatchObject({
      identificacao: 'AB',
      partos: 2,
      ultimoParto: 2,
      nascidos: 3,
      dtFormacao: '2026-01-10',
      dtEncerramento: '2026-03-01',
    })
    expect(linha).toMatchObject({ dtLiberacao: '2026-02-01', motivoLiberacao: 'casal_encerrado', tipo: 'casal', linhagem: 'LA' })
  })

  it('a de estoque traz sexo e linhagem da caixa e nenhum casal', async () => {
    const linha = (await listarLiberadas({ idEspecie: especie, limite: 50 })).caixas.find((c) => c.id === caixas.empateB)

    expect(linha).toMatchObject({ tipo: 'estoque', sexo: 'F', linhagem: 'LB', idLinhagem: linhagemB, casais: [] })
  })
})
