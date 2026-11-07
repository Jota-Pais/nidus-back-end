// A caixa de estoque no banco: passar os desmamados da caixa do casal para ela, a caixa do casal
// encerrado virar de estoque no lugar, a ficha, e a retirada na entrega. A conta de onde estao
// os animais de cada reserva fica em estoque.ts

import type { Prisma } from '@prisma/client'
import { ErroDeAplicacao, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, dataISO, estadoCaixa, hojeISO } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { codigoDaPosicao } from './endereco.ts'
import {
  SEXOS,
  colunaDoEstoque,
  naCaixaDoCasal,
  reservadoNaCaixaDoCasal,
  reservadosPorCaixa,
  reservasNosLugares,
  selecaoDoPartoComLugares,
} from './estoque.ts'
import type { Sexo } from './estoque.ts'

type Banco = Prisma.TransactionClient | typeof prisma

const ROTULO_DO_SEXO: Record<Sexo, string> = { M: 'machos', F: 'femeas' }

function campoInvalido(campo: string, mensagem: string) {
  return new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
    campos: { [campo]: mensagem },
  })
}

function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000)
}

// ------------------------------------------------------------ a caixa do casal

/** Os partos de todos os casais da caixa, com onde estao os animais de cada um */
function partosDaCaixaDoCasal(banco: Banco, idCaixa: number) {
  return banco.parto.findMany({
    where: { casal: { idCaixa } },
    orderBy: [{ casal: { dtFormacao: 'asc' } }, { ordem: 'asc' }],
    select: {
      ...selecaoDoPartoComLugares,
      ordem: true,
      dtPartoReal: true,
      casal: { select: { identificacao: true, idLinhagem: true } },
    },
  })
}

/** Uma ninhada que ainda esta na caixa do casal: desmamada, ou mamando */
export type AnimaisNaCaixa = {
  ordem: number
  casal: string
  m: number
  f: number
  desmamado: boolean
  idLinhagem: number
  idParto: number
}

/** O que ainda esta dentro da caixa do casal, por parto. Vazio quando nao sobrou animal */
export async function animaisNaCaixaDoCasal(banco: Banco, idCaixa: number): Promise<AnimaisNaCaixa[]> {
  const partos = await partosDaCaixaDoCasal(banco, idCaixa)

  return partos.flatMap((parto) => {
    const { m, f } = naCaixaDoCasal(parto)
    if (m + f === 0) return []

    return [
      {
        ordem: parto.ordem,
        casal: parto.casal.identificacao.trim(),
        m,
        f,
        desmamado: parto.desmamadoM !== null && parto.desmamadoF !== null,
        idLinhagem: parto.casal.idLinhagem,
        idParto: parto.id,
      },
    ]
  })
}

/**
 * A recusa de usar a caixa do casal para outra ninhada enquanto a de antes esta nela. 'para' e o
 * que se queria fazer: "registrar este parto", "formar casal novo nela"
 */
export function recusaDaCaixaOcupada(presos: AnimaisNaCaixa[], para: string) {
  const [primeiro] = presos
  if (primeiro === undefined) return null

  if (!primeiro.desmamado) {
    return erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      `A ninhada do ${primeiro.ordem}o parto do casal ${primeiro.casal} ainda mama nesta caixa. Registre o desmame e passe os desmamados para o estoque antes de ${para}.`,
    )
  }

  return erroDeRegra(
    'CAIXA_COM_ANIMAIS',
    `A caixa ainda tem ${primeiro.m} M e ${primeiro.f} F desmamados do ${primeiro.ordem}o parto do casal ${primeiro.casal}. Passe para o estoque antes de ${para}.`,
  )
}

/**
 * Leva a caixa do casal para Pre-reserva quando ainda pesa reserva nela, e de volta para Livres
 * quando nao. Reserva cujos animais ja estao em caixa de estoque nao prende a caixa do casal
 */
export async function ajustarColunaDoCasal(
  tx: Prisma.TransactionClient,
  idCaixa: number,
  idUsuario: number | null,
  motivo: string,
) {
  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: { id: true, codigo: true, estado: true, tipo: true, ativa: true },
  })

  if (caixa === null || !caixa.ativa || caixa.tipo !== 'C' || !['R', 'P'].includes(caixa.estado)) return

  const reservado = reservadoNaCaixaDoCasal(await partosDaCaixaDoCasal(tx, idCaixa))
  const depois = reservado > 0 ? 'P' : 'R'
  if (depois === caixa.estado) return

  await tx.caixa.update({ where: { id: idCaixa }, data: { estado: depois } })

  const antes = estadoCaixa.paraApi(caixa.estado)
  const novo = estadoCaixa.paraApi(depois)

  await registrarHistorico(tx, {
    idUsuario,
    entidade: 'caixa',
    idEntidade: idCaixa,
    acao: 'mudanca_de_coluna',
    descricao: `Caixa ${caixa.codigo}: ${antes} -> ${novo}, ${motivo}`,
    dados: { antes, depois: novo },
  })
}

// ------------------------------------------------------------ passar para o estoque

export type Destino =
  | { idCaixa: number }
  | { posicao: { idEstante: number; face: 'frontal' | 'traseira'; linha: number; coluna: number } }

export type Transferencia = { qtd: number; destino: Destino }

export type PassagemParaOEstoque = { machos?: Transferencia | undefined; femeas?: Transferencia | undefined }

/** A caixa de estoque ativa, com a linhagem dos animais que ja estao nela */
async function caixaDeEstoque(banco: Banco, idCaixa: number) {
  const caixa = await banco.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      id: true,
      codigo: true,
      tipo: true,
      sexo: true,
      ativa: true,
      idEspecie: true,
      lotes: { take: 1, select: { parto: { select: { casal: { select: { idLinhagem: true } } } } } },
    },
  })

  if (caixa === null || !caixa.ativa) return null

  return { ...caixa, idLinhagem: caixa.lotes[0]?.parto.casal.idLinhagem ?? null }
}

/** A estante e o endereco de uma posicao vazia. Recusa posicao fora da estante ou ocupada */
async function posicaoVazia(
  banco: Banco,
  campo: string,
  posicao: { idEstante: number; face: 'frontal' | 'traseira'; linha: number; coluna: number },
) {
  const estante = await banco.estante.findFirst({ where: { id: posicao.idEstante, ativa: true } })
  if (estante === null) throw naoEncontrado('Estante')

  const face = posicao.face === 'frontal' ? 1 : 2

  if (face > estante.faces || posicao.linha > estante.linhas || posicao.coluna > estante.colunas) {
    throw campoInvalido(campo, 'Esta posicao nao existe na estante.')
  }

  const ocupante = await banco.caixa.findFirst({
    where: { idEstante: estante.id, face, linha: posicao.linha, coluna: posicao.coluna, ativa: true },
    select: { id: true },
  })

  if (ocupante !== null) throw campoInvalido(campo, 'Esta posicao ja tem uma caixa.')

  return {
    idEstante: estante.id,
    face,
    linha: posicao.linha,
    coluna: posicao.coluna,
    codigo: codigoDaPosicao(face, posicao.linha, posicao.coluna, estante.colunas),
  }
}

/**
 * POST /api/partos/:id/estoque - passa desmamados do parto da caixa do casal para caixas de
 * estoque: machos para uma, femeas para outra. O destino e uma caixa de estoque do mesmo sexo,
 * especie e linhagem, ou uma posicao vazia, onde a caixa de estoque nasce
 */
export async function passarParaOEstoque(idParto: number, dados: PassagemParaOEstoque, idUsuario: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    select: {
      ...selecaoDoPartoComLugares,
      ordem: true,
      casal: {
        select: {
          identificacao: true,
          idLinhagem: true,
          idCaixa: true,
          caixa: { select: { codigo: true, idEspecie: true, tipo: true } },
        },
      },
    },
  })

  if (parto === null) throw naoEncontrado('Parto')

  if (parto.desmamadoM === null || parto.desmamadoF === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o desmame antes de passar os animais para o estoque.')
  }

  if (parto.casal.caixa.tipo !== 'C') {
    throw erroDeRegra('CAIXA_DE_ESTOQUE', 'Estes animais ja estao numa caixa de estoque.')
  }

  const naCaixa = naCaixaDoCasal(parto)
  const pedidos = SEXOS.flatMap((sexo) => {
    const transferencia = sexo === 'M' ? dados.machos : dados.femeas
    return transferencia === undefined ? [] : [{ sexo, ...transferencia }]
  })

  if (pedidos.length === 0) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Informe os machos, as femeas ou os dois.')
  }

  const posicoes = new Set<string>()
  const destinos: {
    sexo: Sexo
    qtd: number
    caixa: { id: number; codigo: string } | null
    nova: Awaited<ReturnType<typeof posicaoVazia>> | null
  }[] = []

  for (const pedido of pedidos) {
    const tem = pedido.sexo === 'M' ? naCaixa.m : naCaixa.f

    if (pedido.qtd > tem) {
      throw campoInvalido(
        `qtd${pedido.sexo}`,
        tem === 0
          ? `Nao sobrou ${ROTULO_DO_SEXO[pedido.sexo]} deste parto na caixa do casal.`
          : `So ha ${tem} ${ROTULO_DO_SEXO[pedido.sexo]} deste parto na caixa do casal.`,
      )
    }

    const campo = `destino${pedido.sexo}`

    if ('idCaixa' in pedido.destino) {
      const caixa = await caixaDeEstoque(prisma, pedido.destino.idCaixa)

      if (caixa === null) throw campoInvalido(campo, 'Esta caixa nao existe mais.')
      if (caixa.tipo !== 'E') throw campoInvalido(campo, 'Esta caixa nao e de estoque.')
      if (caixa.sexo !== pedido.sexo) throw campoInvalido(campo, 'Esta caixa de estoque e do outro sexo.')
      if (caixa.idEspecie !== parto.casal.caixa.idEspecie) {
        throw campoInvalido(campo, 'Esta caixa de estoque e de outra especie.')
      }
      if (caixa.idLinhagem !== null && caixa.idLinhagem !== parto.casal.idLinhagem) {
        throw campoInvalido(campo, 'Esta caixa de estoque e de outra linhagem.')
      }

      destinos.push({ ...pedido, caixa: { id: caixa.id, codigo: caixa.codigo }, nova: null })
      continue
    }

    const nova = await posicaoVazia(prisma, campo, pedido.destino.posicao)
    const endereco = `${nova.idEstante}:${nova.codigo}`

    if (posicoes.has(endereco)) {
      throw campoInvalido(campo, 'Machos e femeas vao em caixas diferentes.')
    }

    posicoes.add(endereco)
    destinos.push({ ...pedido, caixa: null, nova })
  }

  const feitas = await prisma.$transaction(async (tx) => {
    const resultado = []

    for (const destino of destinos) {
      const caixa =
        destino.caixa ??
        (await tx.caixa.create({
          data: {
            ...(destino.nova as NonNullable<typeof destino.nova>),
            idEspecie: parto.casal.caixa.idEspecie,
            tipo: 'E',
            sexo: destino.sexo,
            estado: 'E',
          },
          select: { id: true, codigo: true },
        }))

      await tx.lote.upsert({
        where: { idCaixa_idParto: { idCaixa: caixa.id, idParto } },
        create: { idCaixa: caixa.id, idParto, qtd: destino.qtd },
        update: { qtd: { increment: destino.qtd }, dtManutencao: new Date() },
      })

      await registrarHistorico(tx, {
        idUsuario,
        entidade: 'caixa',
        idEntidade: caixa.id,
        acao: 'estoque',
        descricao: `${destino.qtd} ${ROTULO_DO_SEXO[destino.sexo]} do ${parto.ordem}o parto do casal ${parto.casal.identificacao.trim()} (caixa ${parto.casal.caixa.codigo}) passaram para a caixa de estoque ${caixa.codigo}`,
        dados: { idParto, idCaixaDoCasal: parto.casal.idCaixa, sexo: destino.sexo, qtd: destino.qtd },
      })

      resultado.push({ idCaixa: caixa.id, codigo: caixa.codigo, sexo: destino.sexo, qtd: destino.qtd })
    }

    await ajustarColunaDoCasal(tx, parto.casal.idCaixa, idUsuario, 'os reservados foram para o estoque')
    await liberarCaixaDoCasal(tx, parto.casal.idCaixa, idUsuario)

    return resultado
  })

  return { caixas: feitas }
}

/**
 * A caixa de casal ja sem casal ativo e sem animal dentro libera a posicao. Os animais que foram
 * para o estoque continuam la, e a ficha da caixa fica no historico
 */
export async function liberarCaixaDoCasal(
  tx: Prisma.TransactionClient,
  idCaixa: number,
  idUsuario: number | null,
): Promise<boolean> {
  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: { id: true, codigo: true, ativa: true, tipo: true, casais: { select: { ativo: true } } },
  })

  if (caixa === null || !caixa.ativa || caixa.tipo !== 'C' || caixa.casais.some((casal) => casal.ativo)) {
    return false
  }

  if ((await animaisNaCaixaDoCasal(tx, idCaixa)).length > 0) return false

  await tx.caixa.update({ where: { id: caixa.id }, data: { ativa: false, estado: 'R' } })

  await registrarHistorico(tx, {
    idUsuario,
    entidade: 'caixa',
    idEntidade: caixa.id,
    acao: 'liberacao',
    descricao: `Caixa ${caixa.codigo} liberada: o casal encerrou e nao sobrou animal nela`,
  })

  return true
}

// ------------------------------------------------------------ virar caixa de estoque

/**
 * O sexo que a caixa do casal teria se virasse de estoque, ou null se nao pode: tem casal ativo,
 * filhote mamando, machos e femeas juntos, linhagens diferentes ou nenhum animal
 */
export function sexoParaVirarEstoque(temCasalAtivo: boolean, presos: AnimaisNaCaixa[]): Sexo | null {
  if (temCasalAtivo || presos.length === 0 || presos.some((p) => !p.desmamado)) return null
  if (new Set(presos.map((p) => p.idLinhagem)).size > 1) return null

  const m = presos.reduce((soma, p) => soma + p.m, 0)
  const f = presos.reduce((soma, p) => soma + p.f, 0)

  if (m > 0 && f > 0) return null
  return m > 0 ? 'M' : 'F'
}

/**
 * POST /api/caixas/:id/estoque - a caixa do casal encerrado vira caixa de estoque no lugar, com
 * os desmamados que sobraram nela. So com um sexo e uma linhagem: o outro sexo vai antes para
 * outra caixa
 */
export async function virarCaixaDeEstoque(idCaixa: number, idUsuario: number) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    select: { id: true, codigo: true, ativa: true, tipo: true, casais: { select: { ativo: true } } },
  })

  if (caixa === null || !caixa.ativa) throw naoEncontrado('Caixa')

  if (caixa.tipo !== 'C') {
    throw erroDeRegra('CAIXA_DE_ESTOQUE', 'Esta caixa ja e de estoque.')
  }

  if (caixa.casais.some((casal) => casal.ativo)) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'O casal desta caixa esta ativo: encerre o casal antes.')
  }

  const presos = await animaisNaCaixaDoCasal(prisma, idCaixa)

  if (presos.length === 0) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Nao sobrou animal nesta caixa.')
  }

  const mamando = presos.find((p) => !p.desmamado)
  if (mamando !== undefined) {
    throw erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      `A ninhada do ${mamando.ordem}o parto ainda mama nesta caixa: registre o desmame antes.`,
    )
  }

  if (new Set(presos.map((p) => p.idLinhagem)).size > 1) {
    throw erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      'A caixa tem desmamados de linhagens diferentes: passe uma delas para outra caixa de estoque antes.',
    )
  }

  const sexo = sexoParaVirarEstoque(false, presos)

  if (sexo === null) {
    throw erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      'A caixa ainda tem machos e femeas: passe um dos sexos para outra caixa de estoque antes.',
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.caixa.update({ where: { id: idCaixa }, data: { tipo: 'E', sexo, estado: 'E' } })

    for (const preso of presos) {
      await tx.lote.upsert({
        where: { idCaixa_idParto: { idCaixa, idParto: preso.idParto } },
        create: { idCaixa, idParto: preso.idParto, qtd: sexo === 'M' ? preso.m : preso.f },
        update: { qtd: { increment: sexo === 'M' ? preso.m : preso.f }, dtManutencao: new Date() },
      })
    }

    const total = presos.reduce((soma, p) => soma + (sexo === 'M' ? p.m : p.f), 0)

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'estoque',
      descricao: `Caixa ${caixa.codigo} virou caixa de estoque com ${total} ${ROTULO_DO_SEXO[sexo]}`,
      dados: { sexo, total },
    })
  })

  return { idCaixa, sexo }
}

// ------------------------------------------------------------ leitura das caixas de estoque

const selecaoDaCaixaDeEstoque = {
  id: true,
  codigo: true,
  face: true,
  linha: true,
  coluna: true,
  estado: true,
  ativa: true,
  sexo: true,
  dtManutencao: true,
  idEspecie: true,
  estante: { select: { numeroVisivel: true, colunas: true, sala: { select: { nome: true } } } },
  lotes: { orderBy: { id: 'asc' as const }, select: { id: true, idParto: true, qtd: true } },
}

type CaixaDeEstoqueLida = Prisma.CaixaGetPayload<{ select: typeof selecaoDaCaixaDeEstoque }>

/** As caixas de estoque, cada uma com o que tem, o reservado, a coluna e de onde vieram os animais */
export async function lerCaixasDeEstoque(banco: Banco, onde: Prisma.CaixaWhereInput) {
  const caixas: CaixaDeEstoqueLida[] = await banco.caixa.findMany({
    where: { ...onde, tipo: 'E' },
    select: selecaoDaCaixaDeEstoque,
  })

  const idPartos = [...new Set(caixas.flatMap((caixa) => caixa.lotes.map((lote) => lote.idParto)))]
  const partos =
    idPartos.length === 0
      ? []
      : await banco.parto.findMany({
          where: { id: { in: idPartos } },
          select: {
            ...selecaoDoPartoComLugares,
            ordem: true,
            dtPartoReal: true,
            casal: {
              select: {
                identificacao: true,
                linhagem: { select: { nome: true } },
                caixa: { select: { codigo: true, estante: { select: { numeroVisivel: true } } } },
              },
            },
          },
        })

  const reservados = reservadosPorCaixa(partos)
  const partoPorId = new Map(partos.map((parto) => [parto.id, parto]))
  const hoje = hojeISO()

  return caixas.map((caixa) => {
    const lotes = caixa.lotes.flatMap((lote) => {
      const parto = partoPorId.get(lote.idParto)
      if (parto === undefined) return []

      const nascimento = parto.dtPartoReal === null ? null : dataISO(parto.dtPartoReal)

      return [
        {
          idParto: parto.id,
          qtd: lote.qtd,
          ordem: parto.ordem,
          casal: parto.casal.identificacao.trim(),
          linhagem: parto.casal.linhagem.nome,
          origem: { codigo: parto.casal.caixa.codigo, numeroVisivel: parto.casal.caixa.estante.numeroVisivel },
          dtNascimento: nascimento,
          idadeDias: nascimento === null ? null : diasEntre(nascimento, hoje),
        },
      ]
    })

    const comAnimal = lotes.filter((lote) => lote.qtd > 0)
    const total = comAnimal.reduce((soma, lote) => soma + lote.qtd, 0)
    const reservado = Math.min(total, reservados.get(caixa.id) ?? 0)
    const nascimentos = comAnimal.flatMap((lote) => (lote.dtNascimento === null ? [] : [lote.dtNascimento])).sort()

    return {
      id: caixa.id,
      codigo: codigoDaPosicao(caixa.face, caixa.linha, caixa.coluna, caixa.estante.colunas),
      numeroVisivel: caixa.estante.numeroVisivel,
      sala: caixa.estante.sala.nome,
      idEspecie: caixa.idEspecie,
      sexo: caixa.sexo as Sexo,
      linhagem: lotes[0]?.linhagem ?? null,
      total,
      reservado,
      livre: total - reservado,
      // so a coluna gravada sabe que ja foi enviada; Estoque ou Reserva sai das reservas
      estado: caixa.estado === 'X' ? ('X' as const) : colunaDoEstoque(total, reservado),
      enviadaEm: caixa.estado === 'X' && caixa.dtManutencao !== null ? caixa.dtManutencao.toISOString() : null,
      nascimentoDe: nascimentos[0] ?? null,
      nascimentoAte: nascimentos.at(-1) ?? null,
      lotes,
    }
  })
}

export type CaixaDeEstoque = Awaited<ReturnType<typeof lerCaixasDeEstoque>>[number]

/** GET /api/partos/:id/destinos-do-estoque - as caixas de estoque que recebem os desmamados do parto */
export async function destinosDoEstoque(idParto: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    select: { casal: { select: { idLinhagem: true, caixa: { select: { idEspecie: true } } } } },
  })

  if (parto === null) throw naoEncontrado('Parto')

  const caixas = await lerCaixasDeEstoque(prisma, {
    ativa: true,
    idEspecie: parto.casal.caixa.idEspecie,
    lotes: { some: { parto: { casal: { idLinhagem: parto.casal.idLinhagem } } } },
  })

  const paraApi = (caixa: CaixaDeEstoque) => ({
    idCaixa: caixa.id,
    codigo: caixa.codigo,
    numeroVisivel: caixa.numeroVisivel,
    sala: caixa.sala,
    total: caixa.total,
    nascimentoDe: caixa.nascimentoDe,
    nascimentoAte: caixa.nascimentoAte,
  })

  const ordenadas = [...caixas].sort((a, b) => a.numeroVisivel.localeCompare(b.numeroVisivel) || a.codigo.localeCompare(b.codigo))

  return {
    machos: ordenadas.filter((caixa) => caixa.sexo === 'M').map(paraApi),
    femeas: ordenadas.filter((caixa) => caixa.sexo === 'F').map(paraApi),
  }
}

/** A ficha da caixa de estoque: o que tem, de onde veio, o reservado e para quais pedidos */
export async function fichaDoEstoque(idCaixa: number) {
  const [caixa] = await lerCaixasDeEstoque(prisma, { id: idCaixa })
  if (caixa === undefined) throw naoEncontrado('Caixa')

  const especie = await prisma.especie.findUnique({ where: { id: caixa.idEspecie }, select: { nome: true } })
  const pedidos = await pedidosDaCaixaDeEstoque(idCaixa)

  return {
    tipo: 'estoque' as const,
    caixa: {
      id: caixa.id,
      endereco: { numeroVisivel: caixa.numeroVisivel, sala: caixa.sala, codigo: caixa.codigo },
      especie: codigoDaEspecie(especie?.nome ?? ''),
      linhagem: caixa.linhagem,
      estado: estadoCaixa.paraApi(caixa.estado),
      sexo: caixa.sexo,
    },
    total: caixa.total,
    reservado: caixa.reservado,
    livre: caixa.livre,
    nascimentoDe: caixa.nascimentoDe,
    nascimentoAte: caixa.nascimentoAte,
    lotes: caixa.lotes.filter((lote) => lote.qtd > 0),
    pedidos,
  }
}

/** Os pedidos com animais reservados nesta caixa de estoque, e quantos de cada um */
async function pedidosDaCaixaDeEstoque(idCaixa: number) {
  const lotes = await prisma.lote.findMany({ where: { idCaixa }, select: { idParto: true } })
  if (lotes.length === 0) return []

  const partos = await prisma.parto.findMany({
    where: { id: { in: lotes.map((lote) => lote.idParto) } },
    select: selecaoDoPartoComLugares,
  })

  const porPedido = new Map<number, number>()

  for (const parto of partos) {
    for (const sexo of SEXOS) {
      for (const [idReserva, retiradas] of reservasNosLugares(parto, sexo)) {
        const reserva = parto.compromissos.find((c) => c.id === idReserva)
        const aqui = retiradas.filter((r) => r.idCaixa === idCaixa).reduce((soma, r) => soma + r.qtd, 0)
        if (reserva === undefined || aqui === 0) continue

        const pedido = reserva.remessa.idSolicitacao
        porPedido.set(pedido, (porPedido.get(pedido) ?? 0) + aqui)
      }
    }
  }

  return [...porPedido.entries()].sort(([a], [b]) => a - b).map(([idSolicitacao, qtd]) => ({ idSolicitacao, qtd }))
}

// ------------------------------------------------------------ a entrega

/** As retiradas de cada reserva a entregar do pedido, com a caixa de onde sai e o parto */
async function retiradasDoPedido(banco: Banco, idSolicitacao: number) {
  const partos = await banco.parto.findMany({
    where: { compromissos: { some: { dtCancelamento: null, remessa: { idSolicitacao, dtRealizada: null } } } },
    select: {
      ...selecaoDoPartoComLugares,
      ordem: true,
      casal: {
        select: {
          identificacao: true,
          idCaixa: true,
          caixa: { select: { codigo: true, estante: { select: { numeroVisivel: true } } } },
        },
      },
    },
  })

  const retiradas = []

  for (const parto of partos) {
    for (const sexo of SEXOS) {
      const lugares = reservasNosLugares(parto, sexo)

      for (const reserva of parto.compromissos) {
        if (reserva.remessa.idSolicitacao !== idSolicitacao || reserva.remessa.dtRealizada !== null) continue

        for (const retirada of lugares.get(reserva.id) ?? []) {
          retiradas.push({ parto, sexo, ...retirada })
        }
      }
    }
  }

  return retiradas
}

/**
 * GET /api/solicitacoes/:id/retirada - de qual caixa tirar os animais do pedido na entrega, por
 * caixa e sexo. A caixa do casal vem primeiro; e a mesma conta que a entrega usa para descontar
 */
export async function retiradaDaSolicitacao(idSolicitacao: number) {
  const retiradas = await retiradasDoPedido(prisma, idSolicitacao)
  const idsEstoque = [...new Set(retiradas.flatMap((r) => (r.idCaixa === null ? [] : [r.idCaixa])))]
  const caixasDeEstoque =
    idsEstoque.length === 0
      ? []
      : await prisma.caixa.findMany({
          where: { id: { in: idsEstoque } },
          select: { id: true, codigo: true, estante: { select: { numeroVisivel: true } } },
        })

  const porLugar = new Map<
    string,
    {
      tipo: 'casal' | 'estoque'
      codigo: string
      numeroVisivel: string
      sexo: Sexo
      qtd: number
      partos: { ordem: number; casal: string }[]
    }
  >()

  for (const retirada of retiradas) {
    const estoque = caixasDeEstoque.find((c) => c.id === retirada.idCaixa)
    const lugar =
      estoque === undefined
        ? { tipo: 'casal' as const, codigo: retirada.parto.casal.caixa.codigo, numeroVisivel: retirada.parto.casal.caixa.estante.numeroVisivel }
        : { tipo: 'estoque' as const, codigo: estoque.codigo, numeroVisivel: estoque.estante.numeroVisivel }
    const chave = `${lugar.numeroVisivel}:${lugar.codigo}:${retirada.sexo}`
    const parto = { ordem: retirada.parto.ordem, casal: retirada.parto.casal.identificacao.trim() }
    const somado = porLugar.get(chave) ?? { ...lugar, sexo: retirada.sexo, qtd: 0, partos: [] }

    somado.qtd += retirada.qtd
    if (!somado.partos.some((p) => p.ordem === parto.ordem && p.casal === parto.casal)) {
      somado.partos.push(parto)
    }
    porLugar.set(chave, somado)
  }

  return {
    retirada: [...porLugar.values()].sort(
      (a, b) => a.numeroVisivel.localeCompare(b.numeroVisivel) || a.codigo.localeCompare(b.codigo) || a.sexo.localeCompare(b.sexo),
    ),
  }
}

/**
 * Na entrega, desconta das caixas de estoque os animais que saem delas, pela mesma conta da
 * retirada. Roda antes de a remessa ser marcada como entregue. A caixa de estoque que esvazia vai
 * para Enviado e libera a posicao
 */
export async function baixarEstoqueNaEntrega(
  tx: Prisma.TransactionClient,
  idSolicitacao: number,
  idUsuario: number,
) {
  const retiradas = await retiradasDoPedido(tx, idSolicitacao)
  const afetadas = new Set<number>()

  for (const retirada of retiradas) {
    if (retirada.idCaixa === null) continue

    await tx.lote.update({
      where: { idCaixa_idParto: { idCaixa: retirada.idCaixa, idParto: retirada.parto.id } },
      data: { qtd: { decrement: retirada.qtd }, dtManutencao: new Date() },
    })
    afetadas.add(retirada.idCaixa)
  }

  for (const idCaixa of afetadas) {
    const restante = await tx.lote.aggregate({ where: { idCaixa }, _sum: { qtd: true } })
    if ((restante._sum.qtd ?? 0) > 0) continue

    const caixa = await tx.caixa.update({
      where: { id: idCaixa },
      data: { estado: 'X', ativa: false, dtManutencao: new Date() },
      select: { codigo: true },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'mudanca_de_coluna',
      descricao: `Caixa de estoque ${caixa.codigo} esvaziou na entrega da solicitacao #${idSolicitacao} e foi para Enviado`,
      dados: { depois: 'enviado', entrega: idSolicitacao },
    })
  }
}
