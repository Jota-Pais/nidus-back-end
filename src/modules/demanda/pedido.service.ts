// O pedido de animais do pesquisador: a lista, o pedido novo, a aprovacao e a recusa (da equipe,
// ou automatica para o pedido sem resposta). A reserva e a entrega ficam em reserva.service.ts e
// entrega.service.ts

import { agora as instanteAtual } from '../../shared/relogio.ts'
import { avisarPedidoDecidido } from '../../shared/email.ts'
import { ErroDeAplicacao, campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, dataISO, dataLegivel, hojeISO, paraData } from '../../shared/traducao.ts'
import { faltasDosPedidos } from '../colonia/consultas.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { travarPedidos } from '../colonia/travas.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import { PARA_O_AVISO, avisarPesquisador } from './aviso.ts'
import { NOME_NA_TELA, RECUSAVEIS, descreverQuantidade, statusDo } from './pedido.ts'
import type { StatusDoPedido } from './pedido.ts'
import { soltarReservados } from './reserva.service.ts'

export const PRAZO_DE_RESPOSTA_EM_DIAS = 14

export const MOTIVO_SEM_RESPOSTA = `Recusado automaticamente: a equipe não respondeu em ${PRAZO_DE_RESPOSTA_EM_DIAS} dias.`

/** As acoes do pedido no historico. A reserva, a reserva desfeita e a entrega ficam na trilha */
export const ACAO_CRIACAO = 'criacao'
export const ACAO_APROVACAO = 'aprovacao'
export const ACAO_RECUSA = 'recusa'

/** O pesquisador so ve os proprios pedidos; tecnico e gestor veem todos */
const doPesquisador = (usuario: UsuarioDaSessao) => usuario.perfil === 'pesquisador'

// ------------------------------------------------------------ lista

/** O motivo gravado com a recusa no historico */
function motivoDe(dados: unknown): string | null {
  return typeof dados === 'object' && dados !== null && 'motivo' in dados && typeof dados.motivo === 'string'
    ? dados.motivo
    : null
}

/** GET /api/pedidos */
export async function listarPedidos(usuario: UsuarioDaSessao) {
  const pedidos = await prisma.pedido.findMany({
    where: doPesquisador(usuario) ? { idUsuarioSolicitante: usuario.id } : {},
    orderBy: { id: 'desc' },
    include: {
      usuarioSolicitante: { select: { email: true } },
      especie: { select: { nome: true } },
      linhagem: { select: { id: true, nome: true } },
    },
  })

  const ids = pedidos.map((pedido) => pedido.id)

  const [decisoes, primeirasReservas, faltas] = await Promise.all([
    prisma.historico.findMany({
      where: { entidade: 'pedido', acao: { in: [ACAO_APROVACAO, ACAO_RECUSA] }, idEntidade: { in: ids } },
      orderBy: { dtHora: 'asc' },
      select: { idEntidade: true, acao: true, dtHora: true, dados: true },
    }),
    // o aceite do pedido de antes da aprovacao separada foi a propria reserva
    prisma.ocorrencia.groupBy({
      by: ['idPedido'],
      where: { tipo: 'reserva', idPedido: { in: ids } },
      _min: { dtRegistro: true },
    }),
    faltasDosPedidos(
      prisma,
      pedidos.filter((pedido) => pedido.status === 'reservado').map((pedido) => pedido.id),
    ),
  ])

  const ultima = (id: number, acao: string) => decisoes.filter((d) => d.idEntidade === id && d.acao === acao).at(-1)
  const diaDa = (id: number, acao: string) => {
    const decisao = ultima(id, acao)
    return decisao === undefined ? null : hojeISO(decisao.dtHora)
  }
  const diaDaPrimeiraReserva = (id: number) => {
    const quando = primeirasReservas.find((reserva) => reserva.idPedido === id)?._min.dtRegistro
    return quando == null ? null : hojeISO(quando)
  }

  return {
    pedidos: pedidos.map((pedido) => {
      const status = statusDo(pedido)
      const falta = faltas.find((f) => f.idPedido === pedido.id)

      return {
        id: pedido.id,
        dataPedido: hojeISO(pedido.dtCriacao),
        prazoResposta: status === 'enviado' ? somarDias(hojeISO(pedido.dtCriacao), PRAZO_DE_RESPOSTA_EM_DIAS) : null,
        /** o dia em que a equipe aceitou o pedido: o da aprovacao */
        dataAceite: ['aprovado', 'reservado', 'entregue'].includes(status)
          ? (diaDa(pedido.id, ACAO_APROVACAO) ?? diaDaPrimeiraReserva(pedido.id))
          : null,
        dataRecusa: status === 'recusado' ? diaDa(pedido.id, ACAO_RECUSA) : null,
        protocoloCeua: pedido.protocoloCeua,
        // o nome e o que a pessoa digitou no pedido; o e-mail e o da conta que pediu
        pesquisador: pedido.nomePesquisador,
        email: pedido.usuarioSolicitante.email,
        especie: codigoDaEspecie(pedido.especie.nome),
        idLinhagem: pedido.linhagem.id,
        linhagem: pedido.linhagem.nome,
        machos: pedido.qtdM,
        femeas: pedido.qtdF,
        qualquer: pedido.qtdQualquer,
        idadeMin: pedido.idadeMinDias,
        idadeMax: pedido.idadeMaxDias,
        dataEntrega: dataISO(pedido.dtDesejada),
        dataEntregue: pedido.dtEntrega === null ? null : dataISO(pedido.dtEntrega),
        observacoes: pedido.observacoes,
        status,
        motivoRecusa: status === 'recusado' ? motivoDe(ultima(pedido.id, ACAO_RECUSA)?.dados) : null,
        /** o pedido reservado que ficou com menos animais vivos do que pede: quanto falta */
        reservaEmFalta: falta === undefined ? null : { m: falta.m, f: falta.f, qualquer: falta.qualquer },
      }
    }),
  }
}

// ------------------------------------------------------------ pedido novo

export type PedidoNovo = {
  nomePesquisador: string
  /** o processo 23080.XXXXXX/AAAA-XX ou o numero do Sistema CEUA, ja conferido no formato */
  protocoloCeua: string
  idLinhagem: number
  machos: number
  femeas: number
  qualquer: number
  /** a idade exata vem com idadeMin = idadeMax */
  idadeMin: number
  idadeMax: number
  dataEntrega: string
  observacoes: string | null
}

/** POST /api/pedidos - o pedido do pesquisador. Nasce enviado, aguardando a analise da equipe */
export async function criarPedido(dados: PedidoNovo, usuario: UsuarioDaSessao, agora: Date = instanteAtual()) {
  // O protocolo vale pelo formato, que a rota ja conferiu: o pedido nao depende de projeto
  // cadastrado, e a equipe tecnica confere com a CEUA ao analisar. Quando o numero ja esta no
  // cadastro, o pedido fica ligado ao projeto
  const projeto = await prisma.projeto.findUnique({ where: { numero: dados.protocoloCeua }, select: { id: true } })
  const linhagem = await prisma.linhagem.findUnique({ where: { id: dados.idLinhagem } })

  if (linhagem === null) throw naoEncontrado('Linhagem')
  if (!linhagem.ativa) throw campoInvalido('idLinhagem', 'Esta linhagem está inativa.')

  if (dados.dataEntrega < hojeISO(agora)) {
    throw campoInvalido('dataEntrega', 'A data de entrega não pode estar no passado.')
  }

  const criado = await prisma.$transaction(async (tx) => {
    const pedido = await tx.pedido.create({
      data: {
        protocoloCeua: dados.protocoloCeua,
        idProjeto: projeto?.id ?? null,
        idUsuarioSolicitante: usuario.id,
        nomePesquisador: dados.nomePesquisador,
        idEspecie: linhagem.idEspecie,
        idLinhagem: linhagem.id,
        qtdM: dados.machos,
        qtdF: dados.femeas,
        qtdQualquer: dados.qualquer,
        idadeMinDias: dados.idadeMin,
        idadeMaxDias: dados.idadeMax,
        dtDesejada: paraData(dados.dataEntrega),
        status: 'enviado',
        dtCriacao: agora,
        observacoes: dados.observacoes,
      },
    })

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'pedido',
      idEntidade: pedido.id,
      acao: ACAO_CRIACAO,
      descricao: `Pedido de ${descreverQuantidade({ m: dados.machos, f: dados.femeas, qualquer: dados.qualquer })} de ${linhagem.nome} para ${dataLegivel(dados.dataEntrega)}`,
      dados: { ...dados },
    })

    return pedido
  })

  return { id: criado.id }
}

// ------------------------------------------------------------ aprovacao

/**
 * POST /api/pedidos/:id/aprovacao - a equipe aceita fazer o pedido. Aprovar nao reserva nada: os
 * animais sao reservados depois (reserva.service), quando existirem na idade pedida
 */
export async function aprovarPedido(idPedido: number, usuario: UsuarioDaSessao) {
  const pedido = await prisma.$transaction(async (tx) => {
    await travarPedidos(tx, [idPedido])

    const pedido = await tx.pedido.findUnique({ where: { id: idPedido }, include: PARA_O_AVISO })
    if (pedido === null) throw naoEncontrado('Pedido')

    const status = statusDo(pedido)

    // o caso comum e o segundo clique
    if (status === 'aprovado' || status === 'reservado') {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `O pedido #${idPedido} já foi aprovado.`)
    }

    if (status !== 'enviado') {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `O pedido #${idPedido} não está aguardando análise e não pode ser aprovado.`)
    }

    await tx.pedido.update({ where: { id: idPedido }, data: { status: 'aprovado', dtManutencao: instanteAtual() } })

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'pedido',
      idEntidade: idPedido,
      acao: ACAO_APROVACAO,
      descricao: `Pedido #${idPedido} aprovado: os animais serão reservados para ${dataLegivel(dataISO(pedido.dtDesejada))}`,
    })

    return pedido
  })

  avisarPesquisador(pedido, (email, resumo) => avisarPedidoDecidido(email, resumo))

  return { idPedido, status: 'aprovado' as const }
}

// ------------------------------------------------------------ recusa

/**
 * Recusa o pedido num dos status 'recusaveis', conferido com o pedido travado. O reservado solta
 * os animais antes (decisao do Joao, 08/11): voltam a ficar livres onde estao. idUsuario null
 * quando a recusa e automatica, sem ninguem da equipe por tras
 */
async function recusar(
  idPedido: number,
  motivo: string,
  idUsuario: number | null,
  recusaveis: readonly StatusDoPedido[],
) {
  const recusa = await prisma.$transaction(async (tx) => {
    await travarPedidos(tx, [idPedido])

    const pedido = await tx.pedido.findUnique({ where: { id: idPedido }, include: PARA_O_AVISO })
    if (pedido === null) throw naoEncontrado('Pedido')

    const status = statusDo(pedido)

    if (!recusaveis.includes(status)) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `O pedido #${idPedido} está ${NOME_NA_TELA[status]} e não pode ser recusado.`)
    }

    const soltos: PorSexo =
      status === 'reservado' ? await soltarReservados(tx, idPedido, `Pedido recusado: ${motivo}`, idUsuario) : { m: 0, f: 0 }

    await tx.pedido.update({ where: { id: idPedido }, data: { status: 'recusado', dtManutencao: instanteAtual() } })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'pedido',
      idEntidade: idPedido,
      acao: ACAO_RECUSA,
      descricao: `Pedido #${idPedido} recusado: ${motivo}`,
      dados: { motivo },
    })

    return { pedido, soltos }
  })

  avisarPesquisador(recusa.pedido, (email, resumo) => avisarPedidoDecidido(email, resumo, motivo))

  return { idPedido, status: 'recusado' as const, motivo, soltos: recusa.soltos }
}

/**
 * POST /api/pedidos/:id/recusa - a equipe recusa o pedido que aguarda analise, o aprovado que nao
 * deu para produzir ou o reservado (os animais voltam a ficar livres)
 */
export function recusarPedido(idPedido: number, motivo: string, idUsuario: number) {
  return recusar(idPedido, motivo, idUsuario, RECUSAVEIS)
}

/**
 * Recusa o pedido que ficou sem resposta por PRAZO_DE_RESPOSTA_EM_DIAS. So o enviado: o aprovado ja
 * foi respondido, mesmo que os animais ainda nao estejam reservados. Devolve quantos recusou
 */
export async function recusarSemResposta(agora: Date = instanteAtual()): Promise<number> {
  const limite = new Date(agora.getTime() - PRAZO_DE_RESPOSTA_EM_DIAS * 24 * 60 * 60 * 1000)
  const vencidos = await prisma.pedido.findMany({
    where: { status: 'enviado', dtCriacao: { lte: limite } },
    select: { id: true },
  })

  let recusados = 0

  for (const { id } of vencidos) {
    try {
      // ninguem da equipe recusou: o historico grava sem usuario e a tela mostra "Sistema"
      await recusar(id, MOTIVO_SEM_RESPOSTA, null, ['enviado'])
      recusados += 1
    } catch (erro) {
      // a equipe decidiu no meio do caminho: o pedido nao esta mais enviado
      if (!(erro instanceof ErroDeAplicacao)) throw erro
    }
  }

  return recusados
}
