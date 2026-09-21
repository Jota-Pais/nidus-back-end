// secao 8 do contrato: quadro de acompanhamento e transicao de estado de caixa

import { calcularDisponibilidade, expectativaNaData, parametroNaData } from '../reproducao/disponibilidade.ts'
import type { ParametroVigente } from '../reproducao/disponibilidade.ts'
import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, estadoCaixa, exigirCodigo, hojeISO } from '../../shared/traducao.ts'
import type { EstadoCaixa } from '../../shared/traducao.ts'
import { calcularProximoEvento } from './proximoEvento.ts'
import { idDaEspecie } from './infra.service.ts'

type ParametroCompleto = ParametroVigente & {
  intervaloCicloDias: number
  maxPartoCasal: number
}

/** mesma traducao de parametrosDaEspecie em 'reproducao.service.ts' */
async function parametrosDaEspecie(idEspecie: number): Promise<ParametroCompleto[]> {
  const parametros = await prisma.parametroBiologico.findMany({ where: { idEspecie } })

  return parametros.map((parametro) => ({
    ...parametro,
    dtVigenciaInicio: dataISO(parametro.dtVigenciaInicio),
    dtVigenciaFim: parametro.dtVigenciaFim === null ? null : dataISO(parametro.dtVigenciaFim),
  }))
}

const selecaoDoQuadro = {
  id: true,
  codigo: true,
  estado: true,
  estante: { select: { numeroVisivel: true, sala: true } },
  casais: {
    orderBy: { dtFormacao: 'desc' as const },
    take: 1,
    select: {
      identificacao: true,
      ativo: true,
      idLinhagem: true,
      linhagem: { select: { nome: true } },
      partos: {
        orderBy: { ordem: 'desc' as const },
        take: 1,
        select: {
          ordem: true,
          dtPartoPrevisto: true,
          dtPartoReal: true,
          dtDesmamePrevisto: true,
          dtDesmameReal: true,
          nascidoM: true,
          nascidoF: true,
          eutanasiadoM: true,
          eutanasiadoF: true,
          desmamadoM: true,
          desmamadoF: true,
          compromissos: {
            where: { dtCancelamento: null },
            select: { qtdM: true, qtdF: true },
          },
        },
      },
    },
  },
} as const

type CaixaDoQuadro = Awaited<
  ReturnType<typeof prisma.caixa.findMany<{ where: object; select: typeof selecaoDoQuadro }>>
>[number]

function cardDaCaixa(caixa: CaixaDoQuadro, parametros: ParametroCompleto[], hoje: string) {
  const casal = caixa.casais[0]
  const ciclo = casal?.partos[0]
  const ativo = casal !== undefined && casal.ativo

  const parametro = parametroNaData(parametros, { idLinhagem: casal?.idLinhagem ?? null, em: hoje })
  const expectativa = expectativaNaData(parametros, {
    idLinhagem: casal?.idLinhagem ?? null,
    em: hoje,
  })

  const comprometido = (ciclo?.compromissos ?? []).reduce(
    (soma, c) => ({ m: soma.m + c.qtdM, f: soma.f + c.qtdF }),
    { m: 0, f: 0 },
  )

  const disponibilidade = calcularDisponibilidade(
    {
      nascidoM: ciclo?.nascidoM ?? null,
      nascidoF: ciclo?.nascidoF ?? null,
      eutanasiadoM: ciclo?.eutanasiadoM ?? null,
      eutanasiadoF: ciclo?.eutanasiadoF ?? null,
      desmamadoM: ciclo?.desmamadoM ?? null,
      desmamadoF: ciclo?.desmamadoF ?? null,
    },
    { expectativa, comprometido },
  )

  return {
    idCaixa: caixa.id,
    codigo: caixa.codigo,
    numeroVisivel: caixa.estante.numeroVisivel,
    sala: caixa.estante.sala,
    linhagem: casal?.linhagem.nome ?? null,
    casal:
      casal === undefined || !casal.ativo
        ? null
        : {
            identificacao: casal.identificacao.trim(),
            cicloAtual: ciclo?.ordem ?? 0,
            maxCiclos: parametro?.maxPartoCasal ?? 5,
          },
    disponivel: disponibilidade.disponivel,
    grauCerteza: disponibilidade.grauCerteza,
    proximoEvento:
      !ativo || ciclo === undefined
        ? null
        : calcularProximoEvento(
            {
              ordem: ciclo.ordem,
              dtPartoPrevisto: dataISO(ciclo.dtPartoPrevisto),
              dtPartoReal: ciclo.dtPartoReal === null ? null : dataISO(ciclo.dtPartoReal),
              dtDesmamePrevisto: dataISO(ciclo.dtDesmamePrevisto),
              dtDesmameReal: ciclo.dtDesmameReal === null ? null : dataISO(ciclo.dtDesmameReal),
            },
            {
              maxCiclos: parametro?.maxPartoCasal ?? 5,
              intervaloCicloDias: parametro?.intervaloCicloDias ?? 6,
              hoje,
            },
          ),
  }
}

/** 'GET /api/quadro?especie=' - RF-CIC-01, um quadro por especie, sem mistura. */
export async function montarQuadro(codigoEspecie: string, agora: Date = new Date()) {
  const hoje = hojeISO(agora)
  const idEspecie = await idDaEspecie(codigoEspecie)

  const [caixas, parametros] = await Promise.all([
    prisma.caixa.findMany({
      // O quadro so cobre caixa de reproducao que ja teve casal
      where: { idEspecie, ativa: true, finalidade: 'R', casais: { some: {} } },
      select: selecaoDoQuadro,
    }),
    parametrosDaEspecie(idEspecie),
  ])

  const colunas = new Map(
    estadoCaixa.termos.map((termo) => [termo, { estado: termo, total: 0, cards: [] as unknown[] }]),
  )

  for (const caixa of caixas) {
    const estadoApi = estadoCaixa.paraApi(caixa.estado)
    const coluna = colunas.get(estadoApi)

    // nunca deveria faltar: 'estadoCaixa.termos' cobre o dominio inteiro do
    // CHECK do banco. Se faltar e porque o dominio mudou dos dois lados e isto
    // e bug, nao entrada do usuario - por isso nao lanca 'naoEncontrado'
    if (coluna === undefined) {
      throw new Error(`Estado de caixa fora do dominio traduzivel: ${estadoApi}`)
    }

    coluna.total += 1
    coluna.cards.push(cardDaCaixa(caixa, parametros, hoje))
  }

  return {
    especie: codigoEspecie,
    // 'Map' preserva a ordem de inserção, que foi 'estadoCaixa.termos' -
    // identica a 'COLUNAS_DO_QUADRO' do front (RF-CIC-01: as cinco vem sempre,
    // mesmo vazias).
    colunas: Array.from(colunas.values()),
  }
}

export type PedidoDeTransicao = {
  estado: EstadoCaixa
  justificativa: string | null
  confirmar: boolean
}

/** PATCH /api/caixas/:id/estado - RF-CIC-03 */
export async function moverCaixa(idCaixa: number, dados: PedidoDeTransicao) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      id: true,
      casais: {
        where: { ativo: true },
        take: 1,
        select: { partos: { orderBy: { ordem: 'desc' }, take: 1, select: { id: true } } },
      },
    },
  })

  if (caixa === null) {
    throw naoEncontrado('Caixa')
  }

  const estadoNovo = exigirCodigo(estadoCaixa, dados.estado, 'Estado')
  const cicloAtual = caixa.casais[0]?.partos[0]

  const compromissosAfetados =
    cicloAtual === undefined ? [] : await compromissosDoParto(cicloAtual.id)

  if (compromissosAfetados.length > 0 && !dados.confirmar) {
    throw erroDeRegra(
      'TRANSICAO_CONTRARIA_COMPROMISSO',
      'Esta caixa tem compromissos ativos que esta mudanca pode afetar. Confirmar mesmo assim?',
      { requisito: 'RF-CIC-03', compromissosAfetados },
    )
  }

  const atualizada = await prisma.caixa.update({
    where: { id: idCaixa },
    data: { estado: estadoNovo },
  })

  return { idCaixa: atualizada.id, estado: estadoCaixa.paraApi(atualizada.estado) }
}

async function compromissosDoParto(idParto: number) {
  const compromissos = await prisma.compromisso.findMany({
    where: { idParto, dtCancelamento: null },
    select: {
      qtdM: true,
      qtdF: true,
      remessa: {
        select: { id: true, solicitacao: { select: { projeto: { select: { numero: true } } } } },
      },
    },
  })

  return compromissos.map((compromisso) => ({
    idRemessa: compromisso.remessa.id,
    projeto: compromisso.remessa.solicitacao.projeto.numero,
    qtdM: compromisso.qtdM,
    qtdF: compromisso.qtdF,
  }))
}
