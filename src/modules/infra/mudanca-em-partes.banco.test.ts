import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { abrirCaso, abrirTransacaoDoTeste, desfazerCaso } from '../../shared/testes/transacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { formarCasal, registrarDesmame, registrarNascimento } from '../reproducao/reproducao.service.ts'
import { montarFicha } from './ficha.service.ts'
import { registrarMudanca } from './mudanca.service.ts'

// A mudanca de animais em varias caixas (um sexo dividido em partes) contra um banco de verdade, com
// os triggers do animal e da caixa: a linhagem, o sexo e a posicao da caixa nova conferidos pelo
// banco, e o tudo ou nada da transacao (a parte recusada desfaz as de antes, a caixa nova inclusa).
// As regras de cada recusa ficam em mudanca.test.ts, contra a colonia de mentira.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado, pelo
// npm run test:banco. Sem a variavel, fica de fora. Nada fica gravado: o Prisma dos servicos e
// trocado pela transacao do teste (shared/testes/transacao.ts), desfeita no fim.

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

const hoje = hojeISO()
const daqui = (dias: number) => somarDias(hoje, dias)

/** O parto 1 de cada caso nasce 50 dias atras e desmama 28 dias atras */
const NASCIMENTO = daqui(-50)
const DESMAME = daqui(-28)

describe.skipIf(!URL_TESTE)('a mudanca em varias caixas no banco de verdade', () => {
  let teste: Awaited<ReturnType<typeof abrirTransacaoDoTeste>>
  let idLinhagem: number
  let idEstante: number
  let tecnico: number

  const tx = () => teste.tx

  const id = async (sql: string, ...valores: unknown[]) =>
    Number((await tx().$queryRawUnsafe<{ id: number }[]>(sql, ...valores))[0]?.id)

  beforeAll(async () => {
    teste = await abrirTransacaoDoTeste(URL_TESTE as string)

    const especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Rato do teste da mudanca em partes') RETURNING id`)
    idLinhagem = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'W') RETURNING id`, especie)
    tecnico = await id(
      `INSERT INTO login.usuario (nome, email, perfil) VALUES ('tecnico', 'tecnico@mudanca-em-partes.invalid', 'T') RETURNING id`,
    )
    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ('Sala do teste da mudanca em partes') RETURNING id`)
    const formato = await id(
      `INSERT INTO infra.formato (nome, faces, linhas, colunas) VALUES ('Formato do teste da mudanca em partes', 1, 3, 3) RETURNING id`,
    )
    idEstante = await id(
      `INSERT INTO infra.estante (id_sala, id_formato, numero_visivel) VALUES ($1, $2, 'MP1') RETURNING id`,
      sala,
      formato,
    )
  })

  afterAll(() => teste?.desfazer())
  beforeEach(abrirCaso)
  afterEach(desfazerCaso)

  // ------------------------------------------------------------------ ajudantes

  const posicao = (linha: number, coluna: number) => ({ idEstante, face: 'frontal' as const, linha, coluna })

  /** Os vivos de cada caixa da estante, por sexo, lidos direto da tabela */
  async function vivosPorCaixa(): Promise<Record<string, { m: number; f: number }>> {
    const linhas = await tx().$queryRawUnsafe<{ codigo: string; sexo: string; n: number }[]>(
      `SELECT c.codigo, a.sexo, count(*)::int AS n
         FROM colonia.animal a JOIN infra.caixa c ON c.id = a.id_caixa
        WHERE a.situacao = 'vivo' AND c.id_estante = $1
        GROUP BY c.codigo, a.sexo`,
      idEstante,
    )
    const porCaixa: Record<string, { m: number; f: number }> = {}

    for (const linha of linhas) {
      const caixa = (porCaixa[linha.codigo] ??= { m: 0, f: 0 })
      if (linha.sexo === 'M') caixa.m = linha.n
      else caixa.f = linha.n
    }

    return porCaixa
  }

  const caixa = async (idCaixa: number) =>
    (
      await tx().$queryRawUnsafe<{ codigo: string; tipo: string; sexo: string | null; id_linhagem: number | null; ativa: boolean }[]>(
        `SELECT codigo, tipo, sexo, id_linhagem, ativa FROM infra.caixa WHERE id = $1`,
        idCaixa,
      )
    )[0]

  const quantasCaixas = async () =>
    (await tx().$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM infra.caixa WHERE id_estante = $1`, idEstante))[0]?.n

  const quantasOcorrenciasDeMudanca = async () =>
    (
      await tx().$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM colonia.ocorrencia o JOIN infra.caixa c ON c.id = o.id_caixa_destino
          WHERE o.tipo = 'mudanca' AND c.id_estante = $1`,
        idEstante,
      )
    )[0]?.n

  /** O casal formado na posicao, com o parto 1 nascido e desmamado */
  async function casalComNinhada(
    onde: { linha: number; coluna: number },
    nascidos: { m: number; f: number },
    nascimento = NASCIMENTO,
    desmame = DESMAME,
  ) {
    const formado = await formarCasal(
      { posicao: posicao(onde.linha, onde.coluna), idLinhagem, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: daqui(-75) },
      tecnico,
    )
    const [parto] = (await montarFicha(formado.idCaixa)).partos as { id: number }[]
    const idParto = parto?.id ?? 0

    await registrarNascimento(idParto, { dtPartoReal: nascimento, nascidoM: nascidos.m, nascidoF: nascidos.f }, tecnico)
    await registrarDesmame(idParto, { dtDesmameReal: desmame, desmamadoM: nascidos.m, desmamadoF: nascidos.f }, tecnico)

    return { idCaixa: formado.idCaixa, idCasal: formado.casal.id, idParto }
  }

  // ------------------------------------------------------------------ casos

  it('os machos em tres caixas novas e as femeas em duas: cada caixa nasce de estoque com o sexo e a linhagem dos animais', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 6, f: 5 })

    const feita = await registrarMudanca(
      idCaixa,
      {
        dtFato: daqui(-25),
        machos: [
          { qtd: 3, destino: { posicao: posicao(1, 2) } },
          { qtd: 2, destino: { posicao: posicao(1, 3) } },
          { qtd: 1, destino: { posicao: posicao(2, 1) } },
        ],
        femeas: [
          { qtd: 4, destino: { posicao: posicao(2, 2) } },
          { qtd: 1, destino: { posicao: posicao(2, 3) } },
        ],
      },
      tecnico,
    )

    expect(feita.caixas.map((c) => [c.codigo, c.sexo, c.qtd])).toEqual([
      ['F1B', 'M', 3],
      ['F1C', 'M', 2],
      ['F2A', 'M', 1],
      ['F2B', 'F', 4],
      ['F2C', 'F', 1],
    ])
    expect(feita.liberada).toBe(false)
    expect(await vivosPorCaixa()).toEqual({
      F1B: { m: 3, f: 0 },
      F1C: { m: 2, f: 0 },
      F2A: { m: 1, f: 0 },
      F2B: { m: 0, f: 4 },
      F2C: { m: 0, f: 1 },
    })
    for (const c of feita.caixas) {
      expect(await caixa(c.idCaixa)).toMatchObject({ tipo: 'estoque', sexo: c.sexo, id_linhagem: idLinhagem, ativa: true })
    }
    // uma ocorrencia de mudanca por parte
    expect(await quantasOcorrenciasDeMudanca()).toBe(5)
  })

  it('uma posicao vazia e uma caixa de estoque que ja existe na mesma mudanca, e depois separar o estoque em duas', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 6, f: 0 })
    const primeira = await registrarMudanca(idCaixa, { dtFato: daqui(-25), machos: { qtd: 2, destino: { posicao: posicao(1, 2) } } }, tecnico)
    const existente = primeira.caixas[0]?.idCaixa ?? 0

    const feita = await registrarMudanca(
      idCaixa,
      {
        dtFato: daqui(-20),
        machos: [
          { qtd: 2, destino: { idCaixa: existente } },
          { qtd: 2, destino: { posicao: posicao(1, 3) } },
        ],
      },
      tecnico,
    )
    expect(feita.caixas.map((c) => [c.codigo, c.qtd])).toEqual([['F1B', 2], ['F1C', 2]])
    expect(await vivosPorCaixa()).toEqual({ F1B: { m: 4, f: 0 }, F1C: { m: 2, f: 0 } })

    // a caixa de estoque com 4 se divide em duas caixas novas e, esvaziada, e liberada
    const separacao = await registrarMudanca(
      existente,
      {
        dtFato: daqui(-15),
        machos: [
          { qtd: 3, destino: { posicao: posicao(2, 1) } },
          { qtd: 1, destino: { posicao: posicao(2, 2) } },
        ],
      },
      tecnico,
    )
    expect(separacao.liberada).toBe(true)
    expect(await caixa(existente)).toMatchObject({ ativa: false })
    expect(await vivosPorCaixa()).toEqual({ F2A: { m: 3, f: 0 }, F2B: { m: 1, f: 0 }, F1C: { m: 2, f: 0 } })
  })

  it('tudo ou nada: a segunda parte recusada desfaz a primeira, e a caixa nova dela nao fica', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 4, f: 3 })
    // uma caixa de estoque de femeas: nao recebe macho (o servico recusa na 2a parte)
    const { caixas } = await registrarMudanca(idCaixa, { dtFato: daqui(-25), femeas: { qtd: 1, destino: { posicao: posicao(1, 2) } } }, tecnico)
    const deFemeas = caixas[0]?.idCaixa ?? 0
    const antes = await vivosPorCaixa()
    const caixasAntes = await quantasCaixas()
    const mudancasAntes = await quantasOcorrenciasDeMudanca()

    await expect(
      registrarMudanca(
        idCaixa,
        {
          dtFato: daqui(-20),
          machos: [
            { qtd: 2, destino: { posicao: posicao(1, 3) } },
            { qtd: 2, destino: { idCaixa: deFemeas } },
          ],
        },
        tecnico,
      ),
    ).rejects.toEqual(expect.objectContaining({ status: 400, extras: { campos: { 'machos.1.destino': expect.stringContaining('outro sexo') } } }))

    expect(await vivosPorCaixa()).toEqual(antes)
    expect(await quantasCaixas()).toBe(caixasAntes)
    expect(await quantasOcorrenciasDeMudanca()).toBe(mudancasAntes)
  })

  it('tudo ou nada: o reservado que falta na segunda parte desfaz a primeira com a caixa que ela criou', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 4, f: 0 })
    const caixasAntes = await quantasCaixas()

    // nenhum macho esta reservado: a parte 2, so do pedido 999999, nao acha nenhum
    await expect(
      registrarMudanca(
        idCaixa,
        {
          dtFato: daqui(-20),
          machos: [
            { qtd: 2, destino: { posicao: posicao(1, 2) } },
            { qtd: 1, idPedido: 999999, soDoPedido: true, destino: { posicao: posicao(1, 3) } },
          ],
        },
        tecnico,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ status: 409, codigo: 'SEM_ANIMAIS', extras: { campos: { 'machos.1.qtd': expect.any(String) } } }),
    )

    expect(await vivosPorCaixa()).toEqual({ F1A: { m: 4, f: 0 } })
    expect(await quantasCaixas()).toBe(caixasAntes)
    expect(await quantasOcorrenciasDeMudanca()).toBe(0)
  })

  it('a soma que passa dos vivos e o destino repetido nao gravam nada nem criam caixa', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 4, f: 0 })

    await expect(
      registrarMudanca(
        idCaixa,
        {
          dtFato: daqui(-20),
          machos: [
            { qtd: 3, destino: { posicao: posicao(1, 2) } },
            { qtd: 2, destino: { posicao: posicao(1, 3) } },
          ],
        },
        tecnico,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ status: 409, codigo: 'SEM_ANIMAIS', extras: { campos: { 'machos.1.qtd': 'Passa do total: sobra 1 para esta caixa.' } } }),
    )

    await expect(
      registrarMudanca(
        idCaixa,
        {
          dtFato: daqui(-20),
          machos: [
            { qtd: 1, destino: { posicao: posicao(1, 2) } },
            { qtd: 1, destino: { posicao: posicao(1, 2) } },
          ],
        },
        tecnico,
      ),
    ).rejects.toEqual(expect.objectContaining({ status: 400, codigo: 'VALIDACAO' }))

    expect(await vivosPorCaixa()).toEqual({ F1A: { m: 4, f: 0 } })
    expect(await quantasCaixas()).toBe(1)
    expect(await quantasOcorrenciasDeMudanca()).toBe(0)
  })

  it('a posicao que ja tem caixa recusa a parte dela, e nada do que veio antes fica', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 4, f: 0 })

    await expect(
      registrarMudanca(
        idCaixa,
        {
          dtFato: daqui(-20),
          machos: [
            { qtd: 2, destino: { posicao: posicao(1, 2) } },
            { qtd: 2, destino: { posicao: posicao(1, 1) } },
          ],
        },
        tecnico,
      ),
    ).rejects.toEqual(expect.objectContaining({ status: 400, extras: { campos: { 'machos.1.destino': expect.any(String) } } }))

    expect(await vivosPorCaixa()).toEqual({ F1A: { m: 4, f: 0 } })
    expect(await quantasCaixas()).toBe(1)
  })

  it('duas idades de machos no estoque: uma parte de cada, e a parte sem a idade e recusada no campo dela', async () => {
    const nova = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 3, f: 0 })
    const velha = await casalComNinhada({ linha: 1, coluna: 2 }, { m: 2, f: 0 }, daqui(-60), daqui(-36))

    // as duas ninhadas juntas numa caixa de estoque, de idades diferentes
    const reuniao = await registrarMudanca(nova.idCaixa, { dtFato: daqui(-20), machos: { qtd: 3, destino: { posicao: posicao(2, 1) } } }, tecnico)
    const estoque = reuniao.caixas[0]?.idCaixa ?? 0
    await registrarMudanca(velha.idCaixa, { dtFato: daqui(-19), machos: { qtd: 2, destino: { idCaixa: estoque } } }, tecnico)
    expect((await vivosPorCaixa()).F2A).toEqual({ m: 5, f: 0 })

    await expect(
      registrarMudanca(
        estoque,
        {
          dtFato: daqui(-15),
          machos: [
            { qtd: 1, dtNascimento: daqui(-50), destino: { posicao: posicao(2, 2) } },
            { qtd: 1, destino: { posicao: posicao(2, 3) } },
          ],
        },
        tecnico,
      ),
    ).rejects.toEqual(expect.objectContaining({ status: 400, extras: { campos: { 'machos.1.dtNascimento': expect.any(String) } } }))
    expect((await vivosPorCaixa()).F2A).toEqual({ m: 5, f: 0 })

    // a soma e por idade: 4 da ninhada de 2 nao cabem, ainda que os 5 machos bastem
    await expect(
      registrarMudanca(
        estoque,
        {
          dtFato: daqui(-15),
          machos: [
            { qtd: 1, dtNascimento: daqui(-60), destino: { posicao: posicao(2, 2) } },
            { qtd: 2, dtNascimento: daqui(-60), destino: { posicao: posicao(2, 3) } },
          ],
        },
        tecnico,
      ),
    ).rejects.toEqual(expect.objectContaining({ codigo: 'SEM_ANIMAIS', extras: { campos: { 'machos.1.qtd': expect.any(String) } } }))

    const feita = await registrarMudanca(
      estoque,
      {
        dtFato: daqui(-15),
        machos: [
          { qtd: 3, dtNascimento: daqui(-50), destino: { posicao: posicao(2, 2) } },
          { qtd: 2, dtNascimento: daqui(-60), destino: { posicao: posicao(2, 3) } },
        ],
      },
      tecnico,
    )
    expect(feita.caixas.map((c) => c.qtd)).toEqual([3, 2])
    expect(feita.liberada).toBe(true)
  })
})
