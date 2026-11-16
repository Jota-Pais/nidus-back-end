// A edicao do casal pela ficha: os grupos, a linhagem, a data de formacao e o parto em que ele
// entrou no Nidus, num formulario so e sem motivo. E o engano de digitacao no cadastro, nao um fato
// novo: as regras de manejo (o par de grupos, a linhagem ativa) nao entram, so a integridade dos
// dados, que recusa o que ficaria contraditorio.
//
// Cada campo leva junto o que depende dele:
// - os grupos levam a identificacao (CHECK casal_identificacao_derivada);
// - a linhagem leva os partos do casal (FK composta parto -> casal) e, com eles, os animais, que
//   tiram a linhagem do parto; e as caixas de estoque que so guardam animais deste casal;
// - a formacao leva o acasalamento do 1o parto quando ele era o da formacao (formarCasal copia);
// - o parto de entrada renumera todos os partos do casal pelo mesmo deslocamento.

import type { Prisma } from '@prisma/client'
import { campoInvalido, naoEncontrado } from '../../shared/erros.ts'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { agora } from '../../shared/relogio.ts'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { travarCaixas, travarCasal, travarPedidos, travarParto } from '../colonia/travas.ts'
import { exigirOrdem } from './ordemDasDatas.ts'
import type { Marco } from './ordemDasDatas.ts'
import { MOTIVO_DO_LIMITE_DE_PARTOS, casalFicha } from './reproducao.service.ts'

type Transacao = Prisma.TransactionClient

/** Corpo de PATCH /api/casais/:id: so o que mudou, ao menos um campo */
export type EdicaoDoCasal = {
  idLinhagem?: number | undefined
  grupoMacho?: string | undefined
  grupoFemea?: string | undefined
  dtFormacao?: string | undefined
  /** o parto em que o casal entrou no Nidus, 1 a 5 (o primeiro parto dele no sistema) */
  partoInicial?: number | undefined
}

/** Um parto do casal, como a edicao le. Do casal: tem sempre ordem e acasalamento */
export type PartoDoCasal = {
  id: number
  ordem: number
  dtAcasalamento: Date
  dtPartoReal: Date | null
  dtSemNinhada: Date | null
}

/** A linhagem nova e tudo o que guarda a linhagem dos animais do casal, onde quer que estejam */
export type LinhagemDosAnimais = {
  /** null: a linhagem pedida nao existe */
  nova: { id: number; nome: string; idEspecie: number } | null
  /** os animais dos partos do casal, os anulados inclusive (o pedido conta todos) */
  animais: { idCaixa: number; situacao: string; idPedido: number | null }[]
  /** as caixas de estoque onde estao (ou ficaram) animais do casal, e os de outros partos nelas */
  caixasDeEstoque: { id: number; codigo: string; outros: { vivos: number; total: number } }[]
  /** os pedidos que tem animais do casal: reservados, entregues ou como registro */
  pedidos: { id: number; idLinhagem: number; linhagem: string }[]
}

/** O casal travado e lido, com o que cada campo da edicao confere */
export type RetratoDoCasal = {
  casal: {
    identificacao: string
    grupoMacho: string
    grupoFemea: string
    idLinhagem: number
    linhagem: string
    dtFormacao: Date
    dtEncerramento: Date | null
    motivoEncerramento: string | null
    ativo: boolean
    /** a especie da caixa do casal: a linhagem nova tem de ser dela */
    idEspecie: number
  }
  /** do primeiro ao ultimo, por ordem */
  partos: PartoDoCasal[]
  /** os casais que vieram antes na mesma caixa: o novo so comeca depois do encerramento deles */
  anteriores: { identificacao: string; dtEncerramento: Date | null }[]
  /** so quando a linhagem muda */
  linhagem?: LinhagemDosAnimais | undefined
}

/** O que a edicao grava. Null quando nada muda */
export type PlanoDaEdicao = {
  grupoMacho: string
  grupoFemea: string
  identificacao: string
  dtFormacao: string
  /** a linhagem nova, que leva os partos junto; null se nao muda */
  idLinhagem: number | null
  /** as caixas de estoque que passam para a linhagem nova */
  caixas: number[]
  /** o acasalamento do 1o parto que acompanha a formacao; null se nao acompanha */
  acasalamento: { idParto: number; antes: string; depois: string } | null
  /** os partos renumerados, na ordem em que se gravam: nenhum cai na ordem de outro ainda nao movido */
  ordens: { idParto: number; de: number; para: number }[]
  descricao: string
  antes: Record<string, string | number>
  depois: Record<string, string | number>
}

const ordinal = (ordem: number) => `${ordem}º`

/**
 * A linhagem nova cabe se for da especie da caixa e nada que guarda linhagem ficar contraditorio:
 * a caixa de estoque guarda uma linhagem so (animal do casal junto com vivo de outra ninhada
 * recusa; so com animais do casal, ela muda junto) e o pedido so tem animais da linhagem dele.
 * Devolve as caixas de estoque que mudam junto
 */
function caixasDaLinhagemNova(retrato: RetratoDoCasal, linhagem: LinhagemDosAnimais, idLinhagem: number): number[] {
  const { nova } = linhagem

  if (nova === null || nova.id !== idLinhagem) throw campoInvalido('idLinhagem', 'Linhagem não encontrada.')

  if (nova.idEspecie !== retrato.casal.idEspecie) {
    throw campoInvalido('idLinhagem', 'Esta linhagem não é da espécie da caixa do casal.')
  }

  for (const pedido of linhagem.pedidos) {
    if (pedido.idLinhagem === idLinhagem) continue

    const doPedido = linhagem.animais.filter((animal) => animal.idPedido === pedido.id)
    const reservados = doPedido.filter((animal) => animal.situacao === 'vivo').length

    throw campoInvalido(
      'idLinhagem',
      reservados === doPedido.length
        ? `${reservados === 1 ? '1 animal deste casal está reservado' : `${reservados} animais deste casal estão reservados`} para o pedido #${pedido.id}, de ${pedido.linhagem}. Desfaça a reserva antes de trocar a linhagem.`
        : `O pedido #${pedido.id}, de ${pedido.linhagem}, já tem animais deste casal no registro (entregues, ou mortos quando estavam reservados): a linhagem do casal não pode mais mudar.`,
    )
  }

  const mistas: string[] = []
  const caixas: number[] = []

  for (const caixa of linhagem.caixasDeEstoque) {
    const vivosDoCasal = linhagem.animais.filter(
      (animal) => animal.idCaixa === caixa.id && animal.situacao === 'vivo',
    ).length

    if (vivosDoCasal > 0 && caixa.outros.vivos > 0) mistas.push(caixa.codigo)
    else if (vivosDoCasal > 0 || caixa.outros.total === 0) caixas.push(caixa.id)
  }

  if (mistas.length > 0) {
    const quais = mistas.length === 1 ? `A caixa de estoque ${mistas[0]} tem` : `As caixas de estoque ${mistas.join(', ')} têm`

    throw campoInvalido(
      'idLinhagem',
      `${quais} animais deste casal junto com animais de outra ninhada, e caixa de estoque guarda uma linhagem só. Passe antes os animais deste casal para uma caixa de estoque só deles (Mudar de lugar) e edite de novo.`,
    )
  }

  return caixas
}

/**
 * O deslocamento das ordens para o 1o parto ficar no 'partoInicial', na ordem em que se grava: para
 * cima, do ultimo para o primeiro; para baixo, do primeiro para o ultimo. Recusa o que passa de 5 e
 * o que contradiz o encerramento automatico no 5o parto
 */
function ordensDoPartoInicial(retrato: RetratoDoCasal, partoInicial: number): PlanoDaEdicao['ordens'] {
  const { casal, partos } = retrato
  const [primeiro] = partos
  const ultimo = partos.at(-1)
  if (primeiro === undefined || ultimo === undefined) return []

  const deslocamento = partoInicial - primeiro.ordem
  if (deslocamento === 0) return []

  if (ultimo.ordem + deslocamento > MAX_PARTOS_POR_CASAL) {
    throw campoInvalido(
      'partoInicial',
      `O casal já tem no Nidus do ${ordinal(primeiro.ordem)} ao ${ordinal(ultimo.ordem)} parto: entrando no ${ordinal(partoInicial)}, o último seria o ${ordinal(ultimo.ordem + deslocamento)}, e o casal tem no máximo ${MAX_PARTOS_POR_CASAL} partos.`,
    )
  }

  const nascidos = partos.filter((parto) => parto.dtPartoReal !== null)
  const ultimoNascido = nascidos.at(-1)

  // o casal ativo encerra sozinho no nascimento do 5o parto (registrarNascimento)
  if (casal.ativo && ultimoNascido !== undefined && ultimoNascido.ordem + deslocamento >= MAX_PARTOS_POR_CASAL) {
    throw campoInvalido(
      'partoInicial',
      `Entrando no ${ordinal(partoInicial)}, o parto nascido em ${dataLegivel(dataISO(ultimoNascido.dtPartoReal as Date))} seria o ${ordinal(ultimoNascido.ordem + deslocamento)}, e o casal teria encerrado nele. Encerre o casal antes, ou escolha outro parto.`,
    )
  }

  // e o encerrado sozinho no 5o parto continua com o 5o
  if (
    !casal.ativo &&
    casal.motivoEncerramento === MOTIVO_DO_LIMITE_DE_PARTOS &&
    (ultimoNascido?.ordem ?? 0) + deslocamento < MAX_PARTOS_POR_CASAL
  ) {
    throw campoInvalido(
      'partoInicial',
      `O casal foi encerrado automaticamente ao chegar ao ${ordinal(MAX_PARTOS_POR_CASAL)} parto: entrando no ${ordinal(partoInicial)}, ele teria parado no ${ordinal((ultimoNascido?.ordem ?? 0) + deslocamento)} e o encerramento não teria acontecido. Casal encerrado não reabre: se ele continua acasalando, forme um casal novo.`,
    )
  }

  const emOrdem = deslocamento > 0 ? [...partos].reverse() : partos

  return emOrdem.map((parto) => ({ idParto: parto.id, de: parto.ordem, para: parto.ordem + deslocamento }))
}

/**
 * A formacao nova e o acasalamento do 1o parto que vai com ela, se ele era o da formacao. A
 * formacao vem depois do encerramento do casal que estava antes na caixa e antes do encerramento
 * deste; o acasalamento que acompanha fica antes do parto e do fechamento sem ninhada, e o que
 * nao acompanha limita a formacao
 */
function acasalamentoDaFormacao(retrato: RetratoDoCasal, dtFormacao: string): PlanoDaEdicao['acasalamento'] {
  const { casal, partos, anteriores } = retrato
  const [primeiro] = partos
  const antes = dataISO(casal.dtFormacao)
  const acompanha = primeiro !== undefined && dataISO(primeiro.dtAcasalamento) === antes

  const depoisDe: Marco[] = anteriores.map((anterior) => ({
    evento: `do encerramento do casal ${anterior.identificacao}, que estava antes nesta caixa`,
    data: anterior.dtEncerramento,
  }))
  const antesDe: Marco[] =
    primeiro === undefined
      ? []
      : acompanha
        ? [
            { evento: `do ${ordinal(primeiro.ordem)} parto`, data: primeiro.dtPartoReal },
            { evento: `do fechamento sem ninhada do ${ordinal(primeiro.ordem)} parto`, data: primeiro.dtSemNinhada },
          ]
        : [{ evento: `do acasalamento do ${ordinal(primeiro.ordem)} parto`, data: primeiro.dtAcasalamento }]

  exigirOrdem('dtFormacao', dtFormacao, {
    depoisDe,
    antesDe: [...antesDe, { evento: 'do encerramento do casal', data: casal.dtEncerramento }],
  })

  return acompanha && primeiro !== undefined && dtFormacao !== antes
    ? { idParto: primeiro.id, antes, depois: dtFormacao }
    : null
}

/**
 * O que a edicao grava, conferido contra o casal lido: recusa (com a mensagem no campo) o que
 * deixaria dado contraditorio, e devolve null quando nada muda
 */
export function planejarEdicao(retrato: RetratoDoCasal, dados: EdicaoDoCasal): PlanoDaEdicao | null {
  const { casal, partos } = retrato
  const grupoMacho = dados.grupoMacho ?? casal.grupoMacho
  const grupoFemea = dados.grupoFemea ?? casal.grupoFemea
  const identificacao = `${grupoMacho}${grupoFemea}`
  const formacaoAntes = dataISO(casal.dtFormacao)
  const dtFormacao = dados.dtFormacao ?? formacaoAntes
  const inicialAntes = partos[0]?.ordem ?? 1

  const trocaLinhagem = dados.idLinhagem !== undefined && dados.idLinhagem !== casal.idLinhagem
  const linhagem = trocaLinhagem ? retrato.linhagem : undefined
  if (trocaLinhagem && linhagem === undefined) throw new Error('A linhagem dos animais não foi lida')

  const caixas =
    linhagem !== undefined && dados.idLinhagem !== undefined
      ? caixasDaLinhagemNova(retrato, linhagem, dados.idLinhagem)
      : []
  const acasalamento = dtFormacao === formacaoAntes ? null : acasalamentoDaFormacao(retrato, dtFormacao)
  const ordens = dados.partoInicial === undefined ? [] : ordensDoPartoInicial(retrato, dados.partoInicial)
  const inicialDepois = inicialAntes + ((ordens[0]?.para ?? 0) - (ordens[0]?.de ?? 0))

  const mudancas: string[] = []
  const antes: Record<string, string | number> = {}
  const depois: Record<string, string | number> = {}

  if (identificacao !== casal.identificacao) {
    mudancas.push(`grupos ${casal.identificacao} → ${identificacao}`)
    Object.assign(antes, { grupoMacho: casal.grupoMacho, grupoFemea: casal.grupoFemea })
    Object.assign(depois, { grupoMacho, grupoFemea })
  }

  if (linhagem?.nova) {
    mudancas.push(`linhagem ${casal.linhagem} → ${linhagem.nova.nome}`)
    antes['idLinhagem'] = casal.idLinhagem
    depois['idLinhagem'] = linhagem.nova.id
  }

  if (dtFormacao !== formacaoAntes) {
    const comAcasalamento = acasalamento === null ? '' : ` (com o acasalamento do ${ordinal(inicialAntes)} parto)`
    mudancas.push(`formação ${dataLegivel(formacaoAntes)} → ${dataLegivel(dtFormacao)}${comAcasalamento}`)
    antes['dtFormacao'] = formacaoAntes
    depois['dtFormacao'] = dtFormacao
  }

  if (ordens.length > 0) {
    mudancas.push(`entrou no ${ordinal(inicialAntes)} parto → ${ordinal(inicialDepois)}`)
    antes['partoInicial'] = inicialAntes
    depois['partoInicial'] = inicialDepois
  }

  if (mudancas.length === 0) return null

  return {
    grupoMacho,
    grupoFemea,
    identificacao,
    dtFormacao,
    idLinhagem: trocaLinhagem && dados.idLinhagem !== undefined ? dados.idLinhagem : null,
    caixas,
    acasalamento,
    ordens,
    descricao: `Casal ${casal.identificacao} editado: ${mudancas.join(', ')}`,
    antes,
    depois,
  }
}

// ------------------------------------------------------------ leitura e gravacao

/**
 * A linhagem dos animais do casal: as caixas e os pedidos onde eles estao, travados na ordem de
 * colonia/travas.ts (o casal e os partos ja estao), e os animais de outros partos nas caixas de estoque
 */
async function lerLinhagemDosAnimais(
  tx: Transacao,
  idLinhagem: number,
  idsPartos: number[],
  idCaixaDoCasal: number,
): Promise<LinhagemDosAnimais> {
  const nova = await tx.linhagem.findUnique({
    where: { id: idLinhagem },
    select: { id: true, nome: true, idEspecie: true },
  })
  const animais = await tx.animal.findMany({
    where: { idParto: { in: idsPartos } },
    select: { idCaixa: true, situacao: true, idPedido: true },
  })
  const idsCaixas = [...new Set(animais.map((animal) => animal.idCaixa))]
  const idsPedidos = [...new Set(animais.flatMap((animal) => (animal.idPedido === null ? [] : [animal.idPedido])))]

  await travarCaixas(tx, [idCaixaDoCasal, ...idsCaixas])
  await travarPedidos(tx, idsPedidos)

  const estoques = await tx.caixa.findMany({
    where: { id: { in: idsCaixas }, tipo: 'estoque' },
    select: { id: true, codigo: true },
    orderBy: { id: 'asc' },
  })
  const outros = await tx.animal.findMany({
    where: {
      idCaixa: { in: estoques.map((caixa) => caixa.id) },
      idParto: { notIn: idsPartos },
      situacao: { not: 'anulado' },
    },
    select: { idCaixa: true, situacao: true },
  })
  const pedidos = await tx.pedido.findMany({
    where: { id: { in: idsPedidos } },
    select: { id: true, idLinhagem: true, linhagem: { select: { nome: true } } },
    orderBy: { id: 'asc' },
  })

  return {
    nova,
    animais,
    caixasDeEstoque: estoques.map((caixa) => {
      const nela = outros.filter((animal) => animal.idCaixa === caixa.id)
      return {
        ...caixa,
        outros: { vivos: nela.filter((animal) => animal.situacao === 'vivo').length, total: nela.length },
      }
    }),
    pedidos: pedidos.map((pedido) => ({ id: pedido.id, idLinhagem: pedido.idLinhagem, linhagem: pedido.linhagem.nome })),
  }
}

/** Grava o plano: as ordens, a linhagem (casal e partos num comando so), o casal e o acasalamento */
async function gravarEdicao(tx: Transacao, idCasal: number, plano: PlanoDaEdicao) {
  const quando = agora()

  // uma linha por vez, na ordem do plano: o unique (casal, ordem) e conferido a cada linha
  for (const { idParto, para } of plano.ordens) {
    await tx.parto.update({ where: { id: idParto }, data: { ordem: para, dtManutencao: quando } })
  }

  if (plano.idLinhagem !== null) {
    // a FK composta (id_casal, id_linhagem) do parto e conferida ao fim de cada comando: o casal e
    // os partos mudam no mesmo comando, ou um deles fica apontando para o par que nao existe
    await tx.$executeRaw`
      WITH "casal_editado" AS (
        UPDATE "reproducao"."casal" SET "id_linhagem" = ${plano.idLinhagem}, "dt_manutencao" = ${quando}
         WHERE "id" = ${idCasal}
        RETURNING "id"
      )
      UPDATE "reproducao"."parto" SET "id_linhagem" = ${plano.idLinhagem}, "dt_manutencao" = ${quando}
       WHERE "id_casal" IN (SELECT "id" FROM "casal_editado")`

    if (plano.caixas.length > 0) {
      await tx.caixa.updateMany({
        where: { id: { in: plano.caixas } },
        data: { idLinhagem: plano.idLinhagem, dtManutencao: quando },
      })
    }
  }

  await tx.casal.update({
    where: { id: idCasal },
    data: {
      grupoMacho: plano.grupoMacho,
      grupoFemea: plano.grupoFemea,
      identificacao: plano.identificacao,
      dtFormacao: paraData(plano.dtFormacao),
      dtManutencao: quando,
    },
  })

  if (plano.acasalamento !== null) {
    await tx.parto.update({
      where: { id: plano.acasalamento.idParto },
      data: { dtAcasalamento: paraData(plano.acasalamento.depois), dtManutencao: quando },
    })
  }
}

/**
 * PATCH /api/casais/:id - edita o casal, ativo ou encerrado: o engano de digitacao aparece tambem
 * no casal antigo. Trava o casal e os partos (e, se a linhagem muda, as caixas e os pedidos dos
 * animais), le, confere, grava e registra no historico o antes e o depois
 */
export async function editarCasal(idCasal: number, dados: EdicaoDoCasal, idUsuario: number) {
  await prisma.$transaction(async (tx) => {
    await travarCasal(tx, idCasal)

    const casal = await tx.casal.findUnique({
      where: { id: idCasal },
      select: {
        idCaixa: true,
        identificacao: true,
        grupoMacho: true,
        grupoFemea: true,
        idLinhagem: true,
        dtFormacao: true,
        dtEncerramento: true,
        motivoEncerramento: true,
        ativo: true,
        linhagem: { select: { nome: true } },
        caixa: { select: { idEspecie: true } },
        partos: { select: { id: true }, orderBy: { id: 'asc' } },
      },
    })

    if (casal === null) throw naoEncontrado('Casal')

    for (const { id } of casal.partos) await travarParto(tx, id)

    const lidos = await tx.parto.findMany({
      where: { idCasal },
      orderBy: { ordem: 'asc' },
      select: { id: true, ordem: true, dtAcasalamento: true, dtPartoReal: true, dtSemNinhada: true },
    })
    // o parto de casal tem sempre ordem e acasalamento (CHECK parto_ninhada_sem_casal)
    const partos = lidos.flatMap(({ ordem, dtAcasalamento, ...parto }) =>
      ordem === null || dtAcasalamento === null ? [] : [{ ...parto, ordem, dtAcasalamento }],
    )

    const anteriores =
      dados.dtFormacao === undefined
        ? []
        : await tx.casal.findMany({
            where: { idCaixa: casal.idCaixa, id: { lt: idCasal } },
            select: { identificacao: true, dtEncerramento: true },
          })

    const linhagem =
      dados.idLinhagem === undefined || dados.idLinhagem === casal.idLinhagem
        ? undefined
        : await lerLinhagemDosAnimais(tx, dados.idLinhagem, partos.map((parto) => parto.id), casal.idCaixa)

    const plano = planejarEdicao(
      {
        casal: {
          identificacao: casal.identificacao.trim(),
          grupoMacho: casal.grupoMacho,
          grupoFemea: casal.grupoFemea,
          idLinhagem: casal.idLinhagem,
          linhagem: casal.linhagem.nome,
          dtFormacao: casal.dtFormacao,
          dtEncerramento: casal.dtEncerramento,
          motivoEncerramento: casal.motivoEncerramento,
          ativo: casal.ativo,
          idEspecie: casal.caixa.idEspecie,
        },
        partos,
        anteriores: anteriores.map((anterior) => ({ ...anterior, identificacao: anterior.identificacao.trim() })),
        linhagem,
      },
      dados,
    )

    if (plano === null) return

    await gravarEdicao(tx, idCasal, plano)

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'casal',
      idEntidade: idCasal,
      acao: 'edicao_casal',
      descricao: plano.descricao,
      dados: {
        antes: plano.antes,
        depois: plano.depois,
        ...(plano.acasalamento === null ? {} : { acasalamento: plano.acasalamento }),
        ...(plano.caixas.length === 0 ? {} : { caixas: plano.caixas }),
      },
    })
  })

  return casalFicha(idCasal)
}
