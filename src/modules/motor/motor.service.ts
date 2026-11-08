// A busca de atendimento lida do banco: caixas da especie que ja tiveram casal, os partos que
// ja nasceram e o que cada um ainda tem livre. So entram partos com a idade na entrega dentro da faixa aceita do pedido

import {
  ALEITAMENTO_DIAS,
  CIO_DIAS,
  GESTACAO_DIAS,
  NINHADA_POR_SEXO,
} from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, estadoCaixa, hojeISO } from '../../shared/traducao.ts'
import { codigoDaPosicao } from '../infra/endereco.ts'
import { SEXOS, livresNosLugares, selecaoDoPartoComLugares } from '../infra/estoque.ts'
import type { LoteDoParto, PartoComLugares } from '../infra/estoque.ts'
import { idDaEspecie } from '../infra/infra.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { disponibilidadeDoParto } from '../reproducao/disponibilidade.ts'
import { casaisParaODeficit, faixaDoPedido, ordenar, sugerirAlocacao } from './motor.ts'
import type { Origem } from './motor.ts'
import { caixaComEstoque } from '../infra/liberacaoDaCaixa.ts'

export type PedidoDeBusca = {
  especie: string
  idLinhagem?: number | undefined
  machos: number
  femeas: number
  /** de qualquer sexo: sai da sobra das caixas depois de machos e femeas */
  qualquer: number
  /** a faixa de idade pedida, em dias desde o nascimento. A idade exata e min = max */
  idadeMin: number
  idadeMax: number
  /** sem data, a referencia e hoje */
  dataEntrega?: string | undefined
  /** caixas ja sugeridas em remessas anteriores do mesmo pedido */
  excluir?: number[] | undefined
}

export function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000)
}

/** O dia em que o animal ja esta desmamado: o desmame real ou, sem ele, nascimento + aleitamento */
export function dataDoDesmame(nascimento: string, dtDesmameReal: Date | null): string {
  return dtDesmameReal ? dataISO(dtDesmameReal) : somarDias(nascimento, ALEITAMENTO_DIAS)
}

/** O que a busca le de uma caixa para escrever o codigo dela */
const POSICAO = {
  face: true,
  linha: true,
  coluna: true,
  estante: { select: { numeroVisivel: true, colunas: true } },
} as const

type Posicao = {
  face: number
  linha: number
  coluna: number
  estante: { numeroVisivel: string; colunas: number }
}

/** Uma caixa com animais livres do parto: a do casal, ou uma de estoque */
export type LugarDosLivres = {
  codigo: string
  numeroVisivel: string
  tipo: 'casal' | 'estoque'
  m: number
  f: number
}

/** Os desmamados do parto numa caixa de estoque, com a posicao dela */
type LoteComPosicao = LoteDoParto & { caixa: LoteDoParto['caixa'] & Posicao }

/**
 * Onde estao os animais livres do parto: o que sobrou na caixa do casal e as caixas de estoque
 * para onde os desmamados passaram, com quantos de cada sexo, na ordem da retirada
 */
export function ondeEstaoOsLivres(
  parto: Omit<PartoComLugares, 'lotes'> & { lotes: LoteComPosicao[] },
  caixaDoCasal: Posicao,
): LugarDosLivres[] {
  const porCaixa = new Map<number | null, LugarDosLivres>()

  for (const sexo of SEXOS) {
    for (const { idCaixa, qtd } of livresNosLugares(parto, sexo)) {
      const caixa =
        idCaixa === null ? caixaDoCasal : parto.lotes.find((lote) => lote.idCaixa === idCaixa)?.caixa
      if (caixa === undefined) continue

      const lugar = porCaixa.get(idCaixa) ?? {
        codigo: codigoDaPosicao(caixa.face, caixa.linha, caixa.coluna, caixa.estante.colunas),
        numeroVisivel: caixa.estante.numeroVisivel,
        tipo: idCaixa === null ? 'casal' : 'estoque',
        m: 0,
        f: 0,
      }
      porCaixa.set(idCaixa, { ...lugar, [sexo === 'M' ? 'm' : 'f']: qtd })
    }
  }

  // na ordem da retirada: a caixa do casal, depois as de estoque, da que recebeu primeiro
  return [null, ...parto.lotes.map((lote) => lote.idCaixa)].flatMap((idCaixa) => {
    const lugar = porCaixa.get(idCaixa)
    return lugar === undefined ? [] : [lugar]
  })
}

/** GET /api/busca */
export async function buscarAtendimento(pedido: PedidoDeBusca, agora: Date = new Date()) {
  const hoje = hojeISO(agora)
  const referencia = pedido.dataEntrega ?? hoje
  const idEspecie = await idDaEspecie(pedido.especie)

  const caixas = await prisma.caixa.findMany({
    where: {
      idEspecie,
      ...caixaComEstoque,
      ...(pedido.excluir && pedido.excluir.length > 0 ? { id: { notIn: pedido.excluir } } : {}),
      casais: {
        some: pedido.idLinhagem === undefined ? {} : { idLinhagem: pedido.idLinhagem },
      },
    },
    select: {
      id: true,
      face: true,
      linha: true,
      coluna: true,
      estado: true,
      estante: { select: { numeroVisivel: true, colunas: true } },
      casais: {
        where: pedido.idLinhagem === undefined ? {} : { idLinhagem: pedido.idLinhagem },
        select: {
          identificacao: true,
          partos: {
            orderBy: { ordem: 'asc' },
            select: {
              ...selecaoDoPartoComLugares,
              ordem: true,
              dtPartoReal: true,
              dtDesmameReal: true,
              // as caixas de estoque com os desmamados, para dizer onde estao os livres
              lotes: {
                orderBy: { id: 'asc' },
                select: {
                  id: true,
                  idCaixa: true,
                  qtd: true,
                  caixa: { select: { sexo: true, ...POSICAO } },
                },
              },
            },
          },
        },
      },
    },
  })

  const idade = { min: pedido.idadeMin, max: pedido.idadeMax }
  const faixa = faixaDoPedido(idade)

  const candidatas = caixas.flatMap((caixa) =>
    caixa.casais.flatMap((casal) =>
      casal.partos.flatMap((parto) => {
        if (parto.dtPartoReal === null) return []

        const nascimento = dataISO(parto.dtPartoReal)
        const idadeNaEntrega = diasEntre(nascimento, referencia)
        if (idadeNaEntrega < faixa.min || idadeNaEntrega > faixa.max) return []

        // o animal tem de estar desmamado ate a entrega
        if (dataDoDesmame(nascimento, parto.dtDesmameReal) > referencia) return []

        const { disponivel } = disponibilidadeDoParto(parto)
        if (disponivel.m + disponivel.f === 0) return []

        const origem: Origem = parto.dtDesmameReal ? 'de_fato' : 'previsao'

        return [
          {
            idCaixa: caixa.id,
            idParto: parto.id,
            codigo: codigoDaPosicao(caixa.face, caixa.linha, caixa.coluna, caixa.estante.colunas),
            numeroVisivel: caixa.estante.numeroVisivel,
            estado: estadoCaixa.paraApi(caixa.estado),
            casal: casal.identificacao.trim(),
            parto: parto.ordem,
            origem,
            nascimento,
            idadeNaEntrega,
            disponivel,
            onde: ondeEstaoOsLivres(parto, caixa),
          },
        ]
      }),
    ),
  )

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
