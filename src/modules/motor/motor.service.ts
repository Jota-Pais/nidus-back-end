// A busca de atendimento lida do banco: caixas com casal ativo da especie, os partos de
// cada casal (os confirmados e o proximo, que e o que existe na tabela) e o que cada um ainda
// tem livre

import { prisma } from '../../shared/prisma.ts'
import { dataISO, estadoCaixa, hojeISO } from '../../shared/traducao.ts'
import { codigoDaPosicao } from '../infra/endereco.ts'
import { idDaEspecie } from '../infra/infra.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { calcularDisponibilidade, parametroNaData } from '../reproducao/disponibilidade.ts'
import { parametrosDaEspecie } from '../reproducao/reproducao.service.ts'
import { casaisParaODeficit, faixaAceita, ordenar, sugerirAlocacao } from './motor.ts'
import type { Origem } from './motor.ts'

export type PedidoDeBusca = {
  especie: string
  idLinhagem?: number | undefined
  machos: number
  femeas: number
  /** idade pedida, em dias desde o nascimento */
  idade: number
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

  const [faixas, parametros, caixas] = await Promise.all([
    prisma.toleranciaIdade.findMany({ where: { dtVigenciaFim: null } }),
    parametrosDaEspecie(idEspecie),
    prisma.caixa.findMany({
      where: {
        idEspecie,
        ativa: true,
        finalidade: 'R',
        // reserva e enviado ja estao comprometidas: so livres, pre-reserva e estoque
        estado: { in: ['R', 'P', 'E'] },
        ...(pedido.excluir && pedido.excluir.length > 0 ? { id: { notIn: pedido.excluir } } : {}),
        casais: {
          some: { ativo: true, ...(pedido.idLinhagem === undefined ? {} : { idLinhagem: pedido.idLinhagem }) },
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
          where: { ativo: true },
          take: 1,
          select: {
            identificacao: true,
            idLinhagem: true,
            linhagem: { select: { nome: true } },
            partos: {
              orderBy: { ordem: 'asc' },
              select: {
                id: true,
                ordem: true,
                dtAcasalamento: true,
                dtPartoPrevisto: true,
                dtPartoReal: true,
                dtDesmameReal: true,
                nascidoM: true,
                nascidoF: true,
                eutanasiadoM: true,
                eutanasiadoF: true,
                desmamadoM: true,
                desmamadoF: true,
                compromissos: { where: { dtCancelamento: null }, select: { qtdM: true, qtdF: true } },
              },
            },
          },
        },
      },
    }),
  ])

  const faixa = faixaAceita(pedido.idade, faixas)

  const candidatas = caixas.flatMap((caixa) => {
    const casal = caixa.casais[0]
    if (casal === undefined) return []

    return casal.partos.flatMap((parto) => {
      const nascimento = dataISO(parto.dtPartoReal ?? parto.dtPartoPrevisto)
      const idadeNaEntrega = diasEntre(nascimento, referencia)
      if (idadeNaEntrega < faixa.min || idadeNaEntrega > faixa.max) return []

      const parametro = parametroNaData(parametros, {
        idLinhagem: casal.idLinhagem,
        em: dataISO(parto.dtAcasalamento),
      })

      // o animal tem de estar desmamado ate a entrega
      const desmame = parto.dtDesmameReal
        ? dataISO(parto.dtDesmameReal)
        : somarDias(nascimento, parametro?.aleitamentoDias ?? 22)
      if (desmame > referencia) return []

      const comprometido = parto.compromissos.reduce(
        (soma, c) => ({ m: soma.m + c.qtdM, f: soma.f + c.qtdF }),
        { m: 0, f: 0 },
      )
      const { disponivel } = calcularDisponibilidade(parto, {
        expectativa: { m: parametro?.expectativaM ?? 4, f: parametro?.expectativaF ?? 4 },
        comprometido,
      })
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
          linhagem: casal.linhagem.nome,
          casal: casal.identificacao.trim(),
          parto: parto.ordem,
          origem,
          nascimento,
          idadeNaEntrega,
          disponivel,
        },
      ]
    })
  })

  const { itens, deficit } = sugerirAlocacao(ordenar(candidatas, pedido.idade), {
    m: pedido.machos,
    f: pedido.femeas,
  })

  // ultima alternativa: acasalamento novo. A entrega precisa caber em hoje + gestacao + idade
  const vigente = parametroNaData(parametros, { idLinhagem: pedido.idLinhagem ?? null, em: hoje })
  const dataMinima = somarDias(hoje, (vigente?.gestacaoDias ?? 23) + pedido.idade)

  return {
    referencia,
    faixa,
    candidatas: itens,
    deficit,
    casaisAFormar: casaisParaODeficit(deficit, {
      m: vigente?.expectativaM ?? 4,
      f: vigente?.expectativaF ?? 4,
    }),
    acasalamentoNovo: { dataMinimaDeEntrega: dataMinima, viavel: referencia >= dataMinima },
  }
}
