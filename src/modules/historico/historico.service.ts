// O historico de alteracoes: quem fez o que e quando. Mora em dois lugares, e a tela Historico le os
// dois juntos, por data do registro: o fato dos animais (nascimento, baixa, mudanca, reserva,
// entrega...) na trilha de ocorrencias (colonia.ocorrencia), e o resto (pedido, casal, datas,
// posicao, cadastros) em auditoria.historico. Cada fato aparece uma vez

import type { Prisma } from '@prisma/client'
import { prisma } from '../../shared/prisma.ts'
import { dataISO } from '../../shared/traducao.ts'
import { descreverOcorrencia, selecaoDaDescricao } from '../colonia/descricao.ts'
import { MOTIVO_SELECAO } from '../colonia/tipos.ts'

type BancoComHistorico = Pick<Prisma.TransactionClient, 'historico'>

/** Nome mostrado em "Quem" quando nao ha pessoa por tras da acao */
export const NOME_DO_SISTEMA = 'Sistema'

export type Entidade = 'caixa' | 'casal' | 'parto' | 'pedido' | 'usuario' | 'projeto' | 'linhagem' | 'sala' | 'estante'

export type Alteracao = {
  /** null so quando foi o proprio sistema. Obrigatorio para nenhuma acao ficar sem dono por esquecimento */
  idUsuario: number | null
  entidade: Entidade
  idEntidade: number
  acao: string
  descricao: string
  dados?: Prisma.InputJsonValue
}

export function registrarHistorico(banco: BancoComHistorico, alteracao: Alteracao) {
  return banco.historico.create({
    data: {
      idUsuario: alteracao.idUsuario,
      entidade: alteracao.entidade,
      idEntidade: alteracao.idEntidade,
      acao: alteracao.acao,
      descricao: alteracao.descricao.slice(0, 300),
      ...(alteracao.dados === undefined ? {} : { dados: alteracao.dados }),
    },
  })
}

export type FiltroDoHistorico = {
  entidade?: string | undefined
  idEntidade?: number | undefined
  busca?: string | undefined
  limite: number
}

/** Uma linha da tela: do historico ou da trilha. O id e o da linha na tabela de onde ela veio */
export type LinhaDoHistorico = {
  fonte: 'historico' | 'trilha'
  id: number
  /** quando foi registrado, ISO */
  dataHora: string
  usuario: string
  entidade: string
  idEntidade: number
  acao: string
  descricao: string
  dados: unknown
}

/**
 * As linhas do historico de antes do modelo por rato cujo fato a conversao para ele virou
 * ocorrencia da trilha: aparecem pela trilha, para nao repetir. Quem decide sao os dados de cada
 * linha, porque a mesma acao guardava fatos diferentes:
 * - o nascimento e a entrega: todo parto nascido ganhou a ocorrencia de nascimento, e todo pedido
 *   entregue, a de entrega;
 * - a selecao, quando o parto tem a baixa da selecao (a selecao sem animal nao virou baixa);
 * - a passagem para o estoque (caixa/estoque com o idParto nos dados), que virou mudanca. O antigo
 *   "virar caixa de estoque" gravava a mesma acao, com o total nos dados, e nao virou ocorrencia:
 *   fica no historico;
 * - a reserva (pedido/alocacao), quando o pedido tem a ocorrencia de reserva. A do compromisso
 *   cancelado nao virou nada e fica, ao lado da devolucao dela.
 * O codigo de hoje nao grava mais estas acoes no historico: as linhas sao so as antigas
 */
export async function linhasQueForamParaATrilha(): Promise<number[]> {
  const linhas = await prisma.$queryRaw<{ id: number }[]>`
    SELECT h."id"
      FROM "auditoria"."historico" h
     WHERE (h."entidade" = 'parto' AND h."acao" = 'nascimento')
        OR (h."entidade" = 'pedido' AND h."acao" = 'entrega')
        OR (h."entidade" = 'parto' AND h."acao" = 'selecao' AND EXISTS (
              SELECT 1 FROM "colonia"."ocorrencia" o
               WHERE o."tipo" = 'baixa' AND o."id_parto" = h."id_entidade" AND o."motivo" = ${MOTIVO_SELECAO}))
        OR (h."entidade" = 'caixa' AND h."acao" = 'estoque' AND h."dados" -> 'idParto' IS NOT NULL)
        OR (h."entidade" = 'pedido' AND h."acao" = 'alocacao' AND EXISTS (
              SELECT 1 FROM "colonia"."ocorrencia" o
               WHERE o."tipo" = 'reserva' AND o."id_pedido" = h."id_entidade"))
     ORDER BY h."id"`

  return linhas.map((linha) => linha.id)
}

/** Quem busca por "Sistema" acha o que o sistema fez, como na coluna Quem */
const buscaOSistema = (busca: string) => NOME_DO_SISTEMA.toLowerCase().includes(busca.toLowerCase())

// ------------------------------------------------------------ auditoria.historico

async function doHistorico(filtro: FiltroDoHistorico): Promise<LinhaDoHistorico[]> {
  const naTrilha = await linhasQueForamParaATrilha()

  const registros = await prisma.historico.findMany({
    where: {
      ...(filtro.entidade === undefined ? {} : { entidade: filtro.entidade }),
      ...(filtro.idEntidade === undefined ? {} : { idEntidade: filtro.idEntidade }),
      ...(naTrilha.length === 0 ? {} : { id: { notIn: naTrilha } }),
      ...(filtro.busca === undefined
        ? {}
        : {
            OR: [
              { descricao: { contains: filtro.busca, mode: 'insensitive' as const } },
              { usuario: { nome: { contains: filtro.busca, mode: 'insensitive' as const } } },
              ...(buscaOSistema(filtro.busca) ? [{ idUsuario: null }] : []),
            ],
          }),
    },
    orderBy: [{ dtHora: 'desc' }, { id: 'desc' }],
    take: filtro.limite,
    include: { usuario: { select: { nome: true } } },
  })

  return registros.map((registro) => ({
    fonte: 'historico',
    id: registro.id,
    dataHora: registro.dtHora.toISOString(),
    usuario: registro.usuario?.nome ?? NOME_DO_SISTEMA,
    entidade: registro.entidade,
    idEntidade: registro.idEntidade,
    acao: registro.acao,
    descricao: registro.descricao,
    dados: registro.dados,
  }))
}

// ------------------------------------------------------------ a trilha

/**
 * De quem e a ocorrencia na tela: o pedido da reserva e da entrega, o parto do nascimento e da
 * correcao, e a caixa onde aconteceu a baixa, a mudanca e a anulacao
 */
export function entidadeDaOcorrencia(ocorrencia: {
  tipo: string
  idPedido: number | null
  idParto: number | null
  idCaixaOrigem: number | null
  idCaixaDestino: number | null
}): { entidade: Entidade; idEntidade: number } {
  if (ocorrencia.idPedido !== null) return { entidade: 'pedido', idEntidade: ocorrencia.idPedido }
  if ((ocorrencia.tipo === 'nascimento' || ocorrencia.tipo === 'correcao') && ocorrencia.idParto !== null) {
    return { entidade: 'parto', idEntidade: ocorrencia.idParto }
  }
  return { entidade: 'caixa', idEntidade: ocorrencia.idCaixaOrigem ?? ocorrencia.idCaixaDestino ?? 0 }
}

/**
 * As ocorrencias que dizem respeito ao filtro: a reserva e a entrega sao do pedido; o nascimento,
 * a selecao e as correcoes, do parto; tudo o que tem caixa de origem ou de destino, dessa caixa.
 * Null quando a entidade nao tem fato de animal (conta, projeto...)
 */
export function ondeNaTrilha(filtro: Pick<FiltroDoHistorico, 'entidade' | 'idEntidade'>): Prisma.OcorrenciaWhereInput | null {
  const { entidade, idEntidade } = filtro
  const valor = idEntidade ?? { not: null }

  switch (entidade) {
    case undefined:
      return idEntidade === undefined
        ? {}
        : { OR: [{ idPedido: idEntidade }, { idParto: idEntidade }, { idCaixaOrigem: idEntidade }, { idCaixaDestino: idEntidade }] }
    case 'pedido':
      return { idPedido: valor }
    case 'parto':
      return { idParto: valor }
    case 'caixa':
      return { OR: [{ idCaixaOrigem: valor }, { idCaixaDestino: valor }] }
    default:
      return null
  }
}

const selecaoDaLinha = {
  ...selecaoDaDescricao,
  idParto: true,
  dtFato: true,
  dtRegistro: true,
  usuario: { select: { nome: true } },
} satisfies Prisma.OcorrenciaSelect

type OcorrenciaDaLinha = Prisma.OcorrenciaGetPayload<{ select: typeof selecaoDaLinha }>

function linhaDaOcorrencia(ocorrencia: OcorrenciaDaLinha): LinhaDoHistorico {
  const dtFato = dataISO(ocorrencia.dtFato)

  return {
    fonte: 'trilha',
    id: ocorrencia.id,
    dataHora: ocorrencia.dtRegistro.toISOString(),
    usuario: ocorrencia.usuario?.nome ?? NOME_DO_SISTEMA,
    ...entidadeDaOcorrencia(ocorrencia),
    acao: ocorrencia.tipo,
    // o registro pode ser de outro dia: o texto diz quando o fato aconteceu
    descricao: `Em ${dtFato}: ${descreverOcorrencia(ocorrencia)}`,
    dados: { dtFato, motivo: ocorrencia.motivo },
  }
}

/** Quantas ocorrencias a busca por texto le de cada vez */
const PAGINA_DA_BUSCA = 200

/**
 * As ocorrencias mais recentes do filtro. O texto da ocorrencia e montado aqui, entao a busca por
 * texto le a trilha em paginas, do registro mais novo para o mais velho, ate achar 'limite'
 */
async function daTrilha(filtro: FiltroDoHistorico): Promise<LinhaDoHistorico[]> {
  const onde = ondeNaTrilha(filtro)
  if (onde === null) return []

  const ordem: Prisma.OcorrenciaOrderByWithRelationInput[] = [{ dtRegistro: 'desc' }, { id: 'desc' }]
  const { busca } = filtro

  if (busca === undefined) {
    const lidas = await prisma.ocorrencia.findMany({ where: onde, orderBy: ordem, take: filtro.limite, select: selecaoDaLinha })
    return lidas.map(linhaDaOcorrencia)
  }

  const procurado = busca.toLowerCase()
  const achou = (linha: LinhaDoHistorico) =>
    linha.descricao.toLowerCase().includes(procurado) ||
    linha.usuario.toLowerCase().includes(procurado)

  const achadas: LinhaDoHistorico[] = []
  let depoisDe: number | undefined

  while (achadas.length < filtro.limite) {
    const pagina = await prisma.ocorrencia.findMany({
      where: onde,
      orderBy: ordem,
      take: PAGINA_DA_BUSCA,
      ...(depoisDe === undefined ? {} : { cursor: { id: depoisDe }, skip: 1 }),
      select: selecaoDaLinha,
    })

    achadas.push(...pagina.map(linhaDaOcorrencia).filter(achou))

    const ultima = pagina.at(-1)
    if (ultima === undefined || pagina.length < PAGINA_DA_BUSCA) break
    depoisDe = ultima.id
  }

  return achadas.slice(0, filtro.limite)
}

/**
 * GET /api/historico - as 'limite' linhas mais recentes do filtro, do historico e da trilha juntos,
 * pela data do registro
 */
export async function listarHistorico(filtro: FiltroDoHistorico) {
  const [doHistoricoLidas, daTrilhaLidas] = await Promise.all([doHistorico(filtro), daTrilha(filtro)])

  return {
    historico: [...doHistoricoLidas, ...daTrilhaLidas]
      .sort((a, b) => b.dataHora.localeCompare(a.dataHora) || (a.fonte === b.fonte ? b.id - a.id : 0))
      .slice(0, filtro.limite),
  }
}
