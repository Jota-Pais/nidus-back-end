// Projetos CEUA, solicitacoes de animais e a alocacao das caixas que atendem cada uma

import type { Prisma } from '@prisma/client'
import { avisarAnimaisReservados, avisarPedidoDecidido } from '../../shared/email.ts'
import type { ResumoDoPedido } from '../../shared/email.ts'
import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { baixarEstoqueNaEntrega } from '../infra/estoque.service.ts'
import { liberarCaixaVazia } from '../infra/liberacaoDaCaixa.ts'
import { faixaDoPedido } from '../motor/motor.ts'
import { dataDoDesmame, diasEntre } from '../motor/motor.service.ts'
import { ACAO_DEVOLUCAO, devolvidosDesde, faltaDosPedidos } from './devolucao.service.ts'
import { SITUACAO_DO_PROJETO } from './projeto.service.ts'
import { somarDias } from '../reproducao/cadeiaTemporal.ts'
import {
  codigoDaEspecie,
  dataISO,
  estadoCaixa,
  exigirCodigo,
  hojeISO,
  paraData,
  statusSolicitacao,
} from '../../shared/traducao.ts'
import {
  calcularGrauCerteza,
  compromissosAtivos,
  disponibilidadeDoParto,
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

/** A acao no historico quando a equipe aprova o pedido, antes de reservar os animais */
export const ACAO_APROVACAO = 'aprovacao'

/**
 * Recusa o pedido que ficou sem resposta. So o enviado: o aprovado ja foi respondido, mesmo que
 * os animais ainda nao estejam reservados
 */
export async function recusarSemResposta(agora: Date = new Date()): Promise<number> {
  const limite = new Date(agora.getTime() - PRAZO_DE_RESPOSTA_EM_DIAS * 24 * 60 * 60 * 1000)
  const vencidas = await prisma.solicitacao.findMany({
    where: { status: 'EN', dtCriacao: { lte: limite } },
    select: { id: true },
  })

  // O pedido devolvido para analise conta o prazo da devolucao, e nao do dia em que foi feito.
  // So vale para a devolucao de antes da aprovacao separada, que voltava o pedido para enviado;
  // hoje desfazer a reserva deixa o pedido aprovado
  const devolvidos = await devolvidosDesde(
    vencidas.map((vencida) => vencida.id),
    limite,
  )

  let recusadas = 0

  for (const { id } of vencidas) {
    if (devolvidos.has(id)) continue

    try {
      // ninguem da equipe recusou: o historico grava sem usuario e a tela mostra "Sistema"
      await recusar(id, MOTIVO_SEM_RESPOSTA, null, ['EN'])
      recusadas += 1
    } catch (erro) {
      if (!(erro instanceof ErroDeAplicacao)) throw erro
    }
  }

  return recusadas
}

/** GET /api/solicitacoes */
function ultimaEntrega(remessas: { dtRealizada: Date | null }[]): string | null {
  const datas = remessas.flatMap((r) => (r.dtRealizada === null ? [] : [dataISO(r.dtRealizada)]))
  return datas.length === 0 ? null : datas.sort().at(-1)!
}

export async function listarSolicitacoes(usuario: UsuarioDaSessao) {
  const solicitacoes = await prisma.solicitacao.findMany({
    where: doPesquisador(usuario) ? { idUsuarioSolicitante: usuario.id } : {},
    orderBy: { id: 'desc' },
    include: {
      usuarioSolicitante: { select: { email: true } },
      especie: { select: { nome: true } },
      linhagem: { select: { id: true, nome: true } },
      remessas: { where: { dtRealizada: { not: null } }, select: { dtRealizada: true } },
    },
  })

  const decisoes = await prisma.historico.findMany({
    where: {
      entidade: 'solicitacao',
      acao: { in: [ACAO_APROVACAO, 'alocacao', 'recusa', ACAO_DEVOLUCAO] },
      idEntidade: { in: solicitacoes.map((s) => s.id) },
    },
    orderBy: { dtHora: 'asc' },
    select: { idEntidade: true, acao: true, dtHora: true, dados: true },
  })

  // a mais recente: a reserva desfeita pode ser feita de novo
  type Acao = typeof ACAO_APROVACAO | 'alocacao' | 'recusa' | typeof ACAO_DEVOLUCAO
  const decisao = (id: number, acao: Acao) =>
    decisoes.filter((d) => d.idEntidade === id && d.acao === acao).at(-1)

  const dataDa = (id: number, acao: Acao) => {
    const encontrada = decisao(id, acao)
    return encontrada === undefined ? null : hojeISO(encontrada.dtHora)
  }

  /**
   * O dia em que a equipe aceitou o pedido: o da aprovacao. O pedido de antes da aprovacao
   * separada foi aceito ao reservar os animais. So o pedido aceito tem a data
   */
  const dataDoAceite = (id: number, status: string) =>
    ['AT', 'AP', 'CO'].includes(status) ? (dataDa(id, ACAO_APROVACAO) ?? dataDa(id, 'alocacao')) : null

  /**
   * O prazo de resposta conta do pedido, ou da ultima devolucao para analise (a de antes da
   * aprovacao separada, que voltava o pedido para enviado)
   */
  const inicioDoPrazo = (id: number, dtCriacao: Date) => decisao(id, ACAO_DEVOLUCAO)?.dtHora ?? dtCriacao

  const faltas = await faltaDosPedidos(solicitacoes.filter((s) => s.status === 'AP').map((s) => s.id))

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
      prazoResposta:
        s.status === 'EN'
          ? somarDias(hojeISO(inicioDoPrazo(s.id, s.dtCriacao)), PRAZO_DE_RESPOSTA_EM_DIAS)
          : null,
      dataAceite: dataDoAceite(s.id, s.status),
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
      dataEntregue: s.status === 'CO' ? ultimaEntrega(s.remessas) : null,
      observacoes: s.observacoes,
      status: statusSolicitacao.paraApi(s.status),
      motivoRecusa: s.status === 'RE' ? motivoDaRecusa(s.id) : null,
      /** pedido com animais reservados cuja ninhada ficou com menos do que o reservado: quanto pode faltar */
      reservaEmFalta: faltas.get(s.id) ?? null,
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

/** "2 machos, 1 femea e 3 de qualquer sexo", so com o que nao e zero */
function descreverQuantidade({ m, f, qualquer }: { m: number; f: number; qualquer: number }): string {
  const partes = [
    m > 0 ? `${m} ${m === 1 ? 'macho' : 'machos'}` : '',
    f > 0 ? `${f} ${f === 1 ? 'femea' : 'femeas'}` : '',
    qualquer > 0 ? `${qualquer} de qualquer sexo` : '',
  ].filter((parte) => parte !== '')

  const ultima = partes.pop() ?? ''
  return partes.length > 0 ? `${partes.join(', ')} e ${ultima}` : ultima
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
 * 'enviar' e o aviso da decisao: aprovacao, reserva dos animais ou recusa
 */
function avisarPesquisador(
  solicitacao: Prisma.SolicitacaoGetPayload<{ include: typeof PARA_O_AVISO }>,
  enviar: (email: string, pedido: ResumoDoPedido) => Promise<void>,
): void {
  const { id } = solicitacao

  enviar(solicitacao.usuarioSolicitante.email, {
    protocoloCeua: solicitacao.protocoloCeua,
    linhagem: solicitacao.linhagem.nome,
    machos: solicitacao.qtdM,
    femeas: solicitacao.qtdF,
    qualquer: solicitacao.qtdQualquer,
    idadeMin: solicitacao.idadeMinDias,
    idadeMax: solicitacao.idadeMaxDias,
    dataEntrega: dataISO(solicitacao.dtDesejada),
    dataPedido: hojeISO(solicitacao.dtCriacao),
  }).catch((erro: unknown) => {
    console.error(`[pedido] o aviso do pedido #${id} nao foi enviado:`, erro)
  })
}

/**
 * POST /api/solicitacoes/:id/aprovacao - a equipe aceita fazer o pedido. Aprovar nao reserva
 * nada: os animais sao reservados depois, em alocarSolicitacao, quando existirem na idade pedida
 */
export async function aprovarSolicitacao(idSolicitacao: number, usuario: UsuarioDaSessao) {
  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id: idSolicitacao },
    include: PARA_O_AVISO,
  })

  if (solicitacao === null) {
    throw naoEncontrado('Solicitacao')
  }

  // aprovada com ou sem os animais reservados: o caso comum e o segundo clique
  if (solicitacao.status === 'AT' || solicitacao.status === 'AP') {
    throw erroDeRegra('SEQUENCIA_INVALIDA', `A solicitacao #${idSolicitacao} ja foi aprovada.`)
  }

  const naoAguarda = `A solicitacao #${idSolicitacao} nao esta aguardando analise e nao pode ser aprovada.`

  if (solicitacao.status !== 'EN') {
    throw erroDeRegra('SEQUENCIA_INVALIDA', naoAguarda)
  }

  await prisma.$transaction(async (tx) => {
    // so se ainda estiver enviada: outra pessoa pode ter aprovado ou recusado no meio do caminho
    const aprovada = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: 'EN' },
      data: { status: 'AT' },
    })

    if (aprovada.count === 0) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', naoAguarda)
    }

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'solicitacao',
      idEntidade: idSolicitacao,
      acao: ACAO_APROVACAO,
      descricao: `Solicitacao #${idSolicitacao} aprovada: os animais serao reservados para ${dataISO(solicitacao.dtDesejada)}`,
    })
  })

  avisarPesquisador(solicitacao, (email, pedido) => avisarPedidoDecidido(email, pedido))

  return { idSolicitacao, status: statusSolicitacao.paraApi('AT') }
}

/**
 * POST /api/solicitacoes/:id/alocacao - o tecnico reserva para o pedido aprovado as caixas da
 * busca, que tem de cobrir o pedido inteiro. Cada item vira um compromisso com o parto
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

  // so a aprovada sem reserva (em atendimento) recebe caixas. A com os animais ja reservados e o
  // caso comum (dois tecnicos, ou dois cliques em Reservar) e diz o que houve
  if (solicitacao.status === 'AP') {
    throw erroDeRegra(
      'SOLICITACAO_JA_ALOCADA',
      `Os animais da solicitacao #${idSolicitacao} ja estao reservados.`,
    )
  }

  if (solicitacao.status === 'EN') {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Aprove o pedido antes de reservar os animais.')
  }

  if (solicitacao.status !== 'AT') {
    throw erroDeRegra(
      'SOLICITACAO_JA_ALOCADA',
      `A solicitacao #${idSolicitacao} nao esta aguardando animais.`,
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
    // regra, e nao campo: quem aloca pela busca nao tem campo para corrigir e precisa do motivo
    throw erroDeRegra(
      'PEDIDO_EXCEDIDO',
      `A alocacao passa do pedido: foram ${descreverQuantidade({ m: totalM, f: totalF, qualquer: 0 })} para um pedido de ${descreverQuantidade({ m: qtdM, f: qtdF, qualquer: qtdQualquer })}.`,
    )
  }

  // e nem fica abaixo: so o pedido inteiro e reservado. Sem animais para completar, o pedido
  // continua aguardando animais, e a equipe recusa com o motivo ou espera ter animal
  const falta = {
    m: Math.max(qtdM - totalM, 0),
    f: Math.max(qtdF - totalF, 0),
    // o que veio alem dos machos e das femeas pedidos cobre o "qualquer"
    qualquer: Math.max(qtdQualquer - Math.max(totalM - qtdM, 0) - Math.max(totalF - qtdF, 0), 0),
  }
  const quantasFaltam = falta.m + falta.f + falta.qualquer

  if (quantasFaltam > 0) {
    throw erroDeRegra(
      'PEDIDO_INCOMPLETO',
      `A alocacao nao cobre o pedido: ${quantasFaltam === 1 ? 'falta' : 'faltam'} ${descreverQuantidade(falta)}. Sem animais, recuse com o motivo ou aguarde.`,
    )
  }

  const partos = await prisma.parto.findMany({
    where: { id: { in: itens.map((item) => item.idParto) } },
    include: {
      casal: {
        select: {
          idCaixa: true,
          idLinhagem: true,
          caixa: { select: { ativa: true, estado: true } },
          linhagem: { select: { idEspecie: true } },
        },
      },
      compromissos: compromissosAtivos,
    },
  })

  // a idade na entrega segue a faixa aceita da busca de atendimento (secao 1.6), e o animal tem
  // de estar desmamado ate a entrega
  const entrega = dataISO(solicitacao.dtDesejada)
  const faixa = faixaDoPedido({ min: solicitacao.idadeMinDias, max: solicitacao.idadeMaxDias })

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

    if (parto.casal.caixa.ativa && parto.casal.caixa.estado === 'X') {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `A caixa do ${parto.ordem}o parto ja foi enviada.`,
      )
    }

    if (parto.dtPartoReal === null) {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `O ${parto.ordem}o parto da caixa ainda nao nasceu: so da para reservar animal que ja existe.`,
      )
    }

    const nascimento = dataISO(parto.dtPartoReal)
    const idadeNaEntrega = diasEntre(nascimento, entrega)

    if (idadeNaEntrega < faixa.min || idadeNaEntrega > faixa.max) {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `O ${parto.ordem}o parto da caixa tem ${idadeNaEntrega} dias na entrega, fora da idade aceita no pedido (${faixa.min} a ${faixa.max} dias).`,
      )
    }

    // e desmamado ate a entrega, tambem como na busca
    if (dataDoDesmame(nascimento, parto.dtDesmameReal) > entrega) {
      throw erroDeRegra(
        'DISPONIBILIDADE_EXCEDIDA',
        `O ${parto.ordem}o parto da caixa ainda nao estara desmamado na entrega.`,
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
    const reservada = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: 'AT' },
      data: { status: 'AP' },
    })

    if (reservada.count === 0) {
      throw erroDeRegra(
        'SOLICITACAO_JA_ALOCADA',
        `Os animais da solicitacao #${idSolicitacao} ja estao reservados.`,
      )
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

    await registrarHistorico(tx, {
      idUsuario: usuario.id,
      entidade: 'solicitacao',
      idEntidade: idSolicitacao,
      acao: 'alocacao',
      descricao: `Animais da solicitacao #${idSolicitacao} reservados: ${totalM} M e ${totalF} F em ${itens.length} parto(s)`,
      dados: { itens },
    })
  })

  avisarPesquisador(solicitacao, avisarAnimaisReservados)

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

  const falta = (await faltaDosPedidos([idSolicitacao])).get(idSolicitacao)

  if (falta !== undefined && falta.m + falta.f > 0) {
    throw erroDeRegra(
      'DISPONIBILIDADE_EXCEDIDA',
      `A reserva deste pedido esta em falta (${falta.m} M e ${falta.f} F a menos do que o reservado): desfaca a reserva ou ajuste antes de registrar a entrega.`,
    )
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

    // antes de marcar a remessa: a conta de qual caixa sai cada animal le a reserva a entregar
    await baixarEstoqueNaEntrega(tx, idSolicitacao, idUsuario)

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

    await liberarCaixasDaEntrega(tx, idSolicitacao, idUsuario)
  })

  return { idSolicitacao, status: statusSolicitacao.paraApi('CO'), dtEntrega }
}

/**
 * Depois da entrega, a caixa do casal sem casal ativo e sem animal dentro libera a posicao. Le as
 * caixas ja com a remessa entregue, dentro da mesma transacao. A caixa de estoque que esvaziou ja
 * foi para Enviado
 */
async function liberarCaixasDaEntrega(
  tx: Prisma.TransactionClient,
  idSolicitacao: number,
  idUsuario: number,
) {
  const caixas = await tx.caixa.findMany({
    where: {
      ativa: true,
      tipo: 'C',
      casais: {
        some: {
          partos: {
            some: { compromissos: { some: { dtCancelamento: null, remessa: { idSolicitacao } } } },
          },
        },
      },
    },
    select: { id: true, casais: { select: { ativo: true } } },
  })

  for (const caixa of caixas) {
    if (!caixa.casais.some((casal) => casal.ativo)) await liberarCaixaVazia(tx, caixa.id, idUsuario)
  }
}

/**
 * POST /api/solicitacoes/:id/recusa - a equipe recusa o pedido que aguarda analise, ou o aprovado
 * que nao deu para produzir. O que ja tem os animais reservados nao e recusado
 */
export function recusarSolicitacao(idSolicitacao: number, motivo: string, idUsuario: number) {
  return recusar(idSolicitacao, motivo, idUsuario, ['EN', 'AT'])
}

/**
 * idUsuario null quando a recusa e automatica, sem ninguem da equipe por tras. 'podeRecusar' sao
 * os status que aceitam a recusa, conferidos de novo na gravacao: o pedido pode mudar no meio
 */
async function recusar(
  idSolicitacao: number,
  motivo: string,
  idUsuario: number | null,
  podeRecusar: string[],
) {
  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id: idSolicitacao },
    include: PARA_O_AVISO,
  })

  if (solicitacao === null) {
    throw naoEncontrado('Solicitacao')
  }

  const naoPode = erroDeRegra(
    'SEQUENCIA_INVALIDA',
    podeRecusar.includes('AT')
      ? `A solicitacao #${idSolicitacao} nao esta aguardando analise nem animais, e nao pode ser recusada.`
      : `A solicitacao #${idSolicitacao} nao esta aguardando analise e nao pode ser recusada.`,
  )

  if (!podeRecusar.includes(solicitacao.status)) {
    throw naoPode
  }

  await prisma.$transaction(async (tx) => {
    const recusada = await tx.solicitacao.updateMany({
      where: { id: idSolicitacao, status: { in: podeRecusar } },
      data: { status: 'RE' },
    })

    if (recusada.count === 0) {
      throw naoPode
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

  avisarPesquisador(solicitacao, (email, pedido) => avisarPedidoDecidido(email, pedido, motivo))

  return { idSolicitacao, status: statusSolicitacao.paraApi('RE'), motivo }
}
