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
import { calcularDisponibilidade, parametroNaData } from '../reproducao/disponibilidade.ts'
import { parametrosDaEspecie } from '../reproducao/reproducao.service.ts'

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
      usuarioSolicitante: { select: { nome: true } },
      especie: { select: { nome: true } },
      linhagem: { select: { id: true, nome: true } },
    },
  })

  return {
    solicitacoes: solicitacoes.map((s) => ({
      id: s.id,
      projeto: s.projeto.numero,
      solicitante: s.usuarioSolicitante.nome,
      especie: codigoDaEspecie(s.especie.nome),
      idLinhagem: s.linhagem.id,
      linhagem: s.linhagem.nome,
      machos: s.qtdM,
      femeas: s.qtdF,
      idade: s.idadeAlvoDias,
      dataEntrega: dataISO(s.dtDesejada),
      cronograma: cronograma.paraApi(s.regime),
      status: statusSolicitacao.paraApi(s.status),
    })),
  }
}

export type NovaSolicitacao = {
  idProjeto: number
  idLinhagem: number
  machos: number
  femeas: number
  idade: number
  dataEntrega: string
  cronograma: string
}

/** POST /api/solicitacoes - o pedido do pesquisador, com a primeira remessa */
export async function criarSolicitacao(
  dados: NovaSolicitacao,
  usuario: UsuarioDaSessao,
  agora: Date = new Date(),
) {
  const projeto = await prisma.projeto.findUnique({ where: { id: dados.idProjeto } })

  if (projeto === null) {
    throw naoEncontrado('Projeto')
  }

  // a cota da CEUA e liberacao por pessoa e projeto, nao saldo (combinado com o cliente em 20/09)
  if (doPesquisador(usuario) && projeto.idUsuarioResponsavel !== usuario.id) {
    throw erroDeRegra('PROJETO_INVALIDO', 'Este projeto CEUA nao esta no seu nome.')
  }

  if (projeto.situacao !== 'V' || dataISO(projeto.dtVigenciaFim) < hojeISO(agora)) {
    throw erroDeRegra('PROJETO_INVALIDO', `O projeto ${projeto.numero} nao esta vigente.`)
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
        idEspecie: linhagem.idEspecie,
        idLinhagem: linhagem.id,
        qtdM: dados.machos,
        qtdF: dados.femeas,
        idadeAlvoDias: dados.idade,
        dtDesejada: paraData(dados.dataEntrega),
        regime: exigirCodigo(cronograma, dados.cronograma, 'Cronograma'),
        status: 'EN',
      },
    })

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

  if (solicitacao.status === 'AP') {
    throw erroDeRegra('SOLICITACAO_JA_ALOCADA', `A solicitacao #${idSolicitacao} ja foi alocada.`)
  }

  const remessa = solicitacao.remessas[0]

  if (remessa === undefined) {
    throw naoEncontrado('Remessa da solicitacao')
  }

  const partos = await prisma.parto.findMany({
    where: { id: { in: itens.map((item) => item.idParto) } },
    include: {
      casal: { select: { idCaixa: true, idLinhagem: true, linhagem: { select: { idEspecie: true } } } },
      compromissos: { where: { dtCancelamento: null }, select: { qtdM: true, qtdF: true } },
    },
  })
  const parametros = await parametrosDaEspecie(solicitacao.idEspecie)

  // confere antes de gravar: nenhum item pode passar do que o parto ainda tem livre
  for (const item of itens) {
    const parto = partos.find((p) => p.id === item.idParto)

    if (parto === undefined || parto.casal.linhagem.idEspecie !== solicitacao.idEspecie) {
      throw naoEncontrado(`Parto ${item.idParto} da especie pedida`)
    }

    const parametro = parametroNaData(parametros, {
      idLinhagem: parto.casal.idLinhagem,
      em: dataISO(parto.dtAcasalamento),
    })
    const comprometido = parto.compromissos.reduce(
      (soma, c) => ({ m: soma.m + c.qtdM, f: soma.f + c.qtdF }),
      { m: 0, f: 0 },
    )
    const { disponivel } = calcularDisponibilidade(parto, {
      expectativa: { m: parametro?.expectativaM ?? 4, f: parametro?.expectativaF ?? 4 },
      comprometido,
    })

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
          grauCerteza: parto.grauCerteza,
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
