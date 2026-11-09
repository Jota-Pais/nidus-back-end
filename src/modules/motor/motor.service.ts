// A busca de atendimento lida do banco: os vivos livres da linhagem, agrupados pelo lugar de onde
// sairiam (a caixa e a data de nascimento: dentro da caixa, so a idade distingue os ratos). So
// entram os que, na data da entrega, estao na faixa de idade aceita e ja desmamaram

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
import { casaisParaODeficit, faixaDoPedido, ordenar, sugerirAlocacao } from './motor.ts'
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

/** O dia em que o animal ja esta desmamado: o desmame real ou, sem ele, nascimento + aleitamento */
export function dataDoDesmame(nascimento: string, dtDesmameReal: Date | null): string {
  return dtDesmameReal ? dataISO(dtDesmameReal) : somarDias(nascimento, ALEITAMENTO_DIAS)
}

/** Os vivos livres de um parto numa caixa, como a busca os le */
export type LivresDoParto = {
  idCaixa: number
  codigo: string
  numeroVisivel: string
  tipo: 'casal' | 'estoque'
  ordem: number
  casal: string
  /** 'aaaa-mm-dd' */
  dtNascimento: string
  dtDesmameReal: Date | null
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
  partos: { ordem: number; casal: string }[]
}

/**
 * Os lugares que atendem a data: livres de partos na faixa de idade aceita e ja desmamados ate a
 * entrega (o desmame real, ou o previsto). Os partos do mesmo dia na mesma caixa viram um lugar
 * so. A origem e 'de_fato' quando todos ja desmamaram de verdade; senao, 'previsao'
 */
export function lugaresDaBusca(
  livres: LivresDoParto[],
  faixa: { min: number; max: number },
  referencia: string,
): CandidataDaBusca[] {
  const porLugar = new Map<string, CandidataDaBusca>()

  for (const doParto of livres) {
    const idadeNaEntrega = diasEntre(doParto.dtNascimento, referencia)
    if (idadeNaEntrega < faixa.min || idadeNaEntrega > faixa.max) continue
    if (dataDoDesmame(doParto.dtNascimento, doParto.dtDesmameReal) > referencia) continue

    const chave = `${doParto.idCaixa}:${doParto.dtNascimento}`
    const lugar: CandidataDaBusca = porLugar.get(chave) ?? {
      idCaixa: doParto.idCaixa,
      codigo: doParto.codigo,
      numeroVisivel: doParto.numeroVisivel,
      tipo: doParto.tipo,
      dtNascimento: doParto.dtNascimento,
      idadeNaEntrega,
      origem: 'de_fato',
      livres: { m: 0, f: 0 },
      partos: [],
    }

    lugar.livres = { m: lugar.livres.m + doParto.livres.m, f: lugar.livres.f + doParto.livres.f }
    if (doParto.dtDesmameReal === null) lugar.origem = 'previsao'
    lugar.partos.push({ ordem: doParto.ordem, casal: doParto.casal })
    porLugar.set(chave, lugar)
  }

  // uma ordem fixa antes de ordenar: a estante e a caixa, para o empate sair sempre igual
  return [...porLugar.values()].sort(
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
    where: { situacao: 'vivo', idPedido: null, caixa: { idEspecie }, parto: { casal: { idLinhagem } } },
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
      casal: parto.casal.identificacao.trim(),
      dtNascimento: dataISO(parto.dtPartoReal),
      dtDesmameReal: parto.dtDesmameReal,
      livres: { m: 0, f: 0 },
    }

    if (linha.sexo === 'M') lido.livres.m += linha._count._all
    else lido.livres.f += linha._count._all
    porParto.set(chave, lido)
  }

  return [...porParto.values()]
}

/** GET /api/busca */
export async function buscarAtendimento(pedido: PedidoDeBusca, agora: Date = new Date()) {
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
