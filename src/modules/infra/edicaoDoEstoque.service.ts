// A edicao da caixa de estoque pela ficha: a linhagem, o sexo e o nascimento dos animais do cadastro
// inicial, num formulario so e sem motivo. E o engano de digitacao no cadastro, nao um fato novo: as
// regras de manejo (a linhagem ativa, a idade minima do estoque) nao entram, so a integridade dos
// dados, que recusa o que ficaria contraditorio.
//
// A caixa de estoque guarda uma linhagem e um sexo, e os animais dela tem os mesmos: a linhagem vem
// do parto do animal, o sexo e de cada animal. Por isso:
// - o animal do cadastro inicial (parto sem casal) se corrige aqui: a linhagem e o nascimento sao do
//   parto dele, a ninhada sem casal; o sexo e dele;
// - o animal de parto de casal se corrige pelo casal (o lapis da ficha do casal, a correcao do
//   nascimento): a caixa que tem algum (vivo, morto ou entregue nela) nao muda de linhagem nem de sexo.
//
// O que cada campo leva junto e o que recusa:
// - a linhagem leva a caixa e as ninhadas sem casal com animais nela. A ninhada e uma so: se ela tem
//   vivos em outra caixa, a outra caixa ficaria com animais de outra linhagem, e recusa. O pedido so
//   tem animais da linhagem dele (como no casal);
// - o sexo leva a caixa e os vivos dela, pela ocorrencia de correcao (a unica porta de escrita no
//   animal). O banco nao muda o sexo do reservado nem do animal que ja saiu (morto, entregue), e a
//   edicao recusa antes, com a mensagem;
// - o nascimento de uma ninhada sem casal muda a idade de todos os animais dela, onde estiverem. Nao
//   passa da entrada no estoque, que e o desmame dela (CHECK parto_datas_em_ordem).

import type { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { agora } from '../../shared/relogio.ts'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { caixaLiberada } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import { noNumero, quantosDoSexo } from '../colonia/tipos.ts'
import type { Sexo } from '../colonia/tipos.ts'
import { travarCaixas, travarParto, travarPedidos } from '../colonia/travas.ts'
import { exigirOrdem } from '../reproducao/ordemDasDatas.ts'
import { montarFicha } from './ficha.service.ts'

type Transacao = Prisma.TransactionClient

/** Corpo de PATCH /api/caixas/:id: so o que mudou, ao menos um campo */
export type EdicaoDoEstoque = {
  idLinhagem?: number | undefined
  sexo?: Sexo | undefined
  /** o nascimento das ninhadas do cadastro inicial (parto sem casal) com animais na caixa */
  nascimentos?: { idParto: number; dtNascimento: string }[] | undefined
}

/** Um animal que esta na caixa ou saiu dela (morto, entregue). O anulado nao existiu e nao conta */
export type AnimalDaCaixa = {
  id: number
  idParto: number
  sexo: string
  situacao: string
  idPedido: number | null
}

/** Um parto com animais na caixa, como a edicao le */
export type PartoDaCaixa = {
  id: number
  /** null: a ninhada sem casal do cadastro inicial */
  ordem: number | null
  casal: string | null
  /** a caixa do casal; null na ninhada sem casal */
  codigoDoCasal: string | null
  dtNascimento: Date
  /** a entrada no estoque (o desmame da ninhada sem casal); o nascimento nao passa dela */
  dtEntrada: Date | null
}

/** A caixa travada e lida, com o que cada campo da edicao confere */
export type RetratoDoEstoque = {
  caixa: {
    codigo: string
    sexo: Sexo
    idLinhagem: number
    linhagem: string
    idEspecie: number
  }
  animais: AnimalDaCaixa[]
  partos: PartoDaCaixa[]
  /** os vivos das ninhadas sem casal desta caixa que estao em outra caixa */
  foraDaCaixa: { idParto: number; codigo: string; vivos: number }[]
  /** so quando a linhagem muda: a nova (null se nao existe) e os pedidos dos animais das ninhadas sem casal */
  linhagem?:
    | {
        nova: { id: number; nome: string; idEspecie: number } | null
        pedidos: { id: number; idLinhagem: number; linhagem: string; reservados: number; total: number }[]
      }
    | undefined
}

/** O que a edicao grava. Null quando nada muda */
export type PlanoDoEstoque = {
  /** a linhagem nova da caixa e das ninhadas sem casal dela; null se nao muda */
  idLinhagem: number | null
  /** as ninhadas sem casal que mudam de linhagem */
  partosDaLinhagem: number[]
  /** o sexo novo da caixa e dos vivos dela; null se nao muda */
  sexo: Sexo | null
  /** os vivos que trocam de sexo, por ninhada (a ocorrencia de correcao e de um parto so) */
  trocas: { idParto: number; ids: number[]; dtNascimento: string }[]
  /** os nascimentos que mudam */
  nascimentos: { idParto: number; antes: string; depois: string }[]
  descricao: string
  antes: Record<string, Prisma.InputJsonValue>
  depois: Record<string, Prisma.InputJsonValue>
}

const ROTULO_DO_SEXO: Record<Sexo, string> = { M: 'machos', F: 'fêmeas' }

/** 'reservado', 'reservadas': concorda com o sexo e o numero dos animais */
function reservadosDoSexo(qtd: number, sexo: Sexo): string {
  return `reservad${sexo === 'F' ? 'a' : 'o'}${qtd === 1 ? '' : 's'}`
}

const semCasal = (parto: PartoDaCaixa) => parto.ordem === null || parto.casal === null

/** '3 do 1º parto do casal AB, caixa T1I', como a ficha diz a origem */
function origemDoCasal(parto: PartoDaCaixa, animais: AnimalDaCaixa[]): string {
  const qtd = animais.filter((animal) => animal.idParto === parto.id).length
  return `${qtd} do ${parto.ordem}º parto do casal ${parto.casal}, caixa ${parto.codigoDoCasal ?? '—'}`
}

/**
 * Os animais de parto de casal na caixa tiram a linhagem e o nascimento do casal, e o sexo deles se
 * corrige no parto: a caixa que tem algum nao muda. A mensagem diz de onde eles vieram
 */
function exigirSoDoCadastro(retrato: RetratoDoEstoque, campo: string, oQue: string): void {
  const doCasal = retrato.partos.filter((parto) => !semCasal(parto))
  if (doCasal.length === 0) return

  const quais = doCasal.map((parto) => origemDoCasal(parto, retrato.animais)).join('; ')

  throw campoInvalido(
    campo,
    `A caixa tem animais de casal (${quais}), e ${oQue} deles vem do casal: corrija pela ficha do casal. Aqui se corrige só o que veio do cadastro inicial.`,
  )
}

/**
 * A linhagem nova cabe se for da especie da caixa, se a caixa so tem animais do cadastro inicial,
 * se nenhuma ninhada dela tem vivos em outra caixa e se nenhum pedido fica com animal de outra
 * linhagem. Devolve as ninhadas que mudam junto
 */
function partosDaLinhagemNova(retrato: RetratoDoEstoque, idLinhagem: number): number[] {
  const linhagem = retrato.linhagem
  if (linhagem === undefined) throw new Error('A linhagem nova não foi lida')

  const { nova } = linhagem
  if (nova === null || nova.id !== idLinhagem) throw campoInvalido('idLinhagem', 'Linhagem não encontrada.')

  if (nova.idEspecie !== retrato.caixa.idEspecie) {
    throw campoInvalido('idLinhagem', 'Esta linhagem não é da espécie da caixa.')
  }

  exigirSoDoCadastro(retrato, 'idLinhagem', 'a linhagem')

  if (retrato.foraDaCaixa.length > 0) {
    const onde = retrato.foraDaCaixa
      .map((fora) => `${fora.vivos} ${noNumero(fora.vivos, 'está', 'estão')} na caixa ${fora.codigo}`)
      .join(', ')

    throw campoInvalido(
      'idLinhagem',
      `A linhagem é da ninhada do cadastro inicial inteira, e animais dela estão em outra caixa (${onde}). Junte a ninhada numa caixa só (Passar para outra caixa) e edite de novo.`,
    )
  }

  for (const pedido of linhagem.pedidos) {
    if (pedido.idLinhagem === idLinhagem) continue

    throw campoInvalido(
      'idLinhagem',
      pedido.reservados === pedido.total
        ? `${pedido.reservados === 1 ? '1 animal desta caixa está reservado' : `${pedido.reservados} animais desta caixa estão reservados`} para o pedido #${pedido.id}, de ${pedido.linhagem}. Desfaça a reserva antes de trocar a linhagem.`
        : `O pedido #${pedido.id}, de ${pedido.linhagem}, já tem animais desta caixa no registro (entregues, ou mortos quando estavam reservados): a linhagem deles não pode mais mudar.`,
    )
  }

  return retrato.partos.map((parto) => parto.id)
}

/**
 * O sexo novo cabe se a caixa so tem animais do cadastro inicial, todos vivos e livres: o banco
 * nao muda o sexo do reservado (o pedido conta pelo sexo) nem o do animal que ja saiu. Devolve os
 * vivos que trocam, por ninhada
 */
function trocasDeSexo(retrato: RetratoDoEstoque, nascimentos: Map<number, string>): PlanoDoEstoque['trocas'] {
  exigirSoDoCadastro(retrato, 'sexo', 'o sexo')

  const { animais, caixa } = retrato
  const sairam = animais.filter((animal) => animal.situacao !== 'vivo').length

  if (sairam > 0) {
    throw campoInvalido(
      'sexo',
      `${quantosDoSexo(sairam, caixa.sexo)} desta caixa já ${noNumero(sairam, 'saiu', 'saíram')} dela (baixa ou entrega), e o sexo não muda depois da saída. Se a baixa foi lançada errada, anule-a antes.`,
    )
  }

  const reservados = animais.filter((animal) => animal.idPedido !== null)

  if (reservados.length > 0) {
    const pedidos = [...new Set(reservados.map((animal) => `#${animal.idPedido}`))].join(', ')

    throw campoInvalido(
      'sexo',
      `${quantosDoSexo(reservados.length, caixa.sexo)} desta caixa ${noNumero(reservados.length, 'está', 'estão')} ${reservadosDoSexo(reservados.length, caixa.sexo)} (pedido ${pedidos}), e o pedido conta pelo sexo. Desfaça a reserva antes de trocar o sexo.`,
    )
  }

  return retrato.partos.flatMap((parto) => {
    const ids = animais.filter((animal) => animal.idParto === parto.id).map((animal) => animal.id)
    return ids.length === 0
      ? []
      : [{ idParto: parto.id, ids, dtNascimento: nascimentos.get(parto.id) ?? dataISO(parto.dtNascimento) }]
  })
}

/** Os nascimentos que mudam: so de ninhada sem casal desta caixa, e nunca depois da entrada no estoque */
function nascimentosNovos(retrato: RetratoDoEstoque, dados: EdicaoDoEstoque): PlanoDoEstoque['nascimentos'] {
  return (dados.nascimentos ?? []).flatMap(({ idParto, dtNascimento }, indice) => {
    const campo = `nascimentos.${indice}.dtNascimento`
    const parto = retrato.partos.find((daCaixa) => daCaixa.id === idParto)

    if (parto === undefined) throw campoInvalido(campo, 'Esta ninhada não tem animais nesta caixa.')

    if (!semCasal(parto)) {
      throw campoInvalido(
        campo,
        `${origemDoCasal(parto, retrato.animais)}: o nascimento deles é o do parto, e se corrige pela ficha do casal.`,
      )
    }

    exigirOrdem(campo, dtNascimento, { antesDe: [{ evento: 'da entrada no estoque', data: parto.dtEntrada }] })

    const antes = dataISO(parto.dtNascimento)
    return antes === dtNascimento ? [] : [{ idParto, antes, depois: dtNascimento }]
  })
}

/**
 * O que a edicao grava, conferido contra a caixa lida: recusa (com a mensagem no campo) o que
 * deixaria dado contraditorio, e devolve null quando nada muda
 */
export function planejarEdicaoDoEstoque(retrato: RetratoDoEstoque, dados: EdicaoDoEstoque): PlanoDoEstoque | null {
  const { caixa } = retrato
  const trocaLinhagem = dados.idLinhagem !== undefined && dados.idLinhagem !== caixa.idLinhagem
  const trocaSexo = dados.sexo !== undefined && dados.sexo !== caixa.sexo

  const nascimentos = nascimentosNovos(retrato, dados)
  const partosDaLinhagem =
    trocaLinhagem && dados.idLinhagem !== undefined ? partosDaLinhagemNova(retrato, dados.idLinhagem) : []
  const trocas = trocaSexo
    ? trocasDeSexo(retrato, new Map(nascimentos.map((nascimento) => [nascimento.idParto, nascimento.depois])))
    : []

  const mudancas: string[] = []
  const antes: Record<string, Prisma.InputJsonValue> = {}
  const depois: Record<string, Prisma.InputJsonValue> = {}

  if (trocaLinhagem && retrato.linhagem?.nova) {
    mudancas.push(`linhagem ${caixa.linhagem} → ${retrato.linhagem.nova.nome}`)
    antes['idLinhagem'] = caixa.idLinhagem
    depois['idLinhagem'] = retrato.linhagem.nova.id
  }

  if (trocaSexo && dados.sexo !== undefined) {
    mudancas.push(`${ROTULO_DO_SEXO[caixa.sexo]} → ${ROTULO_DO_SEXO[dados.sexo]}`)
    antes['sexo'] = caixa.sexo
    depois['sexo'] = dados.sexo
  }

  if (nascimentos.length > 0) {
    for (const { antes: de, depois: para } of nascimentos) {
      mudancas.push(`nascimento do cadastro inicial ${dataLegivel(de)} → ${dataLegivel(para)}`)
    }
    antes['nascimentos'] = nascimentos.map(({ idParto, antes: de }) => ({ idParto, dtNascimento: de }))
    depois['nascimentos'] = nascimentos.map(({ idParto, depois: para }) => ({ idParto, dtNascimento: para }))
  }

  if (mudancas.length === 0) return null

  return {
    idLinhagem: trocaLinhagem && dados.idLinhagem !== undefined ? dados.idLinhagem : null,
    partosDaLinhagem,
    sexo: trocaSexo && dados.sexo !== undefined ? dados.sexo : null,
    trocas,
    nascimentos,
    descricao: `Caixa de estoque ${caixa.codigo} editada: ${mudancas.join(', ')}`,
    antes,
    depois,
  }
}

// ------------------------------------------------------------ leitura e gravacao

/** Os animais da caixa (vivos e os que sairam dela), sem o registro anulado */
function animaisDaCaixa(tx: Transacao, idCaixa: number) {
  return tx.animal.findMany({
    where: { idCaixa, situacao: { not: 'anulado' } },
    orderBy: { id: 'asc' },
    select: { id: true, idParto: true, sexo: true, situacao: true, idPedido: true },
  })
}

/**
 * Le a caixa e o que a edicao confere: trava os partos dos animais dela, a caixa e as caixas onde
 * estao os vivos das ninhadas sem casal, e os pedidos (a ordem de colonia/travas.ts)
 */
async function lerRetrato(tx: Transacao, idCaixa: number, dados: EdicaoDoEstoque): Promise<RetratoDoEstoque> {
  const primeiros = await animaisDaCaixa(tx, idCaixa)
  for (const idParto of [...new Set(primeiros.map((animal) => animal.idParto))].sort((a, b) => a - b)) {
    await travarParto(tx, idParto)
  }
  await travarCaixas(tx, [idCaixa])

  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      codigo: true,
      ativa: true,
      tipo: true,
      sexo: true,
      idEspecie: true,
      idLinhagem: true,
      linhagem: { select: { nome: true } },
    },
  })

  if (caixa === null) throw naoEncontrado('Caixa')
  if (!caixa.ativa) throw caixaLiberada(caixa.codigo)

  if (caixa.tipo !== 'estoque' || caixa.idLinhagem === null || caixa.linhagem === null) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A caixa ${caixa.codigo} é uma caixa do casal: corrija o casal pelo lápis da ficha dele.`,
    )
  }

  // depois da trava da caixa ninguem poe nem tira animal dela
  const animais = await animaisDaCaixa(tx, idCaixa)
  const idsPartos = [...new Set(animais.map((animal) => animal.idParto))]

  const partos = await tx.parto.findMany({
    where: { id: { in: idsPartos } },
    orderBy: [{ dtPartoReal: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      ordem: true,
      dtPartoReal: true,
      dtDesmameReal: true,
      casal: { select: { identificacao: true, caixa: { select: { codigo: true } } } },
    },
  })
  const idsSemCasal = partos.filter((parto) => parto.casal === null).map((parto) => parto.id)

  const fora = await tx.animal.groupBy({
    by: ['idParto', 'idCaixa'],
    where: { idParto: { in: idsSemCasal }, idCaixa: { not: idCaixa }, situacao: 'vivo' },
    _count: { _all: true },
  })
  const caixasDeFora = await tx.caixa.findMany({
    where: { id: { in: [...new Set(fora.map((linha) => linha.idCaixa))] } },
    select: { id: true, codigo: true },
  })

  const trocaLinhagem = dados.idLinhagem !== undefined && dados.idLinhagem !== caixa.idLinhagem
  let linhagem: RetratoDoEstoque['linhagem']

  if (trocaLinhagem && dados.idLinhagem !== undefined) {
    const nova = await tx.linhagem.findUnique({
      where: { id: dados.idLinhagem },
      select: { id: true, nome: true, idEspecie: true },
    })
    // os animais das ninhadas sem casal, onde estiverem: o pedido guarda os entregues e os mortos
    const comPedido = await tx.animal.findMany({
      where: { idParto: { in: idsSemCasal }, idPedido: { not: null } },
      select: { situacao: true, idPedido: true },
    })
    const idsPedidos = [...new Set(comPedido.flatMap((animal) => (animal.idPedido === null ? [] : [animal.idPedido])))]

    await travarPedidos(tx, idsPedidos)

    const pedidos = await tx.pedido.findMany({
      where: { id: { in: idsPedidos } },
      orderBy: { id: 'asc' },
      select: { id: true, idLinhagem: true, linhagem: { select: { nome: true } } },
    })

    linhagem = {
      nova,
      pedidos: pedidos.map((pedido) => {
        const doPedido = comPedido.filter((animal) => animal.idPedido === pedido.id)
        return {
          id: pedido.id,
          idLinhagem: pedido.idLinhagem,
          linhagem: pedido.linhagem.nome,
          reservados: doPedido.filter((animal) => animal.situacao === 'vivo').length,
          total: doPedido.length,
        }
      }),
    }
  }

  return {
    caixa: {
      codigo: caixa.codigo,
      sexo: caixa.sexo === 'M' ? 'M' : 'F',
      idLinhagem: caixa.idLinhagem,
      linhagem: caixa.linhagem.nome,
      idEspecie: caixa.idEspecie,
    },
    animais,
    // todo parto com animal ja nasceu (trigger do animal)
    partos: partos.map((parto) => ({
      id: parto.id,
      ordem: parto.ordem,
      casal: parto.casal?.identificacao.trim() ?? null,
      codigoDoCasal: parto.casal?.caixa.codigo ?? null,
      dtNascimento: parto.dtPartoReal ?? new Date(0),
      dtEntrada: parto.dtDesmameReal,
    })),
    foraDaCaixa: fora.map((linha) => ({
      idParto: linha.idParto,
      codigo: caixasDeFora.find((outra) => outra.id === linha.idCaixa)?.codigo ?? '',
      vivos: linha._count._all,
    })),
    linhagem,
  }
}

/**
 * Grava o plano: o nascimento e a linhagem das ninhadas sem casal, a caixa e, por ultimo, o sexo
 * dos vivos, que o trigger do animal confere contra o sexo novo da caixa
 */
async function gravarEdicao(tx: Transacao, idCaixa: number, plano: PlanoDoEstoque, idUsuario: number) {
  const quando = agora()

  for (const { idParto, depois } of plano.nascimentos) {
    await tx.parto.update({ where: { id: idParto }, data: { dtPartoReal: paraData(depois), dtManutencao: quando } })
  }

  if (plano.idLinhagem !== null) {
    await tx.parto.updateMany({
      where: { id: { in: plano.partosDaLinhagem } },
      data: { idLinhagem: plano.idLinhagem, dtManutencao: quando },
    })
  }

  if (plano.idLinhagem !== null || plano.sexo !== null) {
    await tx.caixa.update({
      where: { id: idCaixa },
      data: {
        ...(plano.idLinhagem === null ? {} : { idLinhagem: plano.idLinhagem }),
        ...(plano.sexo === null ? {} : { sexo: plano.sexo }),
        dtManutencao: quando,
      },
    })
  }

  if (plano.sexo !== null) {
    for (const troca of plano.trocas) {
      await lancarOcorrencia(tx, {
        tipo: 'correcao',
        // como a troca de sexo da correcao do nascimento: o animal e deste sexo desde que nasceu
        dtFato: troca.dtNascimento,
        idUsuario,
        idParto: troca.idParto,
        motivo: 'sexo corrigido na edição da caixa de estoque',
        trocaDeSexo: { ids: troca.ids, para: plano.sexo },
      })
    }
  }
}

/**
 * PATCH /api/caixas/:id - edita a caixa de estoque ativa: o engano de digitacao do cadastro inicial.
 * Trava, le, confere, grava e registra no historico o antes e o depois. Devolve a ficha
 */
export async function editarCaixaDeEstoque(idCaixa: number, dados: EdicaoDoEstoque, idUsuario: number) {
  await prisma.$transaction(async (tx) => {
    const retrato = await lerRetrato(tx, idCaixa, dados)
    const plano = planejarEdicaoDoEstoque(retrato, dados)

    if (plano === null) return

    await gravarEdicao(tx, idCaixa, plano, idUsuario)

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'edicao_estoque',
      descricao: plano.descricao,
      dados: {
        antes: plano.antes,
        depois: plano.depois,
        ...(plano.partosDaLinhagem.length === 0 ? {} : { partos: plano.partosDaLinhagem }),
      },
    })
  })

  return montarFicha(idCaixa)
}
