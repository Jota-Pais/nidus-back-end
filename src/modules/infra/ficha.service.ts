// Secao 6 do contrato: ficha da posicao. `RF-INF-04` + `RF-REP-02`.
//
// Abre do card da grade e do card do quadro - mesma fonte, `RF-CIC-02`.
//
// ⚠️ `casal` aqui NAO segue a convencao de `montarGrade`/`montarQuadro`
// (nulo quando o casal esta inativo): a ficha e HISTORICO, entao mostra o
// ultimo casal mesmo encerrado - `RF-REP-08` fala em "apoio a escolha do par
// de reposicao", que sem ver o casal anterior nao faz sentido pedir. Grade e
// quadro sao "o que esta acontecendo agora"; a ficha e "o que aconteceu
// nesta posicao".
//
// `eventos` e reconstruido dos carimbos `dt_registro_*`/`id_usuario_*` de
// `reproducao.parto` (RNF-06) - nao existe tabela de evento generica no MVP
// (isso e fase 4, `docs/modelo-de-dados.md` secao 8). Parto seedado antes
// desta funcionalidade nao tem esses carimbos: simplesmente nao aparece na
// trilha, em vez de inventar autor ou hora.

import { casalFicha, cicloFicha } from '../reproducao/reproducao.service.ts'
import { naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import {
  codigoDaEspecie,
  estadoCaixa,
  face as dicFace,
  finalidadeCaixa,
} from '../../shared/traducao.ts'

async function ciclosDoCasal(idCasal: number) {
  const partos = await prisma.parto.findMany({
    where: { idCasal },
    orderBy: { ordem: 'asc' },
    select: { id: true },
  })

  // No maximo 5 (RN-04): N+1 aqui e uma ficha aberta por vez, nao uma lista.
  return Promise.all(partos.map((parto) => cicloFicha(parto.id)))
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
        descricao: `Selecao registrada: ${parto.eutanasiadoM} M, ${parto.eutanasiadoF} F eutanasiados.`,
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

  // Ordem cronologica entre partos diferentes: dentro de cada parto ja sai
  // em ordem (parto -> selecao -> desmame), mas o `.sort` cobre qualquer
  // corrida entre carimbos de partos vizinhos.
  return eventos.sort((a, b) => a.dataHora.localeCompare(b.dataHora))
}

/** `GET /api/caixas/:id` - a ficha completa. */
export async function montarFicha(idCaixa: number) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    include: {
      estante: { select: { id: true, numeroVisivel: true, sala: true } },
      especie: { select: { nome: true } },
      // O casal mais recente, ativo ou nao - ver o comentario no topo do
      // arquivo sobre por que a ficha nao zera o casal encerrado.
      casais: { orderBy: { dtFormacao: 'desc' }, take: 1, select: { id: true } },
    },
  })

  if (caixa === null) {
    throw naoEncontrado('Caixa')
  }

  const casalRecente = caixa.casais[0]

  const [casal, ciclos, eventos] =
    casalRecente === undefined
      ? [null, [], []]
      : await Promise.all([
          casalFicha(casalRecente.id),
          ciclosDoCasal(casalRecente.id),
          eventosDoCasal(casalRecente.id),
        ])

  return {
    caixa: {
      id: caixa.id,
      endereco: {
        idEstante: caixa.estante.id,
        numeroVisivel: caixa.estante.numeroVisivel,
        sala: caixa.estante.sala,
        face: dicFace.paraApi(String(caixa.face)),
        linha: caixa.linha,
        coluna: caixa.coluna,
        codigo: caixa.codigo,
      },
      especie: codigoDaEspecie(caixa.especie.nome),
      // Vem do casal - infra.caixa nao tem linhagem no MVP (mesma leitura de
      // montarGrade). Mostra mesmo com o casal encerrado, pelo motivo do
      // comentario no topo do arquivo.
      linhagem: casal?.linhagem ?? null,
      finalidade: finalidadeCaixa.paraApi(caixa.finalidade),
      estado: estadoCaixa.paraApi(caixa.estado),
      ativa: caixa.ativa,
    },
    casal,
    ciclos,
    eventos,
  }
}
