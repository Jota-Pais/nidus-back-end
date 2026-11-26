import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { traduzirErroDoBanco } from '../../shared/erros-do-banco.ts'
import { abrirCaso, abrirTransacaoDoTeste, desfazerCaso } from '../../shared/testes/transacao.ts'
import { alterarFormato, cadastrarFormato, listarFormatos, removerFormato } from './formato.service.ts'
import { alterarEstante, listarEstantes, montarGrade } from './infra.service.ts'

// O formato da estante contra um banco de verdade, com os triggers da migration
// 20261126150000_estante_com_formato: trocar o formato da estante e mudar as medidas do formato
// reescrevem o codigo das caixas ativas (a traseira continua as letras da frontal) e deixam o da
// caixa liberada como ela saiu; o UPDATE direto que deixaria caixa ativa fora cai no trigger da
// caixa (TOPOLOGIA); e os servicos recusam antes, com os 409 do contrato, sem gravar nada.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado, pelo
// npm run test:banco. Sem a variavel, fica de fora. Nada fica gravado: o Prisma dos servicos e
// trocado pela transacao do teste (shared/testes/transacao.ts), desfeita no fim, e cada caso roda
// num SAVEPOINT. O mundo (especie, usuario, sala, dois formatos e duas estantes do primeiro) nasce
// dentro dela, com nomes proprios.

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

const SALA = 'Sala do teste dos formatos'
const OITO_POR_OITO = 'Formato do teste 8 x 8'
const OITO_POR_SETE = 'Formato do teste 8 x 7'

/** A causa do Postgres dentro do erro do Prisma: o codigo (23514 e check_violation) e a mensagem */
function causaDoBanco(erro: unknown) {
  return (erro as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } } } | undefined)
    ?.meta?.driverAdapterError?.cause
}

describe.skipIf(!URL_TESTE)('o formato da estante no banco de verdade', () => {
  let teste: Awaited<ReturnType<typeof abrirTransacaoDoTeste>>
  let especie: number
  let tecnico: number
  /** 2 faces, 8 x 8: a frontal de A a H, a traseira de I a P */
  let oitoPorOito: number
  /** 2 faces, 8 x 7: a frontal de A a G, a traseira de H a N */
  let oitoPorSete: number
  /** as duas estantes do formato 8 x 8, na mesma sala: FA e FB */
  let estanteA: number
  let estanteB: number

  const tx = () => teste.tx

  const id = async (sql: string, ...valores: unknown[]) =>
    Number((await tx().$queryRawUnsafe<{ id: number }[]>(sql, ...valores))[0]?.id)

  const executar = (sql: string, ...valores: unknown[]) => tx().$executeRawUnsafe(sql, ...valores)

  /** Uma caixa de casal ativa na posicao. O codigo, o trigger escreve */
  const caixa = (idEstante: number, face: number, linha: number, coluna: number) =>
    id(
      `INSERT INTO infra.caixa (id_estante, face, linha, coluna, id_especie) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      idEstante,
      face,
      linha,
      coluna,
      especie,
    )

  /** Libera a caixa como o servico libera: inativa, com a data e o motivo */
  const liberar = (idCaixa: number) =>
    executar(
      `UPDATE infra.caixa SET ativa = false, dt_liberacao = '2026-11-20'::date, motivo_liberacao = 'mudanca' WHERE id = $1`,
      idCaixa,
    )

  const codigo = async (idCaixa: number) =>
    (await tx().$queryRawUnsafe<{ codigo: string }[]>(`SELECT codigo FROM infra.caixa WHERE id = $1`, idCaixa))[0]?.codigo

  const formatoDaEstante = async (idEstante: number) =>
    (await tx().$queryRawUnsafe<{ id_formato: number }[]>(`SELECT id_formato FROM infra.estante WHERE id = $1`, idEstante))[0]
      ?.id_formato

  /**
   * Roda o comando direto no banco, esperando a recusa, num SAVEPOINT proprio: o caso continua
   * depois dela. Devolve o erro
   */
  async function recusaDireta(sql: string, ...valores: unknown[]): Promise<unknown> {
    await executar('SAVEPOINT direto')
    const erro = await executar(sql, ...valores).then(
      () => undefined,
      (recusado: unknown) => recusado,
    )
    await executar('ROLLBACK TO SAVEPOINT direto')

    return erro
  }

  beforeAll(async () => {
    teste = await abrirTransacaoDoTeste(URL_TESTE as string)

    especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Rato do teste dos formatos') RETURNING id`)
    tecnico = await id(
      `INSERT INTO login.usuario (nome, email, perfil) VALUES ('tecnico', 'tecnico@formato-no-banco.invalid', 'T') RETURNING id`,
    )
    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ($1) RETURNING id`, SALA)
    oitoPorOito = await id(`INSERT INTO infra.formato (nome, faces, linhas, colunas) VALUES ($1, 2, 8, 8) RETURNING id`, OITO_POR_OITO)
    oitoPorSete = await id(`INSERT INTO infra.formato (nome, faces, linhas, colunas) VALUES ($1, 2, 8, 7) RETURNING id`, OITO_POR_SETE)
    estanteA = await id(
      `INSERT INTO infra.estante (id_sala, id_formato, numero_visivel) VALUES ($1, $2, 'FA') RETURNING id`,
      sala,
      oitoPorOito,
    )
    estanteB = await id(
      `INSERT INTO infra.estante (id_sala, id_formato, numero_visivel) VALUES ($1, $2, 'FB') RETURNING id`,
      sala,
      oitoPorOito,
    )
  })

  afterAll(() => teste?.desfazer())
  beforeEach(abrirCaso)
  afterEach(desfazerCaso)

  it('trocar o formato da estante reescreve o codigo das caixas ativas e deixa o da liberada como saiu', async () => {
    const frontal = await caixa(estanteA, 1, 2, 3)
    // coluna 1 da traseira: a 9a letra com 8 colunas, a 8a com 7
    const traseira = await caixa(estanteA, 2, 1, 1)
    const liberada = await caixa(estanteA, 2, 2, 1)
    await liberar(liberada)

    expect([await codigo(frontal), await codigo(traseira), await codigo(liberada)]).toEqual(['F2C', 'T1I', 'T2I'])

    const alterada = await alterarEstante(estanteA, { idFormato: oitoPorSete }, tecnico)

    expect(alterada).toEqual({
      id: estanteA,
      idSala: expect.any(Number),
      sala: SALA,
      idFormato: oitoPorSete,
      formato: OITO_POR_SETE,
      numeroVisivel: 'FA',
      faces: 2,
      linhas: 8,
      colunas: 7,
    })
    expect(await codigo(frontal)).toBe('F2C')
    expect(await codigo(traseira)).toBe('T1H')
    expect(await codigo(liberada)).toBe('T2I')

    // a grade segue as medidas novas, com o codigo que o banco escreveu
    const grade = await montarGrade(estanteA)
    expect(grade.faces.map((face) => face.posicoes.length)).toEqual([56, 56])
    expect(grade.faces[1]?.posicoes.find((posicao) => posicao.caixa?.id === traseira)?.codigo).toBe('T1H')

    const [registro] = await tx().$queryRawUnsafe<{ dados: unknown }[]>(
      `SELECT dados FROM auditoria.historico WHERE entidade = 'estante' AND id_entidade = $1 ORDER BY id DESC LIMIT 1`,
      estanteA,
    )
    expect(registro?.dados).toMatchObject({
      antes: { idFormato: oitoPorOito, formato: OITO_POR_OITO },
      depois: { idFormato: oitoPorSete, formato: OITO_POR_SETE },
    })
  })

  it('mudar as medidas do formato reescreve as caixas ativas de todas as estantes dele, e a liberada fica como saiu', async () => {
    const naA = await caixa(estanteA, 2, 1, 1)
    const naB = await caixa(estanteB, 2, 3, 2)
    // a caixa liberada guarda o codigo da saida, mesmo fora das medidas novas: e historico
    const liberadaFora = await caixa(estanteB, 1, 4, 8)
    await liberar(liberadaFora)

    expect([await codigo(naA), await codigo(naB), await codigo(liberadaFora)]).toEqual(['T1I', 'T3J', 'F4H'])

    const alterado = await alterarFormato(oitoPorOito, { colunas: 7 }, tecnico)

    expect(alterado).toMatchObject({ id: oitoPorOito, nome: OITO_POR_OITO, faces: 2, linhas: 8, colunas: 7, capacidade: 112 })
    expect(alterado.estantes.map((estante) => estante.numeroVisivel)).toEqual(['FA', 'FB'])
    expect(await codigo(naA)).toBe('T1H')
    expect(await codigo(naB)).toBe('T3I')
    expect(await codigo(liberadaFora)).toBe('F4H')

    // as duas estantes do formato passam a ter as medidas novas
    const estantes = (await listarEstantes()).estantes.filter((estante) => estante.id === estanteA || estante.id === estanteB)
    expect(estantes.map((estante) => [estante.numeroVisivel, estante.colunas])).toEqual([
      ['FA', 7],
      ['FB', 7],
    ])
  })

  it('o UPDATE direto que deixaria caixa ativa fora cai no trigger da caixa, com TOPOLOGIA, e nada muda', async () => {
    // a coluna 8 nao existe com 7 colunas
    const naColunaOito = await caixa(estanteA, 1, 5, 8)

    const naTroca = await recusaDireta(`UPDATE infra.estante SET id_formato = $1 WHERE id = $2`, oitoPorSete, estanteA)
    expect(causaDoBanco(naTroca)?.originalCode).toBe('23514')
    expect(causaDoBanco(naTroca)?.originalMessage).toMatch(/^TOPOLOGIA: a posicao face 1 linha 5 coluna 8 nao existe na estante /)
    // e a API traduz para 409, se uma corrida passar da conferencia do servico
    expect(traduzirErroDoBanco(naTroca)).toMatchObject({ status: 409, codigo: 'TOPOLOGIA' })

    const nasMedidas = await recusaDireta(`UPDATE infra.formato SET colunas = 7 WHERE id = $1`, oitoPorOito)
    expect(causaDoBanco(nasMedidas)?.originalCode).toBe('23514')
    expect(causaDoBanco(nasMedidas)?.originalMessage).toMatch(/^TOPOLOGIA: /)

    expect(await formatoDaEstante(estanteA)).toBe(oitoPorOito)
    expect(await codigo(naColunaOito)).toBe('F5H')
  })

  it('os servicos recusam antes, com os 409 do contrato, e nada muda', async () => {
    const f1h = await caixa(estanteA, 1, 1, 8)
    const t2p = await caixa(estanteA, 2, 2, 8)
    await caixa(estanteB, 1, 3, 8)

    expect([await codigo(f1h), await codigo(t2p)]).toEqual(['F1H', 'T2P'])

    await expect(alterarEstante(estanteA, { idFormato: oitoPorSete }, tecnico)).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'CAIXAS_FORA_DO_FORMATO',
        message: `As caixas F1H e T2P ficam fora do formato ${OITO_POR_SETE}. Mude-as de lugar antes de trocar o formato.`,
      }),
    )
    await expect(alterarFormato(oitoPorOito, { colunas: 7 }, tecnico)).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'CAIXAS_FORA_DO_FORMATO',
        message: `Estas caixas ficam fora das medidas novas: FA (${SALA}): F1H e T2P; FB (${SALA}): F3H. Mude-as de lugar antes de mudar o formato.`,
      }),
    )
    await expect(removerFormato(oitoPorOito, tecnico)).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        codigo: 'FORMATO_EM_USO',
        message: `O formato ${OITO_POR_OITO} é usado pelas estantes FA (${SALA}) e FB (${SALA}). Troque o formato delas antes de remover.`,
      }),
    )
    const repetido = OITO_POR_SETE.toUpperCase()
    await expect(cadastrarFormato({ nome: repetido, faces: 1, linhas: 2, colunas: 3 }, tecnico)).rejects.toEqual(
      expect.objectContaining({ status: 409, codigo: 'FORMATO_DUPLICADO', message: `Já existe um formato com o nome ${repetido}.` }),
    )

    expect(await formatoDaEstante(estanteA)).toBe(oitoPorOito)
    expect(await codigo(f1h)).toBe('F1H')
    expect((await listarFormatos()).formatos.find((formato) => formato.id === oitoPorOito)).toMatchObject({ colunas: 8 })
  })

  it('o formato sai quando nenhuma estante ativa o usa, e o nome dele fica livre', async () => {
    await alterarEstante(estanteA, { idFormato: oitoPorSete }, tecnico)

    await expect(removerFormato(oitoPorOito, tecnico)).rejects.toThrow(
      `O formato ${OITO_POR_OITO} é usado pela estante FB (${SALA}). Troque o formato dela antes de remover.`,
    )

    await alterarEstante(estanteB, { idFormato: oitoPorSete }, tecnico)
    await removerFormato(oitoPorOito, tecnico)

    expect((await listarFormatos()).formatos.some((formato) => formato.id === oitoPorOito)).toBe(false)
    // o nome so e unico entre os ativos (formato_nome_unico)
    await expect(cadastrarFormato({ nome: OITO_POR_OITO, faces: 2, linhas: 8, colunas: 8 }, tecnico)).resolves.toMatchObject({
      nome: OITO_POR_OITO,
      estantes: [],
    })
  })
})
