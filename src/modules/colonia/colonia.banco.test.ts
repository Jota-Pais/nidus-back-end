import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { abrirCaso, abrirTransacaoDoTeste, desfazerCaso } from '../../shared/testes/transacao.ts'
import { dataLegivel, hojeISO } from '../../shared/traducao.ts'
import { montarQuadro } from '../infra/caixa.service.ts'
import { montarFicha } from '../infra/ficha.service.ts'
import { montarGrade } from '../infra/infra.service.ts'
import { registrarMudanca, virarCaixaDeEstoque } from '../infra/mudanca.service.ts'
import { consultarEstoque } from '../motor/estoque.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { corrigirAcasalamento, corrigirNascimento } from '../reproducao/correcao.service.ts'
import {
  encerrarCasal,
  fecharSemNinhada,
  formarCasal,
  registrarAcasalamento,
  registrarDesmame,
  registrarNascimento,
  registrarSelecao,
} from '../reproducao/reproducao.service.ts'
import { anularBaixa, registrarBaixa } from './baixa.service.ts'

// Os servicos da colonia contra um banco de verdade, com os triggers e os CHECKs da migration
// 20261108200000_colonia_por_animal: formar casal, nascer, selecionar, desmamar, mudar de caixa,
// dar baixa, anular, encerrar, fechar sem ninhada, virar estoque e corrigir, e o quadro, a grade,
// a ficha e o estoque lendo os mesmos animais. As regras, caso a caso, ficam nos testes de cada
// modulo, contra a colonia de mentira; aqui so o caminho inteiro de cada uma, com o SQL das travas
// e da escolha e o trigger do animal conferindo cada escrita.
//
// Teste de INTEGRACAO: so roda com DATABASE_URL_TESTE apontando para um banco ja migrado (um branch
// de teste da Neon ou um Postgres local), pelo npm run test:banco. Sem a variavel, fica de fora.
//
// Nada fica gravado: o Prisma dos servicos e trocado pela transacao do teste (shared/testes/transacao.ts),
// desfeita no fim, e cada caso roda num SAVEPOINT. O mundo (especie, linhagem, estante e usuario)
// nasce dentro dela, com nomes proprios; cada caso forma o proprio casal pelos servicos.

const URL_TESTE = process.env.DATABASE_URL_TESTE

vi.mock('../../shared/prisma.ts', async () => ({
  prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
}))

const hoje = hojeISO()
const daqui = (dias: number) => somarDias(hoje, dias)

/** O parto 1 de cada caso nasce 50 dias atras e desmama 28 dias atras */
const NASCIMENTO = daqui(-50)
const DESMAME = daqui(-28)

const ESPECIE = 'rato-do-teste-da-colonia'

describe.skipIf(!URL_TESTE)('a colonia no banco de verdade', () => {
  let teste: Awaited<ReturnType<typeof abrirTransacaoDoTeste>>
  let idLinhagem: number
  let idEstante: number
  let tecnico: number

  const tx = () => teste.tx

  const id = async (sql: string, ...valores: unknown[]) =>
    Number((await tx().$queryRawUnsafe<{ id: number }[]>(sql, ...valores))[0]?.id)

  beforeAll(async () => {
    teste = await abrirTransacaoDoTeste(URL_TESTE as string)

    const especie = await id(`INSERT INTO catalogo.especie (nome) VALUES ('Rato do teste da colonia') RETURNING id`)
    idLinhagem = await id(`INSERT INTO catalogo.linhagem (id_especie, nome) VALUES ($1, 'W') RETURNING id`, especie)
    await tx().$executeRawUnsafe(
      `INSERT INTO catalogo.grupo_genetico_par (grupo_macho, grupo_femea) VALUES ('A', 'B') ON CONFLICT DO NOTHING`,
    )
    tecnico = await id(
      `INSERT INTO login.usuario (nome, email, perfil) VALUES ('tecnico', 'tecnico@colonia-no-banco.invalid', 'T') RETURNING id`,
    )
    const sala = await id(`INSERT INTO infra.sala (nome) VALUES ('Sala do teste da colonia') RETURNING id`)
    idEstante = await id(
      `INSERT INTO infra.estante (id_sala, fabricante, modelo, numero_visivel, faces, linhas, colunas, capacidade)
       VALUES ($1, 'Teste', 'Teste', 'C1', 1, 3, 3, 9) RETURNING id`,
      sala,
    )
  })

  afterAll(() => teste?.desfazer())
  beforeEach(abrirCaso)
  afterEach(desfazerCaso)

  // ------------------------------------------------------------------ ajudantes

  const posicao = (linha: number, coluna: number) => ({ idEstante, face: 'frontal' as const, linha, coluna })

  /** Os vivos de cada caixa, por sexo, lidos direto da tabela */
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
      await tx().$queryRawUnsafe<{ codigo: string; tipo: string; ativa: boolean; motivo: string | null; dt: string | null }[]>(
        `SELECT codigo, tipo, ativa, motivo_liberacao AS motivo, to_char(dt_liberacao, 'YYYY-MM-DD') AS dt FROM infra.caixa WHERE id = $1`,
        idCaixa,
      )
    )[0]

  /** O casal formado na posicao, com o parto 1 nascido (e desmamado, se pedir) */
  async function casalComNinhada(
    onde: { linha: number; coluna: number },
    nascidos: { m: number; f: number },
    desmamar = true,
  ) {
    const formado = await formarCasal(
      { posicao: posicao(onde.linha, onde.coluna), idLinhagem, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: daqui(-75) },
      tecnico,
    )
    const [parto] = (await montarFicha(formado.idCaixa)).partos as { id: number }[]
    const idParto = parto?.id ?? 0

    await registrarNascimento(idParto, { dtPartoReal: NASCIMENTO, nascidoM: nascidos.m, nascidoF: nascidos.f }, tecnico)
    if (desmamar) {
      await registrarDesmame(idParto, { dtDesmameReal: DESMAME, desmamadoM: nascidos.m, desmamadoF: nascidos.f }, tecnico)
    }

    return { idCaixa: formado.idCaixa, idCasal: formado.casal.id, idParto }
  }

  // ------------------------------------------------------------------ casos

  it('o ciclo do casal: a caixa nasce na posicao, o nascimento cria os animais, a selecao se repete e o desmame da baixa na diferenca', async () => {
    const formado = await formarCasal(
      { posicao: posicao(1, 1), idLinhagem, grupoMacho: 'A', grupoFemea: 'B', dtFormacao: daqui(-75) },
      tecnico,
    )
    expect(await caixa(formado.idCaixa)).toMatchObject({ codigo: 'F1A', tipo: 'casal', ativa: true })

    const [parto] = (await montarFicha(formado.idCaixa)).partos as { id: number }[]
    const idParto = parto?.id ?? 0

    await registrarNascimento(idParto, { dtPartoReal: NASCIMENTO, nascidoM: 5, nascidoF: 5 }, tecnico)
    await registrarSelecao(idParto, { dtSelecao: daqui(-49), eutanasiadoM: 1, eutanasiadoF: 0 }, tecnico)
    await registrarSelecao(idParto, { dtSelecao: daqui(-48), eutanasiadoM: 0, eutanasiadoF: 1 }, tecnico)
    const { parto: desmamado } = await registrarDesmame(idParto, { dtDesmameReal: DESMAME, desmamadoM: 3, desmamadoF: 4 }, tecnico)

    expect(desmamado).toMatchObject({
      nascidoM: 5,
      nascidoF: 5,
      baixasAntesDoDesmame: { m: 2, f: 1 },
      desmamadoM: 3,
      desmamadoF: 4,
      vivos: { m: 3, f: 4 },
    })
    expect(await vivosPorCaixa()).toEqual({ F1A: { m: 3, f: 4 } })

    const trilha = await tx().$queryRawUnsafe<{ tipo: string; motivo: string | null; n: number }[]>(
      `SELECT o.tipo, o.motivo, count(oa.id_animal)::int AS n
         FROM colonia.ocorrencia o JOIN colonia.ocorrencia_animal oa ON oa.id_ocorrencia = o.id
        WHERE o.id_parto = $1 GROUP BY o.id, o.tipo, o.motivo ORDER BY o.id`,
      idParto,
    )
    expect(trilha.map((o) => [o.tipo, o.n])).toEqual([
      ['nascimento', 10],
      ['baixa', 1],
      ['baixa', 1],
      ['baixa', 1],
    ])
  })

  it('o parto seguinte nao nasce com a ninhada anterior viva na caixa do casal', async () => {
    const { idCasal } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 2, f: 2 })
    const parto2 = await registrarAcasalamento(idCasal, { dtAcasalamento: daqui(-30) }, tecnico)

    await expect(registrarNascimento(parto2.id, { dtPartoReal: daqui(-7), nascidoM: 3, nascidoF: 3 }, tecnico)).rejects.toEqual(
      expect.objectContaining({ codigo: 'CAIXA_COM_ANIMAIS' }),
    )
    expect(await vivosPorCaixa()).toEqual({ F1A: { m: 2, f: 2 } })
  })

  it('a mudanca passa para caixa nova e para a existente, separa estoque e libera a origem de estoque vazia', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 4, f: 4 })

    const passagem = await registrarMudanca(
      idCaixa,
      { dtFato: daqui(-25), machos: { qtd: 2, destino: { posicao: posicao(1, 2) } }, femeas: { qtd: 2, destino: { posicao: posicao(1, 3) } } },
      tecnico,
    )
    expect(passagem.caixas.map((c) => [c.codigo, c.sexo, c.qtd])).toEqual([['F1B', 'M', 2], ['F1C', 'F', 2]])
    expect(passagem.liberada).toBe(false)
    const [machos, femeas] = passagem.caixas.map((c) => c.idCaixa)

    await registrarMudanca(
      idCaixa,
      { dtFato: daqui(-20), machos: { qtd: 2, destino: { idCaixa: machos ?? 0 } }, femeas: { qtd: 2, destino: { idCaixa: femeas ?? 0 } } },
      tecnico,
    )
    // a caixa de estoque so recebe o sexo dela, e o banco confere a chegada
    await expect(
      registrarMudanca(femeas ?? 0, { dtFato: daqui(-15), femeas: { qtd: 1, destino: { idCaixa: machos ?? 0 } } }, tecnico),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }))

    const separacao = await registrarMudanca(
      femeas ?? 0,
      { dtFato: daqui(-15), femeas: { qtd: 4, destino: { posicao: posicao(2, 1) } } },
      tecnico,
    )
    expect(separacao.liberada).toBe(true)
    expect(await caixa(femeas ?? 0)).toMatchObject({ ativa: false, motivo: 'mudanca', dt: daqui(-15) })
    expect(await vivosPorCaixa()).toEqual({ F1B: { m: 4, f: 0 }, F2A: { m: 0, f: 4 } })

    const chegadas = await tx().$queryRawUnsafe<{ dt: string }[]>(
      `SELECT DISTINCT to_char(dt_movimento, 'YYYY-MM-DD') AS dt FROM colonia.animal a JOIN infra.caixa c ON c.id = a.id_caixa WHERE c.codigo = 'F2A' AND c.id_estante = $1`,
      idEstante,
    )
    expect(chegadas).toEqual([{ dt: daqui(-15) }])
  })

  it('a mudanca de mais animais do que a caixa tem nao grava nada', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 2, f: 0 })

    await expect(
      registrarMudanca(idCaixa, { dtFato: daqui(-20), machos: { qtd: 3, destino: { posicao: posicao(1, 2) } } }, tecnico),
    ).rejects.toEqual(expect.objectContaining({ codigo: 'SEM_ANIMAIS' }))

    expect(await vivosPorCaixa()).toEqual({ F1A: { m: 2, f: 0 } })
    const caixas = await tx().$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM infra.caixa WHERE id_estante = $1`, idEstante)
    expect(caixas).toEqual([{ n: 1 }])
  })

  it('a baixa que esvazia o estoque libera a caixa, e a anulacao traz os animais de volta noutra caixa', async () => {
    const { idCaixa } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 0, f: 3 })
    const { caixas } = await registrarMudanca(
      idCaixa,
      { dtFato: daqui(-20), femeas: { qtd: 3, destino: { posicao: posicao(1, 2) } } },
      tecnico,
    )
    const estoque = caixas[0]?.idCaixa ?? 0
    const { caixas: [outra] } = await registrarMudanca(
      estoque,
      { dtFato: daqui(-15), femeas: { qtd: 1, destino: { posicao: posicao(1, 3) } } },
      tecnico,
    )

    const baixa = await registrarBaixa(estoque, { dtFato: daqui(-10), motivo: 'morte', itens: [{ sexo: 'F', qtd: 2 }] }, tecnico)
    expect(baixa).toEqual({ baixas: { m: 0, f: 2 }, liberada: true, faltas: [] })
    expect(await caixa(estoque)).toMatchObject({ ativa: false, motivo: 'baixa', dt: daqui(-10) })

    const [ocorrencia] = await tx().$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM colonia.ocorrencia WHERE tipo = 'baixa' AND id_caixa_origem = $1`,
      estoque,
    )
    // a caixa de origem foi liberada: a volta pede outra
    await expect(anularBaixa(ocorrencia?.id ?? 0, { motivo: 'engano' }, tecnico)).rejects.toEqual(
      expect.objectContaining({ status: 400 }),
    )

    const volta = await anularBaixa(ocorrencia?.id ?? 0, { motivo: 'engano', idCaixa: outra?.idCaixa ?? 0 }, tecnico)
    expect(volta).toMatchObject({ idCaixa: outra?.idCaixa, voltaram: { m: 0, f: 2 } })
    expect(await vivosPorCaixa()).toEqual({ F1C: { m: 0, f: 3 } })
    // a mesma baixa nao se anula duas vezes
    await expect(anularBaixa(ocorrencia?.id ?? 0, { motivo: 'de novo', idCaixa: outra?.idCaixa ?? 0 }, tecnico)).rejects.toEqual(
      expect.objectContaining({ status: 409 }),
    )
  })

  it('o casal encerrado com parto pendente segura a caixa; o parto sem ninhada a libera', async () => {
    const { idCaixa, idCasal } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 1, f: 1 })
    const parto2 = await registrarAcasalamento(idCasal, { dtAcasalamento: daqui(-30) }, tecnico)
    await registrarMudanca(
      idCaixa,
      { dtFato: daqui(-20), machos: { qtd: 1, destino: { posicao: posicao(1, 2) } }, femeas: { qtd: 1, destino: { posicao: posicao(1, 3) } } },
      tecnico,
    )

    await encerrarCasal(idCasal, { dtEncerramento: daqui(-5), motivo: 'fim' }, tecnico)
    expect(await caixa(idCaixa)).toMatchObject({ ativa: true })

    await fecharSemNinhada(parto2.id, { dtSemNinhada: daqui(-1), motivo: 'nao emprenhou' }, tecnico)
    expect(await caixa(idCaixa)).toMatchObject({ ativa: false, motivo: 'casal_encerrado', dt: daqui(-1) })
  })

  it('a caixa do casal encerrado vira estoque com os vivos dentro, e a ficha guarda o casal', async () => {
    const { idCaixa, idCasal, idParto } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 3, f: 2 }, false)
    await registrarSelecao(idParto, { dtSelecao: daqui(-48), eutanasiadoM: 0, eutanasiadoF: 2 }, tecnico)
    await registrarDesmame(idParto, { dtDesmameReal: DESMAME, desmamadoM: 3, desmamadoF: 0 }, tecnico)

    await expect(virarCaixaDeEstoque(idCaixa, tecnico)).rejects.toEqual(expect.objectContaining({ status: 409 }))
    await encerrarCasal(idCasal, { dtEncerramento: daqui(-20), motivo: 'virou estoque' }, tecnico)
    expect(await virarCaixaDeEstoque(idCaixa, tecnico)).toEqual({ idCaixa, sexo: 'M' })

    expect(await caixa(idCaixa)).toMatchObject({ tipo: 'estoque', ativa: true })
    const ficha = await montarFicha(idCaixa)
    expect(ficha).toMatchObject({ tipo: 'estoque', total: 3, reservado: 0, livre: 3 })
    expect(ficha.tipo === 'estoque' ? ficha.casaisAnteriores.map((anterior) => anterior.casal.identificacao) : null).toEqual(['AB'])
  })

  it('a correcao do nascimento poe o animal a mais na caixa do casal e diz o que mudou', async () => {
    const { idCaixa, idParto } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 2, f: 2 }, false)

    const { parto } = await corrigirNascimento(
      idParto,
      { dtPartoReal: daqui(-51), nascidoM: 3, nascidoF: 2, motivo: 'contagem errada' },
      tecnico,
    )
    expect(parto).toMatchObject({ dtPartoReal: daqui(-51), nascidoM: 3, nascidoF: 2, vivos: { m: 3, f: 2 } })
    expect(await vivosPorCaixa()).toEqual({ F1A: { m: 3, f: 2 } })

    const ficha = await montarFicha(idCaixa)
    expect(ficha.eventos.find((e) => e.tipo === 'correcao')?.descricao).toBe(
      `Correcao do 1o parto (nascimento de ${dataLegivel(NASCIMENTO)} para ${dataLegivel(daqui(-51))}; contagem de 2 M e 2 F para 3 M e 2 F): contagem errada`,
    )
  })

  it('a correcao do acasalamento muda a data e a ficha diz de quanto para quanto', async () => {
    const { idCaixa, idCasal } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 1, f: 0 })
    const parto2 = await registrarAcasalamento(idCasal, { dtAcasalamento: daqui(-30) }, tecnico)

    expect(await corrigirAcasalamento(parto2.id, { dtAcasalamento: daqui(-32), motivo: 'digitado errado' }, tecnico)).toMatchObject({
      dtAcasalamento: daqui(-32),
    })
    const ficha = await montarFicha(idCaixa)
    expect(ficha.eventos.find((e) => e.tipo === 'correcao')?.descricao).toBe(
      `Correcao do acasalamento do 2o parto (de ${dataLegivel(daqui(-30))} para ${dataLegivel(daqui(-32))}): digitado errado`,
    )
  })

  it('quadro, grade, ficha e estoque contam os mesmos animais', async () => {
    const { idCaixa, idParto } = await casalComNinhada({ linha: 1, coluna: 1 }, { m: 3, f: 3 })
    const { caixas } = await registrarMudanca(
      idCaixa,
      { dtFato: daqui(-20), machos: { qtd: 2, destino: { posicao: posicao(1, 2) } } },
      tecnico,
    )
    const estoque = caixas[0]?.idCaixa ?? 0
    await registrarBaixa(estoque, { dtFato: daqui(-10), itens: [{ sexo: 'M', qtd: 1 }] }, tecnico)

    const quadro = await montarQuadro(ESPECIE)
    const coluna = (id: number) => quadro.colunas.find((c) => c.cards.some((card) => card.idCaixa === id))
    expect(coluna(idCaixa)?.estado).toBe('livres')
    expect(coluna(estoque)?.estado).toBe('estoque')
    const cardDoEstoque = coluna(estoque)?.cards.find((card) => card.idCaixa === estoque)
    expect(cardDoEstoque?.estoque).toMatchObject({ sexo: 'M', total: 1, reservado: 0 })

    const grade = await montarGrade(idEstante)
    const naGrade = grade.faces.flatMap((face) => face.posicoes).filter((p) => p.caixa !== null)
    expect(naGrade.map((p) => [p.codigo, p.caixa?.estado])).toEqual([
      ['F1A', 'livres'],
      ['F1B', 'estoque'],
    ])

    const ficha = await montarFicha(idCaixa)
    const parto = ficha.partos?.find((p) => p.id === idParto)
    expect(parto).toMatchObject({ vivos: { m: 2, f: 3 }, baixasAntesDoDesmame: { m: 0, f: 0 }, entregues: { m: 0, f: 0 } })
    expect(parto?.onde.map((o) => [o.codigo, o.m, o.f])).toEqual([
      ['F1A', 1, 3],
      ['F1B', 1, 0],
    ])

    const { linhagens } = await consultarEstoque(ESPECIE)
    expect(linhagens.find((l) => l.idLinhagem === idLinhagem)).toMatchObject({
      confirmado: { m: 2, f: 3 },
      previsto: { m: 0, f: 0 },
    })
  })
})
