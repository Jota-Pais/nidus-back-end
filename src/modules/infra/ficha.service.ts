// A ficha da caixa: dados da caixa, o casal, os partos (1 a 5) e o historico

import { casalFicha, cicloFicha } from '../reproducao/reproducao.service.ts'
import { naoEncontrado } from '../../shared/erros.ts'
import { codigoDaPosicao } from './endereco.ts'
import { prisma } from '../../shared/prisma.ts'
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

async function eventosDoCasal(idCasal: number): Promise<EventoDaFicha[]> {
  const partos = await prisma.parto.findMany({
    where: { idCasal },
    orderBy: { ordem: 'asc' },
    select: {
      nascidoM: true,
      nascidoF: true,
      dtRegistroParto: true,
      usuarioParto: { select: { nome: true } },
      eutanasiadoM: true,
      eutanasiadoF: true,
      dtRegistroSelecao: true,
      usuarioSelecao: { select: { nome: true } },
      desmamadoM: true,
      desmamadoF: true,
      dtRegistroDesmame: true,
      usuarioDesmame: { select: { nome: true } },
    },
  })

  const eventos: EventoDaFicha[] = []

  for (const parto of partos) {
    if (parto.dtRegistroParto !== null) {
      eventos.push({
        dataHora: parto.dtRegistroParto.toISOString(),
        tipo: 'parto',
        descricao: `Parto registrado: ${parto.nascidoM} M, ${parto.nascidoF} F.`,
        autor: parto.usuarioParto?.nome ?? 'Desconhecido',
      })
    }

    if (parto.dtRegistroSelecao !== null) {
      eventos.push({
        dataHora: parto.dtRegistroSelecao.toISOString(),
        tipo: 'selecao',
        descricao: `Eutanasia registrada: ${parto.eutanasiadoM} M, ${parto.eutanasiadoF} F eutanasiados.`,
        autor: parto.usuarioSelecao?.nome ?? 'Desconhecido',
      })
    }

    if (parto.dtRegistroDesmame !== null) {
      eventos.push({
        dataHora: parto.dtRegistroDesmame.toISOString(),
        tipo: 'desmame',
        descricao: `Desmame registrado: ${parto.desmamadoM} M, ${parto.desmamadoF} F.`,
        autor: parto.usuarioDesmame?.nome ?? 'Desconhecido',
      })
    }
  }

  // ordem cronologica entre partos diferentes: dentro de cada parto ja sai
  // em ordem (parto -> selecao -> desmame), mas o '.sort' cobre qualquer
  // corrida entre carimbos de partos vizinhos
  return eventos.sort((a, b) => a.dataHora.localeCompare(b.dataHora))
}

/** GET /api/caixas/:id - a ficha completa */
export async function montarFicha(idCaixa: number) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    include: {
      estante: { select: { numeroVisivel: true, sala: true, colunas: true } },
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

  return {
    caixa: {
      id: caixa.id,
      endereco: {
        numeroVisivel: caixa.estante.numeroVisivel,
        sala: caixa.estante.sala,
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
