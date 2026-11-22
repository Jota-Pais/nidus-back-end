import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { abrirCaso, abrirTransacaoDoTeste, desfazerCaso } from '../../shared/testes/transacao.ts'
import { hojeISO } from '../../shared/traducao.ts'
import { lerCards } from '../infra/card.ts'
import { montarFicha } from '../infra/ficha.service.ts'
import { registrarMudanca } from '../infra/mudanca.service.ts'
import { somarDias } from './cadeiaTemporal.ts'
import { casalFicha, formarCasal, registrarDesmame, registrarNascimento } from './reproducao.service.ts'
import { levarParaViuvas } from './viuva.service.ts'

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

const hoje = hojeISO()
const daqui = (dias: number) => somarDias(hoje, dias)

const NASCIMENTO_DO_CASAL = daqui(-70)
const DESMAME_DO_CASAL = daqui(-48)
const VIUVEZ = daqui(-40)

describe.skipIf(!URL_TESTE)('a caixa de viuvas no banco de verdade', () => {
  let teste: Awaited<ReturnType<typeof abrirTransacaoDoTeste>>
  let idEspecie: number
  let linhagemW: number
  let linhagemK: number
  let idEstante: number
  let tecnico: number
  let proxima = 0

  const tx = () => teste.tx

  const id = async (sql: string, ...valores: unknown[]) =>
    Number((await tx().$queryRawUnsafe<{ id: number }[]>(sql, ...valores))[0]?.id)

  const linhas = <T>(sql: string, ...valores: unknown[]) => tx().$queryRawUnsafe<T[]>(sql, ...valores)

  beforeAll(async () => {
    teste = await abrirTransacaoDoTeste(URL_TESTE as string)

    idEspecie = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Rato do teste das viuvas') RETURNING id`)
    linhagemW = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'W') RETURNING id`, idEspecie)
    linhagemK = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'K') RETURNING id`, idEspecie)
    tecnico = await id(`INSERT INTO login.usuario (nome, email, perfil) VALUES ('tecnico', 'tecnico@viuvas.invalid', 'T') RETURNING id`)
    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ('Sala do teste das viuvas') RETURNING id`)
    idEstante = await id(
      `INSERT INTO infra.estante (id_sala, fabricante, modelo, numero_visivel, faces, linhas, colunas, capacidade)
       VALUES ($1, 'Teste', 'Teste', 'VV1', 1, 6, 6, 36) RETURNING id`,
      sala,
    )
  })

  afterAll(() => teste?.desfazer())
  beforeEach(async () => {
    await abrirCaso()
    proxima = 0
  })
  afterEach(desfazerCaso)

  function posicao() {
    const n = proxima++
    return { idEstante, face: 'frontal' as const, linha: Math.floor(n / 6) + 1, coluna: (n % 6) + 1 }
  }

  async function recusaDoBanco(sql: string, ...valores: unknown[]): Promise<string> {
    await tx().$executeRawUnsafe('SAVEPOINT recusa')
    try {
      await tx().$executeRawUnsafe(sql, ...valores)
    } catch (erro) {
      await tx().$executeRawUnsafe('ROLLBACK TO SAVEPOINT recusa')
      return String((erro as Error).message)
    }
    throw new Error('o banco aceitou, e devia recusar')
  }

  async function recusaDoServico(acao: Promise<unknown>) {
    try {
      await acao
    } catch (erro) {
      return erro as { status: number; codigo: string; message: string; extras: { campos?: Record<string, string> } }
    }
    throw new Error('o servico aceitou, e devia recusar')
  }

  async function casalDesmamado(grupoMacho: string, grupoFemea: string, idLinhagem = linhagemW) {
    const formado = await formarCasal(
      { posicao: posicao(), idLinhagem, grupoMacho, grupoFemea, dtFormacao: daqui(-100), partoAtual: 5 },
      tecnico,
    )
    const [parto] = (await montarFicha(formado.idCaixa)).partos as { id: number }[]
    const idParto = parto?.id ?? 0

    await registrarNascimento(idParto, { dtPartoReal: NASCIMENTO_DO_CASAL, nascidoM: 3, nascidoF: 3 }, tecnico)
    await registrarDesmame(idParto, { dtDesmameReal: DESMAME_DO_CASAL, desmamadoM: 3, desmamadoF: 3 }, tecnico)

    const [{ codigo } = { codigo: '' }] = await linhas<{ codigo: string }>(`SELECT codigo FROM infra.caixa WHERE id = $1`, formado.idCaixa)
    return { idCaixa: formado.idCaixa, codigo, idCasal: formado.casal.id, idParto }
  }

  const irParaViuvas = (idCasal: number, destino: { idCaixa: number } | { posicao: ReturnType<typeof posicao> }, dtViuvez = VIUVEZ) =>
    levarParaViuvas(idCasal, { dtViuvez, ...destino }, tecnico)

  const quantasViuvas = async (idCaixa: number) =>
    (await linhas<{ n: number }>(`SELECT count(*)::int AS n FROM reproducao.viuva WHERE id_caixa = $1`, idCaixa))[0]?.n

  it('a ida para uma posicao vazia cria a caixa de viuvas, e a ficha mostra a data e a caixa de onde ela veio', async () => {
    const casal = await casalDesmamado('A', 'B')
    const ida = await irParaViuvas(casal.idCasal, { posicao: posicao() })

    const [criada] = await linhas<{ tipo: string; sexo: string | null; id_linhagem: number }>(
      `SELECT tipo, sexo, id_linhagem FROM infra.caixa WHERE id = $1`,
      ida.idCaixa,
    )
    expect(criada).toEqual({ tipo: 'viuvas', sexo: null, id_linhagem: linhagemW })

    expect(await montarFicha(ida.idCaixa)).toMatchObject({
      tipo: 'viuvas',
      vagas: 2,
      viuvas: [{ id: ida.idViuva, caixaDeOrigem: casal.codigo, dtViuvez: VIUVEZ }],
    })
    expect(await casalFicha(casal.idCasal)).toMatchObject({ viuva: { idCaixa: ida.idCaixa, dtViuvez: VIUVEZ }, podeVirarViuva: false })

    const [card] = await lerCards(tx(), { id: ida.idCaixa })
    expect(card).toMatchObject({ tipo: 'viuvas', fase: 'viuvas', viuvas: { viuvas: 1, vagas: 2 } })
  })

  it('a segunda vai para a mesma caixa, a femea vai uma vez so, e a quarta e recusada', async () => {
    const primeira = await irParaViuvas((await casalDesmamado('A', 'B')).idCasal, { posicao: posicao() })
    const segunda = await casalDesmamado('C', 'D')
    await irParaViuvas(segunda.idCasal, { idCaixa: primeira.idCaixa })

    expect((await recusaDoServico(irParaViuvas(segunda.idCasal, { posicao: posicao() }))).status).toBe(409)

    await irParaViuvas((await casalDesmamado('B', 'C')).idCasal, { idCaixa: primeira.idCaixa })
    expect(await quantasViuvas(primeira.idCaixa)).toBe(3)

    const quarta = await recusaDoServico(irParaViuvas((await casalDesmamado('E', 'A')).idCasal, { idCaixa: primeira.idCaixa }))
    expect(quarta).toMatchObject({ status: 409, codigo: 'CAIXA_DE_VIUVAS' })
    expect(await quantasViuvas(primeira.idCaixa)).toBe(3)
  })

  it('a viuvez nao vai antes do desmame da 5a ninhada', async () => {
    const casal = await casalDesmamado('A', 'B')

    expect((await recusaDoServico(irParaViuvas(casal.idCasal, { posicao: posicao() }, daqui(-49)))).status).toBe(400)
    expect(await linhas(`SELECT 1 FROM reproducao.viuva WHERE id_casal = $1`, casal.idCasal)).toHaveLength(0)
  })

  it('a caixa de viuvas de outra linhagem e recusada pelo servico e pelo trigger', async () => {
    const caixaW = await irParaViuvas((await casalDesmamado('A', 'B')).idCasal, { posicao: posicao() })
    const casalK = await casalDesmamado('C', 'D', linhagemK)

    const recusa = await recusaDoServico(irParaViuvas(casalK.idCasal, { idCaixa: caixaW.idCaixa }))
    expect(recusa.extras.campos?.idCaixa).toMatch(/outra linhagem/)

    const direto = await recusaDoBanco(
      `INSERT INTO reproducao.viuva (id_caixa, id_casal, id_linhagem, dt_viuvez) VALUES ($1, $2, $3, $4::date)`,
      caixaW.idCaixa,
      casalK.idCasal,
      linhagemK,
      VIUVEZ,
    )
    expect(direto).toMatch(/VIUVA_CAIXA: .*outra linhagem/)
  })

  it('a caixa de viuvas nao recebe animais, nem pela mudanca nem direto no banco', async () => {
    const viuvas = await irParaViuvas((await casalDesmamado('A', 'B')).idCasal, { posicao: posicao() })
    const outro = await casalDesmamado('C', 'D')

    const mudanca = await recusaDoServico(
      registrarMudanca(outro.idCaixa, { dtFato: daqui(-5), machos: { qtd: 1, destino: { idCaixa: viuvas.idCaixa } } }, tecnico),
    )
    expect(mudanca.status).toBeGreaterThanOrEqual(400)

    const direto = await recusaDoBanco(`UPDATE colonia.animal SET id_caixa = $1 WHERE id_parto = $2`, viuvas.idCaixa, outro.idParto)
    expect(direto).toMatch(/ANIMAL_CAIXA: .*nao recebe animais/)
  })
})
