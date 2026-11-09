// Morte ou eutanasia em qualquer caixa (uma acao so: a baixa) e a anulacao de uma baixa lancada
// por engano

import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { hojeISO } from '../../shared/traducao.ts'
import type { Prisma } from '@prisma/client'
import { contagemDosPedidos, faltasDosPedidos, ninhadasNaCaixa } from './consultas.ts'
import { exigirEstoqueQueRecebe, recusaDoEstoque } from './destino.ts'
import { escolherAnimais, exigirDepoisDaChegada, idadeDoGrupo, pedidosTocados } from './escolha.ts'
import type { Escolhido } from './escolha.ts'
import { caixaLiberada, liberarSeVazia } from './liberacao.ts'
import { lancarOcorrencia } from './ocorrencia.ts'
import { soltosNaAnulacao } from './reserva.ts'
import { ROTULO_DO_SEXO, contarPorSexo, sexoDe } from './tipos.ts'
import type { PorSexo, Sexo } from './tipos.ts'
import { travarCaixas, travarPedidos } from './travas.ts'

// ------------------------------------------------------------ baixa

export type ItemDaBaixa = {
  sexo: Sexo
  qtd: number
  /** So quando a caixa tem mais de uma idade naquele sexo */
  dtNascimento?: string | undefined
  /** De qual pedido saem os reservados, quando os livres nao bastam */
  idPedido?: number | undefined
}

export type Baixa = { dtFato: string; motivo?: string | undefined; itens: ItemDaBaixa[] }

/**
 * POST /api/caixas/:id/baixa - morte ou eutanasia de animais da caixa, de qualquer tipo. Saem
 * primeiro os vivos livres do grupo (sexo e idade), depois os reservados do pedido indicado. A
 * caixa que esvazia e liberada na hora (a de casal, so com o casal encerrado e sem parto
 * pendente), e a resposta diz que pedidos ficaram em falta
 */
export async function registrarBaixa(idCaixa: number, dados: Baixa, idUsuario: number) {
  return prisma.$transaction(async (tx) => {
    await travarCaixas(tx, [idCaixa])

    const caixa = await tx.caixa.findUnique({ where: { id: idCaixa }, select: { codigo: true, ativa: true } })

    if (caixa === null) throw naoEncontrado('Caixa')
    if (!caixa.ativa) throw caixaLiberada(caixa.codigo)

    const escolhidos: Escolhido[] = []
    const baixas: PorSexo = { m: 0, f: 0 }

    for (const [indice, item] of dados.itens.entries()) {
      const dtNascimento = await idadeDoGrupo(tx, idCaixa, item.sexo, item.dtNascimento, `itens.${indice}.dtNascimento`)

      const doItem = await escolherAnimais(tx, { idCaixa, sexo: item.sexo, dtNascimento }, item.qtd, {
        idPedido: item.idPedido,
        excluir: escolhidos.map((animal) => animal.id),
        campoDoPedido: `itens.${indice}.idPedido`,
      })

      escolhidos.push(...doItem)
      if (item.sexo === 'M') baixas.m += doItem.length
      else baixas.f += doItem.length
    }

    exigirDepoisDaChegada('dtFato', dados.dtFato, escolhidos)

    await lancarOcorrencia(tx, {
      tipo: 'baixa',
      dtFato: dados.dtFato,
      idUsuario,
      idCaixa,
      motivo: dados.motivo,
      ids: escolhidos.map((animal) => animal.id),
    })

    const liberada = await liberarSeVazia(tx, idCaixa, dados.dtFato, 'baixa', idUsuario)

    return { baixas, liberada, faltas: await faltasDosPedidos(tx, pedidosTocados(escolhidos)) }
  })
}

// ------------------------------------------------------------ anulacao

export type AnulacaoDeBaixa = {
  motivo: string
  /** Para onde os animais voltam quando a caixa da baixa nao serve mais (caixaDaVolta) */
  idCaixa?: number | undefined
}

/** Um animal da baixa a anular, com o que decide para onde ele volta */
type AnimalDaBaixa = {
  id: number
  sexo: Sexo
  idPedido: number | null
  idParto: number
  desmamado: boolean
  idLinhagem: number
}

/** A caixa onde a baixa aconteceu, com o que decide se os animais voltam para ela */
type CaixaDaBaixa = {
  id: number
  codigo: string
  ativa: boolean
  tipo: string
  sexo: string | null
  idLinhagem: number | null
}

/**
 * Por que a caixa da baixa nao recebe a volta dos animais, ou null se recebe. A liberada nao volta.
 * A de casal nao recebe quando ja tem vivos de outro parto: duas ninhadas nao dividem a caixa (a
 * mesma regra do nascimento). A de estoque, tambem a de casal que virou estoque depois da baixa,
 * so recebe desmamados do sexo e da linhagem dela
 */
async function porQueNaoVolta(
  tx: Prisma.TransactionClient,
  origem: CaixaDaBaixa,
  animais: AnimalDaBaixa[],
): Promise<string | null> {
  if (!origem.ativa) return 'ja foi liberada'

  if (origem.tipo === 'casal') {
    const partos = new Set(animais.map((animal) => animal.idParto))
    const outra = (await ninhadasNaCaixa(tx, origem.id)).find((ninhada) => !partos.has(ninhada.idParto))

    return outra === undefined ? null : `tem agora a ninhada do ${outra.ordem}o parto do casal ${outra.casal}`
  }

  const cabem = animais.every((animal) => animal.desmamado && recusaDoEstoque(origem, animal) === null)

  return cabem ? null : `agora e caixa de estoque de ${ROTULO_DO_SEXO[sexoDe({ sexo: origem.sexo ?? '' })]}`
}

/**
 * A caixa para onde os animais da baixa voltam: a deles, se continua ativa e cabe neles
 * (porQueNaoVolta); senao, a indicada, de estoque. Sair da caixa do casal, so depois do desmame
 */
async function caixaDaVolta(
  tx: Prisma.TransactionClient,
  origem: CaixaDaBaixa,
  indicada: number | undefined,
  animais: AnimalDaBaixa[],
): Promise<number> {
  const estado = await porQueNaoVolta(tx, origem, animais)

  if (estado === null) {
    if (indicada !== undefined && indicada !== origem.id) {
      throw campoInvalido('idCaixa', `A caixa ${origem.codigo} continua ativa: os animais voltam para ela.`)
    }

    return origem.id
  }

  if (!animais.every((animal) => animal.desmamado)) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `Os animais ainda nao desmamaram, e a caixa ${origem.codigo} ${estado}: filhote que mama so fica com a mae.`,
    )
  }

  const sexos = [...new Set(animais.map((animal) => animal.sexo))]
  const [sexo] = sexos
  const [primeiro] = animais

  if (sexo === undefined || primeiro === undefined || sexos.length > 1) {
    throw campoInvalido(
      'idCaixa',
      `A caixa ${origem.codigo} ${estado}, e a baixa tem machos e femeas: cada caixa de estoque guarda um sexo so, e a anulacao devolve os animais para uma caixa so.`,
    )
  }

  if (indicada === undefined || indicada === origem.id) {
    throw campoInvalido('idCaixa', `A caixa ${origem.codigo} ${estado}: diga para qual caixa de estoque os animais voltam.`)
  }

  await exigirEstoqueQueRecebe(tx, indicada, 'idCaixa', { sexo, idLinhagem: primeiro.idLinhagem })

  return indicada
}

/**
 * POST /api/ocorrencias/:id/anulacao - desfaz uma baixa lancada por engano: os animais voltam a
 * viver na caixa onde estavam, ou na indicada quando ela nao serve mais (caixaDaVolta). A reserva
 * volta junto quando o pedido continua reservado e comporta o animal; senao, ele volta livre. Grava a
 * anulacao apontando a baixa, que so se anula uma vez. E tambem como se corrige a contagem do
 * desmame e da selecao
 */
export async function anularBaixa(idOcorrencia: number, dados: AnulacaoDeBaixa, idUsuario: number) {
  return prisma.$transaction(async (tx) => {
    const baixa = await tx.ocorrencia.findUnique({
      where: { id: idOcorrencia },
      select: {
        tipo: true,
        idParto: true,
        idCaixaOrigem: true,
        anulacao: { select: { id: true } },
        animais: {
          select: {
            animal: {
              select: {
                id: true,
                sexo: true,
                idPedido: true,
                idParto: true,
                parto: { select: { dtDesmameReal: true, casal: { select: { idLinhagem: true } } } },
              },
            },
          },
        },
      },
    })

    if (baixa === null) throw naoEncontrado('Ocorrencia')

    if (baixa.tipo !== 'baixa' || baixa.idCaixaOrigem === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'So a baixa se anula. As outras ocorrencias se corrigem na ficha.')
    }

    if (baixa.anulacao !== null) {
      throw erroDeRegra('OCORRENCIA_JA_ANULADA', 'Esta baixa ja foi anulada. Atualize a ficha.')
    }

    const animais = baixa.animais.map(
      ({ animal }): AnimalDaBaixa => ({
        id: animal.id,
        sexo: sexoDe(animal),
        idPedido: animal.idPedido,
        idParto: animal.idParto,
        desmamado: animal.parto.dtDesmameReal !== null,
        idLinhagem: animal.parto.casal.idLinhagem,
      }),
    )

    await travarCaixas(tx, [baixa.idCaixaOrigem, ...(dados.idCaixa === undefined ? [] : [dados.idCaixa])])

    const origem = await tx.caixa.findUnique({
      where: { id: baixa.idCaixaOrigem },
      select: { id: true, codigo: true, ativa: true, tipo: true, sexo: true, idLinhagem: true },
    })

    if (origem === null) throw naoEncontrado('Caixa')

    const idCaixa = await caixaDaVolta(tx, origem, dados.idCaixa, animais)

    const pedidos = pedidosTocados(animais)
    await travarPedidos(tx, pedidos)
    const soltos = soltosNaAnulacao(animais, await contagemDosPedidos(tx, pedidos))

    await lancarOcorrencia(tx, {
      tipo: 'anulacao',
      dtFato: hojeISO(),
      idUsuario,
      idAnulada: idOcorrencia,
      motivo: dados.motivo,
      idParto: baixa.idParto ?? undefined,
      idCaixaOrigem: origem.id,
      idCaixaDestino: idCaixa === origem.id ? undefined : idCaixa,
      ids: animais.map((animal) => animal.id),
      soltos,
    })

    return { idCaixa, voltaram: contarPorSexo(animais), soltos: soltos.length }
  })
}
