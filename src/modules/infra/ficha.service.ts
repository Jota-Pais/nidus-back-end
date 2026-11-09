// A ficha da caixa: dados da caixa, o casal, os partos (1 a 5) e o historico

import { cicloFicha } from '../reproducao/cicloFicha.ts'
import { casalFicha } from '../reproducao/reproducao.service.ts'
import { naoEncontrado } from '../../shared/erros.ts'
import { codigoDaPosicao } from './endereco.ts'
import { animaisNaCaixaDoCasal, fichaDoEstoque, sexoParaVirarEstoque } from './estoque.service.ts'
import { prisma } from '../../shared/prisma.ts'
import { NOME_DO_SISTEMA } from '../historico/historico.service.ts'
import { codigoDaEspecie, estadoCaixa } from '../../shared/traducao.ts'

async function partosDoCasal(idCasal: number, soNascidos = false) {
  const partos = await prisma.parto.findMany({
    where: { idCasal, ...(soNascidos ? { dtPartoReal: { not: null } } : {}) },
    orderBy: { ordem: 'asc' },
    select: { id: true },
  })

  // No maximo 5 partos por casal: N+1 aqui e uma ficha aberta por vez, nao uma lista
  return Promise.all(partos.map((parto) => cicloFicha(parto.id)))
}

/**
 * Os casais que vieram antes do atual e deixaram ninhada na caixa, com os partos que nasceram.
 * Casal novo nao esconde essas ninhadas: o estoque e a busca contam, e e na ficha que a equipe
 * registra a selecao e o desmame delas
 */
async function casaisAnteriores(idCasais: number[]) {
  const anteriores = await Promise.all(
    idCasais.map(async (idCasal) => {
      const [casal, partos] = await Promise.all([casalFicha(idCasal), partosDoCasal(idCasal, true)])
      return { casal, partos }
    }),
  )

  return anteriores.filter((anterior) => anterior.partos.length > 0)
}

interface EventoDaFicha {
  dataHora: string
  tipo: string
  descricao: string
  autor: string
}

const ORDEM_NO_DIA: Record<string, number> = {
  acasalamento: 0,
  parto: 1,
  selecao: 2,
  desmame: 3,
  encerramento: 4,
}

async function eventosDoCasal(idCasal: number): Promise<EventoDaFicha[]> {
  const [casal, partos] = await Promise.all([
    prisma.casal.findUnique({
      where: { id: idCasal },
      select: { dtEncerramento: true, motivoEncerramento: true },
    }),
    prisma.parto.findMany({
      where: { idCasal },
      orderBy: { ordem: 'asc' },
      select: {
        id: true,
        ordem: true,
        dtAcasalamento: true,
        dtPartoReal: true,
        nascidoM: true,
        nascidoF: true,
        usuarioParto: { select: { nome: true } },
        dtSelecao: true,
        eutanasiadoM: true,
        eutanasiadoF: true,
        usuarioSelecao: { select: { nome: true } },
        dtDesmameReal: true,
        desmamadoM: true,
        desmamadoF: true,
        usuarioDesmame: { select: { nome: true } },
      },
    }),
  ])

  const registros = await prisma.historico.findMany({
    where: {
      OR: [
        { entidade: 'parto', acao: 'acasalamento', idEntidade: { in: partos.map((parto) => parto.id) } },
        { entidade: 'casal', acao: { in: ['formacao', 'encerramento'] }, idEntidade: idCasal },
      ],
    },
    orderBy: { dtHora: 'desc' },
    select: { entidade: true, acao: true, idEntidade: true, usuario: { select: { nome: true } } },
  })
  const autorDe = (entidade: string, acao: string, idEntidade: number) => {
    const registro = registros.find(
      (r) => r.entidade === entidade && r.acao === acao && r.idEntidade === idEntidade,
    )
    if (registro === undefined) return 'Desconhecido'
    return registro.usuario?.nome ?? NOME_DO_SISTEMA
  }

  const eventos: EventoDaFicha[] = []
  const evento = (data: Date, tipo: string, descricao: string, autor: string) =>
    eventos.push({ dataHora: data.toISOString(), tipo, descricao, autor })

  for (const parto of partos) {
    const acao = parto.ordem === 1 ? 'formacao' : 'acasalamento'
    const idAutor = parto.ordem === 1 ? idCasal : parto.id
    evento(
      parto.dtAcasalamento,
      'acasalamento',
      `Acasalamento do ${parto.ordem}o parto.`,
      autorDe(parto.ordem === 1 ? 'casal' : 'parto', acao, idAutor),
    )

    if (parto.dtPartoReal !== null) {
      evento(
        parto.dtPartoReal,
        'parto',
        `${parto.ordem}o parto: ${parto.nascidoM} M, ${parto.nascidoF} F nascidos.`,
        parto.usuarioParto?.nome ?? 'Desconhecido',
      )
    }

    if (parto.dtSelecao !== null) {
      evento(
        parto.dtSelecao,
        'selecao',
        `Eutanasia do ${parto.ordem}o parto: ${parto.eutanasiadoM} M, ${parto.eutanasiadoF} F.`,
        parto.usuarioSelecao?.nome ?? 'Desconhecido',
      )
    }

    if (parto.dtDesmameReal !== null) {
      evento(
        parto.dtDesmameReal,
        'desmame',
        `Desmame do ${parto.ordem}o parto: ${parto.desmamadoM} M, ${parto.desmamadoF} F.`,
        parto.usuarioDesmame?.nome ?? 'Desconhecido',
      )
    }
  }

  if (casal?.dtEncerramento) {
    evento(
      casal.dtEncerramento,
      'encerramento',
      `Casal encerrado${casal.motivoEncerramento ? `: ${casal.motivoEncerramento}` : '.'}`,
      autorDe('casal', 'encerramento', idCasal),
    )
  }

  return eventos.sort(
    (a, b) =>
      a.dataHora.localeCompare(b.dataHora) || (ORDEM_NO_DIA[a.tipo] ?? 9) - (ORDEM_NO_DIA[b.tipo] ?? 9),
  )
}

/**
 * GET /api/caixas/:id - a ficha completa. A caixa de estoque tem a ficha dela, sem casal nem
 * parto: o que tem, de onde veio e para quem esta reservado
 */
export async function montarFicha(idCaixa: number) {
  const tipo = await prisma.caixa.findUnique({ where: { id: idCaixa }, select: { tipo: true } })

  if (tipo?.tipo === 'E') {
    return fichaDoEstoque(idCaixa)
  }

  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    include: {
      estante: { select: { numeroVisivel: true, sala: { select: { nome: true } }, colunas: true } },
      especie: { select: { nome: true } },
      // O casal ativo (ou o mais recente, a ficha e historico) primeiro, e depois os que
      // vieram antes dele
      casais: {
        orderBy: [{ ativo: 'desc' }, { dtFormacao: 'desc' }, { id: 'desc' }],
        select: { id: true },
      },
    },
  })

  if (caixa === null) {
    throw naoEncontrado('Caixa')
  }

  const [casalRecente, ...casaisDeAntes] = caixa.casais

  const [casal, partos, eventosDoRecente, anteriores] =
    casalRecente === undefined
      ? [null, [], [], []]
      : await Promise.all([
          casalFicha(casalRecente.id),
          partosDoCasal(casalRecente.id),
          eventosDoCasal(casalRecente.id),
          casaisAnteriores(casaisDeAntes.map((c) => c.id)),
        ])

  // os eventos das ninhadas de antes tambem: o desmame delas e registrado nesta ficha
  const eventosDeAntes = await Promise.all(anteriores.map((anterior) => eventosDoCasal(anterior.casal.id)))
  const eventos = [...eventosDoRecente, ...eventosDeAntes.flat()].sort((a, b) =>
    a.dataHora.localeCompare(b.dataHora),
  )

  // a caixa do casal encerrado com desmamados de um sexo so pode virar de estoque no lugar
  const virarEstoque =
    caixa.ativa && casal?.ativo !== true
      ? sexoParaVirarEstoque(false, await animaisNaCaixaDoCasal(prisma, caixa.id))
      : null

  return {
    tipo: 'casal' as const,
    virarEstoque,
    caixa: {
      id: caixa.id,
      endereco: {
        numeroVisivel: caixa.estante.numeroVisivel,
        sala: caixa.estante.sala.nome,
        codigo: codigoDaPosicao(caixa.face, caixa.linha, caixa.coluna, caixa.estante.colunas),
      },
      especie: codigoDaEspecie(caixa.especie.nome),
      // Vem do casal - infra.caixa nao tem linhagem (mesma leitura de montarGrade).
      // Mostra mesmo com o casal encerrado: a ficha e historico.
      linhagem: casal?.linhagem ?? null,
      estado: estadoCaixa.paraApi(caixa.estado),
    },
    casal,
    partos,
    /** os casais de antes que deixaram ninhada na caixa, cada um com os partos que nasceram */
    anteriores,
    eventos,
  }
}
