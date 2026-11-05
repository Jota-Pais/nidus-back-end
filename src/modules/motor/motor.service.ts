// A busca de atendimento lida do banco: caixas da especie que ja tiveram casal, os partos de
// cada casal (os confirmados e o proximo, que e o que existe na tabela) e o que cada um ainda
// tem livre. So entram partos com a idade na entrega dentro da faixa aceita do pedido

import { ALEITAMENTO_DIAS, GESTACAO_DIAS } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, estadoCaixa, hojeISO } from '../../shared/traducao.ts'
import { codigoDaPosicao } from '../infra/endereco.ts'
import { idDaEspecie } from '../infra/infra.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import {
  compromissosAtivos,
  disponibilidadeDoParto,
  partoNaoVaiAcontecer,
} from '../reproducao/disponibilidade.ts'
import { casaisParaODeficit, faixaDoPedido, ordenar, sugerirAlocacao } from './motor.ts'
import type { Origem } from './motor.ts'

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

function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000)
}

/** GET /api/busca */
export async function buscarAtendimento(pedido: PedidoDeBusca, agora: Date = new Date()) {
  const hoje = hojeISO(agora)
  const referencia = pedido.dataEntrega ?? hoje
  const idEspecie = await idDaEspecie(pedido.especie)

  const caixas = await prisma.caixa.findMany({
    where: {
      idEspecie,
      ativa: true,
      // reserva e enviado ja estao comprometidas: so livres, pre-reserva e estoque
      estado: { in: ['R', 'P', 'E'] },
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
          ativo: true,
          partos: {
            orderBy: { ordem: 'asc' },
            select: {
              id: true,
              ordem: true,
              dtPartoPrevisto: true,
              dtPartoReal: true,
              dtDesmameReal: true,
              nascidoM: true,
              nascidoF: true,
              eutanasiadoM: true,
              eutanasiadoF: true,
              desmamadoM: true,
              desmamadoF: true,
              compromissos: compromissosAtivos,
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
        if (partoNaoVaiAcontecer(parto, casal)) return []

        const nascimento = dataISO(parto.dtPartoReal ?? parto.dtPartoPrevisto)
        const idadeNaEntrega = diasEntre(nascimento, referencia)
        if (idadeNaEntrega < faixa.min || idadeNaEntrega > faixa.max) return []

        // o animal tem de estar desmamado ate a entrega
        const desmame = parto.dtDesmameReal
          ? dataISO(parto.dtDesmameReal)
          : somarDias(nascimento, ALEITAMENTO_DIAS)
        if (desmame > referencia) return []

        const { disponivel } = disponibilidadeDoParto(parto)
        if (disponivel.m + disponivel.f === 0) return []

        const origem: Origem = parto.dtDesmameReal
          ? 'de_fato'
          : parto.dtPartoReal
            ? 'previsao'
            : 'previsao_parto'

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
    acasalamentoNovo: { dataMinimaDeEntrega: dataMinima, viavel: referencia >= dataMinima },
  }
}
