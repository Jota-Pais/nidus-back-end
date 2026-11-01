// Projetos CEUA, solicitacoes de animais e a alocacao das caixas que atendem cada uma

import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
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

  if (!linhagem.ativa) {
    throw campoInvalido('idLinhagem', 'Esta linhagem esta inativa.')
  }

  if (dados.dataEntrega < hojeISO(agora)) {
    throw campoInvalido('dataEntrega', 'A data de entrega nao pode estar no passado.')
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

  const totalM = itens.reduce((soma, item) => soma + item.machos, 0)
  const totalF = itens.reduce((soma, item) => soma + item.femeas, 0)

  if (totalM > solicitacao.qtdM || totalF > solicitacao.qtdF) {
    throw campoInvalido(
      'itens',
      `A alocacao passa do pedido (${solicitacao.qtdM} machos, ${solicitacao.qtdF} femeas).`,
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
  })

  return { idSolicitacao, status: statusSolicitacao.paraApi('AP') }
}
