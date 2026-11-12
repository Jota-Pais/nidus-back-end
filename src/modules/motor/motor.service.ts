// A busca de atendimento lida do banco: os vivos livres da linhagem, agrupados pelo lugar de onde
// sairiam (a caixa e a data de nascimento: dentro da caixa, so a idade distingue os ratos). So
// entram os lugares que, na data da entrega, servem ao pedido pela regra de motor.porQueNaoServe,
// a mesma que a reserva confere

import { agora as instanteAtual } from '../../shared/relogio.ts'
import {
  ALEITAMENTO_DIAS,
  CIO_DIAS,
  GESTACAO_DIAS,
  NINHADA_POR_SEXO,
} from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { idDaEspecie } from '../infra/infra.service.ts'
import { diasEntre, somarDias } from '../reproducao/cadeiaTemporal.ts'
import {
  casaisParaODeficit,
  dataDoDesmame,
  faixaDoPedido,
  ordenar,
  porQueNaoServe,
  sugerirAlocacao,
} from './motor.ts'
import type { Origem } from './motor.ts'

export type PedidoDeBusca = {
  especie: string
  idLinhagem: number
  machos: number
  femeas: number
  /** de qualquer sexo: sai da sobra das caixas depois de machos e femeas */
  qualquer: number
  /** a faixa de idade pedida, em dias desde o nascimento. A idade exata e min = max */
  idadeMin: number
  idadeMax: number
  /** sem data, a referencia e hoje */
  dataEntrega?: string | undefined
}

/** Os vivos livres de um parto numa caixa, como a busca os le */
export type LivresDoParto = {
  idCaixa: number
  codigo: string
  numeroVisivel: string
  tipo: 'casal' | 'estoque'
  /** null na ninhada do cadastro inicial (sem casal conhecido) */
  ordem: number | null
  /** null na ninhada do cadastro inicial (sem casal conhecido) */
  casal: string | null
  /** 'aaaa-mm-dd' */
  dtNascimento: string
  /** 'aaaa-mm-dd', ou null enquanto o desmame nao foi registrado */
  dtDesmameReal: string | null
  livres: PorSexo
}

/** Um lugar candidato: a caixa e a data de nascimento, com os livres e os partos de onde vieram */
export type CandidataDaBusca = {
  idCaixa: number
  codigo: string
  numeroVisivel: string
  tipo: 'casal' | 'estoque'
  dtNascimento: string
  idadeNaEntrega: number
  origem: Origem
  livres: PorSexo
  /** de onde vieram; ordem e casal nulos na ninhada do cadastro inicial */
  partos: { ordem: number | null; casal: string | null }[]
}

type Lugar = CandidataDaBusca & { dtDesmame: string }

/**
 * Os lugares que atendem a data. Primeiro junta os livres por lugar (os partos do mesmo dia na
 * mesma caixa viram um so, e o lugar so esta desmamado quando todos estao); depois fica so com os
 * que servem ao pedido na data (porQueNaoServe). A origem e 'de_fato' quando todos ja desmamaram
 * de verdade; senao, 'previsao'
 */
export function lugaresDaBusca(
  livres: LivresDoParto[],
  faixa: { min: number; max: number },
  referencia: string,
): CandidataDaBusca[] {
  const porLugar = new Map<string, Lugar>()

  for (const doParto of livres) {
    const chave = `${doParto.idCaixa}:${doParto.dtNascimento}`
    const desmame = dataDoDesmame(doParto.dtNascimento, doParto.dtDesmameReal)
    const lugar: Lugar = porLugar.get(chave) ?? {
      idCaixa: doParto.idCaixa,
      codigo: doParto.codigo,
      numeroVisivel: doParto.numeroVisivel,
      tipo: doParto.tipo,
      dtNascimento: doParto.dtNascimento,
      idadeNaEntrega: diasEntre(doParto.dtNascimento, referencia),
      origem: 'de_fato',
      livres: { m: 0, f: 0 },
      partos: [],
      dtDesmame: desmame,
    }

    lugar.livres = { m: lugar.livres.m + doParto.livres.m, f: lugar.livres.f + doParto.livres.f }
    if (doParto.dtDesmameReal === null) lugar.origem = 'previsao'
    if (desmame > lugar.dtDesmame) lugar.dtDesmame = desmame
    lugar.partos.push({ ordem: doParto.ordem, casal: doParto.casal })
    porLugar.set(chave, lugar)
  }

  // uma ordem fixa antes de ordenar: a estante e a caixa, para o empate sair sempre igual
  return [...porLugar.values()]
    .filter((lugar) => porQueNaoServe(lugar, faixa, referencia) === null)
    .map(({ dtDesmame: _dtDesmame, ...candidata }) => candidata)
    .sort(
      (a, b) =>
        a.numeroVisivel.localeCompare(b.numeroVisivel) ||
        a.codigo.localeCompare(b.codigo) ||
        a.dtNascimento.localeCompare(b.dtNascimento),
    )
}

/** Os vivos livres da linhagem na especie, por caixa e parto */
async function lerLivres(idEspecie: number, idLinhagem: number): Promise<LivresDoParto[]> {
  const linhas = await prisma.animal.groupBy({
    by: ['idCaixa', 'idParto', 'sexo'],
    where: { situacao: 'vivo', idPedido: null, caixa: { idEspecie }, parto: { idLinhagem } },
    _count: { _all: true },
  })
  if (linhas.length === 0) return []

  const [caixas, partos] = await Promise.all([
    prisma.caixa.findMany({
      where: { id: { in: [...new Set(linhas.map((linha) => linha.idCaixa))] } },
      select: { id: true, codigo: true, tipo: true, estante: { select: { numeroVisivel: true } } },
    }),
    prisma.parto.findMany({
      where: { id: { in: [...new Set(linhas.map((linha) => linha.idParto))] } },
      select: { id: true, ordem: true, dtPartoReal: true, dtDesmameReal: true, casal: { select: { identificacao: true } } },
    }),
  ])

  const porParto = new Map<string, LivresDoParto>()

  for (const linha of linhas) {
    const caixa = caixas.find((c) => c.id === linha.idCaixa)
    const parto = partos.find((p) => p.id === linha.idParto)
    if (caixa === undefined || parto === undefined || parto.dtPartoReal === null) continue

    const chave = `${caixa.id}:${parto.id}`
    const lido: LivresDoParto = porParto.get(chave) ?? {
      idCaixa: caixa.id,
      codigo: caixa.codigo,
      numeroVisivel: caixa.estante.numeroVisivel,
      tipo: caixa.tipo === 'estoque' ? 'estoque' : 'casal',
      ordem: parto.ordem,
      casal: parto.casal === null ? null : parto.casal.identificacao.trim(),
      dtNascimento: dataISO(parto.dtPartoReal),
      dtDesmameReal: parto.dtDesmameReal === null ? null : dataISO(parto.dtDesmameReal),
      livres: { m: 0, f: 0 },
    }

    if (linha.sexo === 'M') lido.livres.m += linha._count._all
    else lido.livres.f += linha._count._all
    porParto.set(chave, lido)
  }

  return [...porParto.values()]
}

/** GET /api/busca */
export async function buscarAtendimento(pedido: PedidoDeBusca, agora: Date = instanteAtual()) {
  const hoje = hojeISO(agora)
  const referencia = pedido.dataEntrega ?? hoje
  const idEspecie = await idDaEspecie(pedido.especie)

  const idade = { min: pedido.idadeMin, max: pedido.idadeMax }
  const faixa = faixaDoPedido(idade)
  const candidatas = lugaresDaBusca(await lerLivres(idEspecie, pedido.idLinhagem), faixa, referencia)

  const { itens, deficit } = sugerirAlocacao(ordenar(candidatas, idade), {
    m: pedido.machos,
    f: pedido.femeas,
    qualquer: pedido.qualquer,
  })

  // ultima alternativa: acasalamento novo. A entrega precisa caber em hoje + gestacao + idade
  // minima, a menor idade que o pedido aceita
  const dataMinima = somarDias(hoje, GESTACAO_DIAS + pedido.idadeMin)

  return {
    faixa,
    candidatas: itens,
    deficit,
    casaisAFormar: casaisParaODeficit(deficit),
    acasalamentoNovo: {
      dataMinimaDeEntrega: dataMinima,
      viavel: referencia >= dataMinima,
      formarCasais: janelaDeFormarCasais(faixa, referencia),
      // quantos acasalamentos, da ninhada maior para a menor
      acasalamentos: {
        min: casaisParaODeficit(deficit, { m: NINHADA_POR_SEXO.maior, f: NINHADA_POR_SEXO.maior }),
        max: casaisParaODeficit(deficit, { m: NINHADA_POR_SEXO.menor, f: NINHADA_POR_SEXO.menor }),
      },
    },
  }
}

/**
 * Quando formar os casais novos para a entrega: os filhotes nascem a gestacao depois e, na
 * entrega, tem de estar na faixa aceita e ja desmamados, como as caixas da busca. Formado antes
 * da janela, os filhotes passam da idade; depois, ficam novos demais. A janela comeca o cio antes:
 * o casal pode levar esses dias para acasalar. Nula quando nenhuma idade da faixa chega desmamada
 */
export function janelaDeFormarCasais(
  faixa: { min: number; max: number },
  entrega: string,
): { de: string; ate: string } | null {
  const idadeMinima = Math.max(faixa.min, ALEITAMENTO_DIAS)
  if (idadeMinima > faixa.max) return null

  return {
    de: somarDias(entrega, -(GESTACAO_DIAS + faixa.max + CIO_DIAS)),
    ate: somarDias(entrega, -(GESTACAO_DIAS + idadeMinima)),
  }
}
