// Projetos CEUA, solicitacoes de animais e a alocacao das caixas que atendem cada uma

import type { Prisma } from '@prisma/client'
import { avisarPedidoDecidido } from '../../shared/email.ts'
import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { SITUACAO_DO_PROJETO } from './projeto.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import {
  codigoDaEspecie,
  dataISO,
  exigirCodigo,
  hojeISO,
  paraData,
  statusSolicitacao,
} from '../../shared/traducao.ts'
import {
  calcularGrauCerteza,
  compromissosAtivos,
  disponibilidadeDoParto,
  partoNaoVaiAcontecer,
} from '../reproducao/disponibilidade.ts'

/** O pesquisador so ve os proprios pedidos e os proprios projetos; tecnico e gestor veem todos */
const doPesquisador = (usuario: UsuarioDaSessao) => usuario.perfil === 'pesquisador'

/** GET /api/projetos */
export async function listarProjetos(usuario: UsuarioDaSessao, agora: Date = new Date()) {
  const hoje = hojeISO(agora)
  const projetos = await prisma.projeto.findMany({
    where: doPesquisador(usuario) ? { idUsuarioResponsavel: usuario.id } : {},
    orderBy: { numero: 'asc' },
    include: { usuarioResponsavel: { select: { nome: true } } },
  })

  return {
    projetos: projetos.map((projeto) => ({
      id: projeto.id,
      numero: projeto.numero,
      vigente: projeto.situacao === 'V' && dataISO(projeto.dtVigenciaFim) >= hoje,
      titulo: projeto.titulo,
      idUsuarioResponsavel: projeto.idUsuarioResponsavel,
      responsavel: projeto.usuarioResponsavel.nome,
      dtVigenciaInicio: dataISO(projeto.dtVigenciaInicio),
      dtVigenciaFim: dataISO(projeto.dtVigenciaFim),
      cotaAutorizada: projeto.cotaAutorizada,
      situacao: SITUACAO_DO_PROJETO[projeto.situacao as keyof typeof SITUACAO_DO_PROJETO],
    })),
  }
}

export const PRAZO_DE_RESPOSTA_EM_DIAS = 14

export const MOTIVO_SEM_RESPOSTA = `Recusado automaticamente: o CPMR nao respondeu em ${PRAZO_DE_RESPOSTA_EM_DIAS} dias.`

export async function recusarSemResposta(agora: Date = new Date()): Promise<number> {
  const limite = new Date(agora.getTime() - PRAZO_DE_RESPOSTA_EM_DIAS * 24 * 60 * 60 * 1000)
  const vencidas = await prisma.solicitacao.findMany({
    where: { status: 'EN', dtCriacao: { lte: limite } },
    select: { id: true, idUsuarioSolicitante: true },
  })

  let recusadas = 0

  for (const { id, idUsuarioSolicitante } of vencidas) {
    try {
      await recusarSolicitacao(id, MOTIVO_SEM_RESPOSTA, idUsuarioSolicitante)
      recusadas += 1
    } catch (erro) {
      if (!(erro instanceof ErroDeAplicacao)) throw erro
    }
  }

  return recusadas
}

/** GET /api/solicitacoes */
export async function listarSolicitacoes(usuario: UsuarioDaSessao) {
  const solicitacoes = await prisma.solicitacao.findMany({
    where: doPesquisador(usuario) ? { idUsuarioSolicitante: usuario.id } : {},
    orderBy: { id: 'desc' },
    include: {
      usuarioSolicitante: { select: { email: true } },
      especie: { select: { nome: true } },
      linhagem: { select: { id: true, nome: true } },
    },
  })

  const decisoes = await prisma.historico.findMany({
    where: {
      entidade: 'solicitacao',
      acao: { in: ['alocacao', 'recusa'] },
      idEntidade: { in: solicitacoes.map((s) => s.id) },
    },
    orderBy: { dtHora: 'asc' },
    select: { idEntidade: true, acao: true, dtHora: true, dados: true },
  })

  const decisao = (id: number, acao: 'alocacao' | 'recusa') =>
    decisoes.find((d) => d.idEntidade === id && d.acao === acao)

  const dataDa = (id: number, acao: 'alocacao' | 'recusa') => {
    const encontrada = decisao(id, acao)
    return encontrada ? hojeISO(encontrada.dtHora) : null
  }

  const motivoDaRecusa = (id: number) => {
    const dados = decisao(id, 'recusa')?.dados
    return typeof dados === 'object' && dados !== null && 'motivo' in dados && typeof dados.motivo === 'string'
      ? dados.motivo
      : null
  }

  return {
    solicitacoes: solicitacoes.map((s) => ({
      id: s.id,
      dataSolicitacao: hojeISO(s.dtCriacao),
      prazoResposta: s.status === 'EN' ? somarDias(hojeISO(s.dtCriacao), PRAZO_DE_RESPOSTA_EM_DIAS) : null,
      dataAceite: dataDa(s.id, 'alocacao'),
      dataRecusa: s.status === 'RE' ? dataDa(s.id, 'recusa') : null,
      protocoloCeua: s.protocoloCeua,
      // o nome e o que a pessoa digitou no pedido; o e-mail e o da conta que pediu
      pesquisador: s.nomePesquisador,
      email: s.usuarioSolicitante.email,
      especie: codigoDaEspecie(s.especie.nome),
      idLinhagem: s.linhagem.id,
      linhagem: s.linhagem.nome,
      machos: s.qtdM,
      femeas: s.qtdF,
      qualquer: s.qtdQualquer,
      idadeMin: s.idadeMinDias,
      idadeMax: s.idadeMaxDias,
      dataEntrega: dataISO(s.dtDesejada),
      observacoes: s.observacoes,
      status: statusSolicitacao.paraApi(s.status),
      motivoRecusa: s.status === 'RE' ? motivoDaRecusa(s.id) : null,
    })),
  }
}

export type NovaSolicitacao = {
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

/** POST /api/solicitacoes - o pedido do pesquisador, com a primeira remessa */
export async function criarSolicitacao(
  dados: NovaSolicitacao,
  usuario: UsuarioDaSessao,
  agora: Date = new Date(),
) {
  // O protocolo vale pelo formato, que a rota ja conferiu: o pedido nao depende de projeto
  // cadastrado, e a equipe tecnica confere com a CEUA ao analisar. Quando o numero ja esta no
  // cadastro, o pedido fica ligado ao projeto
  const projeto = await prisma.projeto.findUnique({
    where: { numero: dados.protocoloCeua },
    select: { id: true },
  })

  const linhagem = await prisma.linhagem.findUnique({ where: { id: dados.idLinhagem } })

  if (linhagem === null) {
    throw naoEncontrado('Linhagem')
  }

  if (!linhagem.ativa) {
    throw campoInvalido('idLinhagem', 'Esta linhagem esta inativa.')
  }

  if (dados.dataEntrega < hojeISO(agora)) {
    throw campoInvalido('dataEntrega', 'A data de entrega nao pode estar no passado.')
  }

  const criada = await prisma.$transaction(async (tx) => {
    const solicitacao = await tx.solicitacao.create({
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
        status: 'EN',
        observacoes: dados.observacoes,
      },
    })

    // a remessa preve o pedido inteiro: o "qualquer" vai junto, como machos e femeas
    await tx.remessa.create({
      data: {
        idSolicitacao: solicitacao.id,
        sequencia: 1,
        dtPrevista: paraData(dados.dataEntrega),
        qtdMPrevista: dados.machos,
        qtdFPrevista: dados.femeas,
        qtdQualquerPrevista: dados.qualquer,
      },
    })

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'solicitacao',
      idEntidade: solicitacao.id,
      acao: 'criacao',
      descricao: `Solicitacao de ${dados.machos} M, ${dados.femeas} F e ${dados.qualquer} de qualquer sexo de ${linhagem.nome} para ${dados.dataEntrega}`,
      dados: { ...dados },
    })

    return solicitacao
  })

  return { id: criada.id }
}

export type ItemDeAlocacao = { idParto: number; machos: number; femeas: number }

function campoInvalido(campo: string, mensagem: string) {
  return new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
    campos: { [campo]: mensagem },
  })
}

function somarPorParto(itens: ItemDeAlocacao[]): ItemDeAlocacao[] {
  const porParto = new Map<number, ItemDeAlocacao>()

  for (const item of itens) {
    const somado = porParto.get(item.idParto)
    porParto.set(item.idParto, {
      idParto: item.idParto,
      machos: (somado?.machos ?? 0) + item.machos,
      femeas: (somado?.femeas ?? 0) + item.femeas,
    })
  }

  return [...porParto.values()]
}

/** O que a solicitacao traz junto para o aviso ao pesquisador */
const PARA_O_AVISO = {
  linhagem: { select: { nome: true } },
  usuarioSolicitante: { select: { email: true } },
} satisfies Prisma.SolicitacaoInclude

/**
 * Avisa por e-mail quem pediu, DEPOIS de a decisao estar gravada. Sem 'await': o envio nao segura
 * a resposta do tecnico, e uma falha do servico de e-mail fica so no log, sem desfazer nada.
 * Com motivo e recusa; sem, aprovacao
 */
function avisarPesquisador(
  solicitacao: Prisma.SolicitacaoGetPayload<{ include: typeof PARA_O_AVISO }>,
  motivoDaRecusa?: string,
): void {
  const { id } = solicitacao

  avisarPedidoDecidido(
    solicitacao.usuarioSolicitante.email,
    {
      protocoloCeua: solicitacao.protocoloCeua,
      linhagem: solicitacao.linhagem.nome,
      machos: solicitacao.qtdM,
      femeas: solicitacao.qtdF,
      qualquer: solicitacao.qtdQualquer,
      idadeMin: solicitacao.idadeMinDias,
      idadeMax: solicitacao.idadeMaxDias,
      dataEntrega: dataISO(solicitacao.dtDesejada),
      dataPedido: hojeISO(solicitacao.dtCriacao),
    },
    motivoDaRecusa,
  ).catch((erro: unknown) => {
    console.error(`[pedido] o aviso do pedido #${id} nao foi enviado:`, erro)
  })
}

/**
 * POST /api/solicitacoes/:id/alocacao - o tecnico aceita as caixas da busca. Cada item vira um
 * compromisso com o parto; caixa que estava em Livres vai para Pre-reserva
 */
export async function alocarSolicitacao(
  idSolicitacao: number,
  itensPedidos: ItemDeAlocacao[],
  usuario: UsuarioDaSessao,
) {
  const itens = somarPorParto(itensPedidos)

  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id: idSolicitacao },
    include: { ...PARA_O_AVISO, remessas: { orderBy: { sequencia: 'asc' }, take: 1 } },
  })

  if (solicitacao === null) {
    throw naoEncontrado('Solicitacao')
  }

  // so a enviada recebe caixas. O codigo so grava enviada e aprovada; os outros status do
  // dicionario continuam aparecendo na lista, mas nenhum vira aprovada por aqui.
  // A aprovada e o caso comum (dois tecnicos, ou dois cliques em Alocar) e diz o que houve
  if (solicitacao.status === 'AP') {
    throw erroDeRegra('SOLICITACAO_JA_ALOCADA', `A solicitacao #${idSolicitacao} ja foi alocada.`)
  }

  if (solicitacao.status !== 'EN') {
    throw erroDeRegra(
      'SOLICITACAO_JA_ALOCADA',
      `A solicitacao #${idSolicitacao} nao esta aguardando alocacao.`,
    )
  }

  const remessa = solicitacao.remessas[0]

  if (remessa === undefined) {
    throw naoEncontrado('Remessa da solicitacao')
  }

  const totalM = itens.reduce((soma, item) => soma + item.machos, 0)
  const totalF = itens.reduce((soma, item) => soma + item.femeas, 0)

  // o "qualquer" pode vir como macho ou como femea, mas o total nao passa do pedido
  const { qtdM, qtdF, qtdQualquer } = solicitacao

  if (
    totalM > qtdM + qtdQualquer ||
    totalF > qtdF + qtdQualquer ||
    totalM + totalF > qtdM + qtdF + qtdQualquer
  ) {
    throw campoInvalido(
      'itens',
      `A alocacao passa do pedido (${qtdM} machos, ${qtdF} femeas e ${qtdQualquer} de qualquer sexo).`,
    )
  }

  const partos = await prisma.parto.findMany({
    where: { id: { in: itens.map((item) => item.idParto) } },
    include: {
      casal: {
        select: {
          idCaixa: true,
          idLinhagem: true,
          ativo: true,
          caixa: { select: { ativa: true, estado: true } },
          linhagem: { select: { idEspecie: true } },
        },
      },
      compromissos: compromissosAtivos,
    },
  })

  // confere antes de gravar: nenhum item pode passar do que o parto ainda tem livre
  for (const item of itens) {
    const parto = partos.find((p) => p.id === item.idParto)

    if (parto === undefined || parto.casal.linhagem.idEspecie !== solicitacao.idEspecie) {
      throw naoEncontrado(`Parto ${item.idParto} da especie pedida`)
    }

    if (parto.casal.idLinhagem !== solicitacao.idLinhagem) {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `O ${parto.ordem}o parto da caixa nao e da linhagem pedida.`,
      )
    }

    if (!parto.casal.caixa.ativa || parto.casal.caixa.estado === 'X') {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `A caixa do ${parto.ordem}o parto esta inativa ou ja foi enviada.`,
      )
    }

    if (partoNaoVaiAcontecer(parto, parto.casal)) {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `O casal do ${parto.ordem}o parto foi encerrado e esse parto nao vai acontecer.`,
      )
    }

    const { disponivel } = disponibilidadeDoParto(parto)

    if (item.machos > disponivel.m || item.femeas > disponivel.f) {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `O ${parto.ordem}o parto da caixa so tem ${disponivel.m} machos e ${disponivel.f} femeas livres.`,
      )
    }
  }

  await prisma.$transaction(async (tx) => {
    const aprovada = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: 'EN' },
      data: { status: 'AP' },
    })

    if (aprovada.count === 0) {
      throw erroDeRegra('SOLICITACAO_JA_ALOCADA', `A solicitacao #${idSolicitacao} ja foi alocada.`)
    }

    for (const item of itens) {
      const parto = partos.find((p) => p.id === item.idParto)
      if (parto === undefined || item.machos + item.femeas === 0) continue

      await tx.compromisso.create({
        data: {
          idRemessa: remessa.id,
          idParto: parto.id,
          idUsuarioCriacao: usuario.id,
          qtdM: item.machos,
          qtdF: item.femeas,
          // a coluna ainda e NOT NULL: guarda o grau do parto no momento da reserva
          grauCerteza: calcularGrauCerteza(parto),
        },
      })
    }

    await tx.caixa.updateMany({
      where: { id: { in: partos.map((parto) => parto.casal.idCaixa) }, estado: 'R' },
      data: { estado: 'P' },
    })

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'solicitacao',
      idEntidade: idSolicitacao,
      acao: 'alocacao',
      descricao: `Solicitacao #${idSolicitacao} alocada: ${totalM} M e ${totalF} F em ${itens.length} parto(s)`,
      dados: { itens },
    })
  })

  avisarPesquisador(solicitacao)

  return { idSolicitacao, status: statusSolicitacao.paraApi('AP') }
}

export async function registrarEntrega(
  idSolicitacao: number,
  dtEntrega: string,
  idUsuario: number,
  agora: Date = new Date(),
) {
  const solicitacao = await prisma.solicitacao.findUnique({ where: { id: idSolicitacao } })

  if (solicitacao === null) {
    throw naoEncontrado('Solicitacao')
  }

  if (solicitacao.status === 'CO') {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A entrega da solicitacao #${idSolicitacao} ja foi registrada.`,
    )
  }

  if (solicitacao.status !== 'AP') {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A solicitacao #${idSolicitacao} ainda nao tem caixas alocadas.`,
    )
  }

  if (dtEntrega > hojeISO(agora)) {
    throw campoInvalido('dtEntrega', 'A data da entrega nao pode ser no futuro.')
  }

  if (dtEntrega < dataISO(solicitacao.dtCriacao)) {
    throw campoInvalido('dtEntrega', 'A data da entrega nao pode ser antes do pedido.')
  }

  await prisma.$transaction(async (tx) => {
    const concluida = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: 'AP' },
      data: { status: 'CO' },
    })

    if (concluida.count === 0) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        `A entrega da solicitacao #${idSolicitacao} ja foi registrada.`,
      )
    }

    await tx.remessa.updateMany({
      where: { idSolicitacao, dtRealizada: null },
      data: { dtRealizada: paraData(dtEntrega), status: 'E' },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'solicitacao',
      idEntidade: idSolicitacao,
      acao: 'entrega',
      descricao: `Entrega da solicitacao #${idSolicitacao} em ${dtEntrega}`,
      dados: { dtEntrega },
    })
  })

  return { idSolicitacao, status: statusSolicitacao.paraApi('CO'), dtEntrega }
}

export async function recusarSolicitacao(idSolicitacao: number, motivo: string, idUsuario: number) {
  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id: idSolicitacao },
    include: PARA_O_AVISO,
  })

  if (solicitacao === null) {
    throw naoEncontrado('Solicitacao')
  }

  if (solicitacao.status !== 'EN') {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A solicitacao #${idSolicitacao} nao esta aguardando analise e nao pode ser recusada.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    const recusada = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: 'EN' },
      data: { status: 'RE' },
    })

    if (recusada.count === 0) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        `A solicitacao #${idSolicitacao} nao esta aguardando analise e nao pode ser recusada.`,
      )
    }

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'solicitacao',
      idEntidade: idSolicitacao,
      acao: 'recusa',
      descricao: `Solicitacao #${idSolicitacao} recusada: ${motivo}`,
      dados: { motivo },
    })
  })

  avisarPesquisador(solicitacao, motivo)

  return { idSolicitacao, status: statusSolicitacao.paraApi('RE'), motivo }
}
