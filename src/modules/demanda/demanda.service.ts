// Projetos CEUA, solicitacoes de animais e a alocacao das caixas que atendem cada uma

import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { prisma } from '../../shared/prisma.ts'
import {
  codigoDaEspecie,
  cronograma,
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
} from '../reproducao/disponibilidade.ts'

/** O pesquisador so ve os proprios projetos e pedidos; tecnico e gestor veem todos */
const doPesquisador = (usuario: UsuarioDaSessao) => usuario.perfil === 'pesquisador'

/** GET /api/projetos */
export async function listarProjetos(usuario: UsuarioDaSessao, agora: Date = new Date()) {
  const hoje = hojeISO(agora)
  const projetos = await prisma.projeto.findMany({
    where: doPesquisador(usuario) ? { idUsuarioResponsavel: usuario.id } : {},
    orderBy: { numero: 'asc' },
  })

  return {
    projetos: projetos.map((projeto) => ({
      id: projeto.id,
      numero: projeto.numero,
      vigente: projeto.situacao === 'V' && dataISO(projeto.dtVigenciaFim) >= hoje,
    })),
  }
}

/** GET /api/solicitacoes */
export async function listarSolicitacoes(usuario: UsuarioDaSessao) {
  const solicitacoes = await prisma.solicitacao.findMany({
    where: doPesquisador(usuario) ? { idUsuarioSolicitante: usuario.id } : {},
    orderBy: { id: 'desc' },
    include: {
      projeto: { select: { numero: true } },
      usuarioSolicitante: { select: { email: true } },
      especie: { select: { nome: true } },
      linhagem: { select: { id: true, nome: true } },
    },
  })

  return {
    solicitacoes: solicitacoes.map((s) => ({
      id: s.id,
      protocoloCeua: s.projeto.numero,
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
      cronograma: cronograma.paraApi(s.regime),
      observacoes: s.observacoes,
      status: statusSolicitacao.paraApi(s.status),
    })),
  }
}

export type NovaSolicitacao = {
  nomePesquisador: string
  /** o numero do projeto em etica.projeto, no formato 23080.XXXXXX/AAAA-XX */
  protocoloCeua: string
  idLinhagem: number
  machos: number
  femeas: number
  qualquer: number
  /** a idade exata vem com idadeMin = idadeMax */
  idadeMin: number
  idadeMax: number
  dataEntrega: string
  cronograma: string
  observacoes: string | null
}

/** 409 do protocolo, com o campo, para o front mostrar a mensagem embaixo dele */
const protocoloInvalido = (mensagem: string) =>
  erroDeRegra('PROJETO_INVALIDO', mensagem, { campos: { protocoloCeua: mensagem } })

/** POST /api/solicitacoes - o pedido do pesquisador, com a primeira remessa */
export async function criarSolicitacao(
  dados: NovaSolicitacao,
  usuario: UsuarioDaSessao,
  agora: Date = new Date(),
) {
  // esta rota nao cria projeto: procura pelo numero o que ja esta no banco
  const projeto = await prisma.projeto.findUnique({ where: { numero: dados.protocoloCeua } })

  if (projeto === null) {
    throw protocoloInvalido('Protocolo CEUA nao encontrado. Confira o numero ou fale com o bioterio.')
  }

  // a cota da CEUA e liberacao por pessoa e projeto, nao saldo (combinado com o cliente em 20/09)
  if (doPesquisador(usuario) && projeto.idUsuarioResponsavel !== usuario.id) {
    throw protocoloInvalido('Este projeto CEUA nao esta no seu nome.')
  }

  if (projeto.situacao !== 'V' || dataISO(projeto.dtVigenciaFim) < hojeISO(agora)) {
    throw protocoloInvalido(`O projeto ${projeto.numero} nao esta vigente.`)
  }

  const linhagem = await prisma.linhagem.findUnique({ where: { id: dados.idLinhagem } })

  if (linhagem === null) {
    throw naoEncontrado('Linhagem')
  }

  const criada = await prisma.$transaction(async (tx) => {
    const solicitacao = await tx.solicitacao.create({
      data: {
        idProjeto: projeto.id,
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
        regime: exigirCodigo(cronograma, dados.cronograma, 'Cronograma'),
        status: 'EN',
        observacoes: dados.observacoes,
      },
    })

    // a remessa so tem machos e femeas previstos: o "qualquer" fica na solicitacao
    await tx.remessa.create({
      data: {
        idSolicitacao: solicitacao.id,
        sequencia: 1,
        dtPrevista: paraData(dados.dataEntrega),
        qtdMPrevista: dados.machos,
        qtdFPrevista: dados.femeas,
      },
    })

    return solicitacao
  })

  return { id: criada.id }
}

export type ItemDeAlocacao = { idParto: number; machos: number; femeas: number }

/**
 * POST /api/solicitacoes/:id/alocacao - o tecnico aceita as caixas da busca. Cada item vira um
 * compromisso com o parto; caixa que estava em Livres vai para Pre-reserva
 */
export async function alocarSolicitacao(
  idSolicitacao: number,
  itens: ItemDeAlocacao[],
  usuario: UsuarioDaSessao,
) {
  const solicitacao = await prisma.solicitacao.findUnique({
    where: { id: idSolicitacao },
    include: { remessas: { orderBy: { sequencia: 'asc' }, take: 1 } },
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

  const partos = await prisma.parto.findMany({
    where: { id: { in: itens.map((item) => item.idParto) } },
    include: {
      casal: { select: { idCaixa: true, linhagem: { select: { idEspecie: true } } } },
      compromissos: compromissosAtivos,
    },
  })

  // confere antes de gravar: nenhum item pode passar do que o parto ainda tem livre
  for (const item of itens) {
    const parto = partos.find((p) => p.id === item.idParto)

    if (parto === undefined || parto.casal.linhagem.idEspecie !== solicitacao.idEspecie) {
      throw naoEncontrado(`Parto ${item.idParto} da especie pedida`)
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

    await tx.solicitacao.update({ where: { id: idSolicitacao }, data: { status: 'AP' } })
  })

  return { idSolicitacao, status: statusSolicitacao.paraApi('AP') }
}
