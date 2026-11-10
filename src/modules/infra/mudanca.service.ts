// Os animais mudando de caixa: a passagem da caixa do casal para o estoque, a mudanca de estoque
// para estoque (juntar ou separar caixas) e a caixa do casal encerrado que vira de estoque no
// lugar, sem ninguem sair dela.
//
// Tudo numa transacao, com as caixas travadas (colonia/travas.ts) e os animais escolhidos e
// travados (colonia/escolha.ts): o que se confere e o que se grava e a mesma coisa.

import type { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import type { CodigoErro } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { vivosNasCaixas } from '../colonia/consultas.ts'
import type { VivosDoParto } from '../colonia/consultas.ts'
import { exigirEstoqueQueRecebe } from '../colonia/destino.ts'
import { escolherAnimais, exigirDepoisDaChegada, idadeDoGrupo } from '../colonia/escolha.ts'
import type { Escolhido } from '../colonia/escolha.ts'
import { caixaLiberada, liberarSeVazia, partoPendente } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import { SEXOS, quantosDoSexo } from '../colonia/tipos.ts'
import type { Sexo } from '../colonia/tipos.ts'
import { travarCaixas } from '../colonia/travas.ts'
import { exigirOrdem } from '../reproducao/ordemDasDatas.ts'
import { exigirPosicaoVazia } from './posicao.ts'
import type { PosicaoNaEstante } from './posicao.ts'

type Transacao = Prisma.TransactionClient

// ------------------------------------------------------------ mudanca de animais

/** Para onde vao os animais: uma caixa de estoque que ja existe, ou uma posicao vazia */
export type DestinoDaMudanca = { idCaixa: number } | { posicao: PosicaoNaEstante }

/** Os animais de um sexo que mudam */
export type GrupoQueMuda = {
  qtd: number
  /** So quando a caixa tem mais de uma idade naquele sexo */
  dtNascimento?: string | undefined
  /**
   * De qual pedido saem os reservados quando os livres nao bastam, como na baixa. Com soDoPedido,
   * o pedido cujos reservados mudam
   */
  idPedido?: number | undefined
  /** Leva so os reservados de idPedido, sem passar pelos livres: juntar numa caixa os de um pedido */
  soDoPedido?: boolean | undefined
  destino: DestinoDaMudanca
}

export type Mudanca = { dtFato: string; machos?: GrupoQueMuda | undefined; femeas?: GrupoQueMuda | undefined }

/** A caixa de onde os animais saem, travada */
type Origem = { id: number; codigo: string; idEspecie: number }

/** O campo do formulario de cada sexo */
const CAMPO: Record<Sexo, string> = { M: 'machos', F: 'femeas' }

/**
 * A linhagem dos animais escolhidos e a recusa de quem ainda nao desmamou: filhote que mama fica
 * com a mae, e caixa de estoque so recebe desmamado. A chegada na caixa nova e no dia do desmame
 * ou depois
 */
async function linhagemDosDesmamados(tx: Transacao, escolhidos: Escolhido[], dtFato: string): Promise<number> {
  const partos = await tx.parto.findMany({
    where: { animais: { some: { id: { in: escolhidos.map((animal) => animal.id) } } } },
    orderBy: { id: 'asc' },
    select: { ordem: true, dtDesmameReal: true, casal: { select: { identificacao: true, idLinhagem: true } } },
  })

  const mamando = partos.find((parto) => parto.dtDesmameReal === null)

  if (mamando !== undefined) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A ninhada do ${mamando.ordem}º parto do casal ${mamando.casal.identificacao.trim()} ainda não desmamou: registre o desmame antes de mudar os animais de caixa.`,
    )
  }

  exigirOrdem('dtFato', dtFato, {
    depoisDe: partos.map((parto) => ({ evento: `do desmame do ${parto.ordem}º parto`, data: parto.dtDesmameReal })),
  })

  const [primeiro] = partos
  if (primeiro === undefined) throw naoEncontrado('Parto')

  // dentro de uma caixa os vivos sao de uma linhagem so; se nao forem, o trigger dos animais
  // recusa a caixa de destino
  return primeiro.casal.idLinhagem
}

/**
 * A caixa que recebe os animais: a de estoque indicada, que tem de aceitar o sexo e a linhagem
 * deles e ja existir na data do fato, ou uma caixa de estoque nova na posicao vazia, com o sexo e
 * a linhagem dos animais
 */
async function caixaDeDestino(
  tx: Transacao,
  origem: Origem,
  destino: DestinoDaMudanca,
  campo: string,
  quem: { sexo: Sexo; idLinhagem: number },
  dtFato: string,
): Promise<{ id: number; codigo: string }> {
  if ('idCaixa' in destino) {
    if (destino.idCaixa === origem.id) throw campoInvalido(campo, 'Os animais já estão nesta caixa.')

    const { codigo } = await exigirEstoqueQueRecebe(tx, destino.idCaixa, campo, quem, { data: dtFato, campo: 'dtFato' })
    return { id: destino.idCaixa, codigo }
  }

  const posicao = await exigirPosicaoVazia(tx, destino.posicao, campo)

  return tx.caixa.create({
    data: {
      idEstante: posicao.estante.id,
      face: posicao.face,
      linha: posicao.linha,
      coluna: posicao.coluna,
      idEspecie: origem.idEspecie,
      tipo: 'estoque',
      sexo: quem.sexo,
      idLinhagem: quem.idLinhagem,
    },
    select: { id: true, codigo: true },
  })
}

/** Machos e femeas nao dividem a caixa de estoque: duas posicoes iguais na mesma mudanca e recusa */
function exigirPosicoesDiferentes(dados: Mudanca): void {
  const [machos, femeas] = [dados.machos?.destino, dados.femeas?.destino]
  if (machos === undefined || femeas === undefined || !('posicao' in machos) || !('posicao' in femeas)) return

  const mesma =
    machos.posicao.idEstante === femeas.posicao.idEstante &&
    machos.posicao.face === femeas.posicao.face &&
    machos.posicao.linha === femeas.posicao.linha &&
    machos.posicao.coluna === femeas.posicao.coluna

  if (mesma) throw campoInvalido('femeas.destino', 'Machos e fêmeas vão em caixas diferentes.')
}

/**
 * POST /api/caixas/:id/mudanca - animais desmamados mudam de caixa: da caixa do casal para o
 * estoque (a passagem) ou de uma caixa de estoque para outra, para juntar ou separar. Machos e
 * femeas, cada sexo para uma caixa de estoque que ja existe ou para uma nova, numa posicao vazia.
 * Saem os livres primeiro e, se nao bastarem, os reservados do pedido indicado (escolherAnimais);
 * com soDoPedido, so os reservados dele. A reserva vai junto. A
 * caixa de onde sairam e liberada se esvaziou (a de casal, so com o casal encerrado e sem parto
 * pendente)
 */
export async function registrarMudanca(idOrigem: number, dados: Mudanca, idUsuario: number) {
  exigirPosicoesDiferentes(dados)

  const grupos = SEXOS.flatMap((sexo) => {
    const grupo = sexo === 'M' ? dados.machos : dados.femeas
    return grupo === undefined ? [] : [{ sexo, campo: CAMPO[sexo], ...grupo }]
  })

  return prisma.$transaction(async (tx) => {
    const destinosQueExistem = grupos.flatMap((grupo) => ('idCaixa' in grupo.destino ? [grupo.destino.idCaixa] : []))
    await travarCaixas(tx, [idOrigem, ...destinosQueExistem])

    const origem = await tx.caixa.findUnique({
      where: { id: idOrigem },
      select: { id: true, codigo: true, ativa: true, idEspecie: true },
    })

    if (origem === null) throw naoEncontrado('Caixa')
    if (!origem.ativa) throw caixaLiberada(origem.codigo)

    const caixas: { idCaixa: number; codigo: string; sexo: Sexo; qtd: number }[] = []

    for (const grupo of grupos) {
      const dtNascimento = await idadeDoGrupo(tx, idOrigem, grupo.sexo, grupo.dtNascimento, `${grupo.campo}.dtNascimento`)

      const escolhidos = await escolherAnimais(tx, { idCaixa: idOrigem, sexo: grupo.sexo, dtNascimento }, grupo.qtd, {
        idPedido: grupo.idPedido,
        soDoPedido: grupo.soDoPedido === true,
        campoDoPedido: `${grupo.campo}.idPedido`,
      })

      exigirDepoisDaChegada('dtFato', dados.dtFato, escolhidos)
      const idLinhagem = await linhagemDosDesmamados(tx, escolhidos, dados.dtFato)

      const destino = await caixaDeDestino(
        tx,
        origem,
        grupo.destino,
        `${grupo.campo}.destino`,
        { sexo: grupo.sexo, idLinhagem },
        dados.dtFato,
      )

      await lancarOcorrencia(tx, {
        tipo: 'mudanca',
        dtFato: dados.dtFato,
        idUsuario,
        idCaixaOrigem: idOrigem,
        idCaixaDestino: destino.id,
        ids: escolhidos.map((animal) => animal.id),
      })

      caixas.push({ idCaixa: destino.id, codigo: destino.codigo, sexo: grupo.sexo, qtd: escolhidos.length })
    }

    const liberada = await liberarSeVazia(tx, idOrigem, dados.dtFato, 'mudanca', idUsuario)

    return { caixas, liberada }
  })
}

// ------------------------------------------------------------ virar caixa de estoque

/** O que decide se a caixa vira de estoque no lugar */
export type CaixaParaVirar = {
  codigo: string
  ativa: boolean
  tipo: string
  casalAtivo: boolean
  partoPendente: boolean
  /** os vivos dela, por parto */
  ninhadas: Pick<VivosDoParto, 'ordem' | 'casal' | 'idLinhagem' | 'desmamado' | 'vivos'>[]
}

export type Virada = { sexo: Sexo; idLinhagem: number } | { recusa: { codigo: CodigoErro; mensagem: string } }

/**
 * Se a caixa do casal vira caixa de estoque no lugar, e com que sexo e linhagem: so a caixa de
 * casal ativa, com o casal encerrado, sem parto pendente e com vivos de um sexo so, de uma
 * linhagem so e todos desmamados. Ninguem sai da caixa: o outro sexo muda antes para outra caixa.
 * A ficha usa a mesma regra para oferecer o botao
 */
export function viradaParaEstoque(caixa: CaixaParaVirar): Virada {
  const recusa = (codigo: CodigoErro, mensagem: string): Virada => ({ recusa: { codigo, mensagem } })

  if (!caixa.ativa) {
    const liberada = caixaLiberada(caixa.codigo)
    return recusa(liberada.codigo, liberada.message)
  }
  if (caixa.tipo !== 'casal') return recusa('CAIXA_DE_ESTOQUE', 'Esta caixa já é de estoque.')
  if (caixa.casalAtivo) return recusa('SEQUENCIA_INVALIDA', 'O casal desta caixa está ativo: encerre o casal antes.')

  if (caixa.partoPendente) {
    return recusa(
      'SEQUENCIA_INVALIDA',
      'O casal desta caixa ainda tem um parto pendente: registre o nascimento ou feche o parto sem ninhada antes.',
    )
  }

  const [primeira] = caixa.ninhadas
  if (primeira === undefined) return recusa('SEQUENCIA_INVALIDA', 'Não sobrou animal vivo nesta caixa.')

  const mamando = caixa.ninhadas.find((ninhada) => !ninhada.desmamado)
  if (mamando !== undefined) {
    return recusa(
      'CAIXA_COM_ANIMAIS',
      `A ninhada do ${mamando.ordem}º parto ainda mama nesta caixa: registre o desmame antes.`,
    )
  }

  if (caixa.ninhadas.some((ninhada) => ninhada.idLinhagem !== primeira.idLinhagem)) {
    return recusa(
      'CAIXA_COM_ANIMAIS',
      'A caixa tem animais de linhagens diferentes: mude uma delas para outra caixa de estoque antes.',
    )
  }

  const machos = caixa.ninhadas.reduce((soma, ninhada) => soma + ninhada.vivos.m, 0)
  const femeas = caixa.ninhadas.reduce((soma, ninhada) => soma + ninhada.vivos.f, 0)

  if (machos > 0 && femeas > 0) {
    return recusa(
      'CAIXA_COM_ANIMAIS',
      'A caixa ainda tem machos e fêmeas: mude um dos sexos para outra caixa de estoque antes.',
    )
  }

  return { sexo: machos > 0 ? 'M' : 'F', idLinhagem: primeira.idLinhagem }
}

/** Le a caixa com o que viradaParaEstoque confere. Null quando a caixa nao existe */
export async function lerCaixaParaVirar(
  banco: Pick<Prisma.TransactionClient, 'caixa' | 'animal' | 'parto' | 'pedido'>,
  idCaixa: number,
): Promise<CaixaParaVirar | null> {
  const caixa = await banco.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      codigo: true,
      ativa: true,
      tipo: true,
      casais: { select: { ativo: true, partos: { where: partoPendente, select: { id: true } } } },
    },
  })

  if (caixa === null) return null

  const naCaixa = (await vivosNasCaixas(banco, [idCaixa])).get(idCaixa)

  return {
    codigo: caixa.codigo,
    ativa: caixa.ativa,
    tipo: caixa.tipo,
    casalAtivo: caixa.casais.some((casal) => casal.ativo),
    partoPendente: caixa.casais.some((casal) => casal.partos.length > 0),
    ninhadas: naCaixa?.partos ?? [],
  }
}

/**
 * POST /api/caixas/:id/estoque - a caixa do casal encerrado vira caixa de estoque no lugar, com o
 * sexo e a linhagem dos vivos que ficaram nela (viradaParaEstoque). Nenhum animal muda; os casais
 * e partos antigos continuam ligados a caixa e aparecem na ficha
 */
export async function virarCaixaDeEstoque(idCaixa: number, idUsuario: number) {
  return prisma.$transaction(async (tx) => {
    await travarCaixas(tx, [idCaixa])

    const caixa = await lerCaixaParaVirar(tx, idCaixa)
    if (caixa === null) throw naoEncontrado('Caixa')

    const virada = viradaParaEstoque(caixa)
    if ('recusa' in virada) throw erroDeRegra(virada.recusa.codigo, virada.recusa.mensagem)

    await tx.caixa.update({
      where: { id: idCaixa },
      data: { tipo: 'estoque', sexo: virada.sexo, idLinhagem: virada.idLinhagem, dtManutencao: new Date() },
    })

    const total = caixa.ninhadas.reduce((soma, ninhada) => soma + ninhada.vivos.m + ninhada.vivos.f, 0)

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'caixa',
      idEntidade: idCaixa,
      acao: 'virar_estoque',
      descricao: `Caixa ${caixa.codigo} virou caixa de estoque com ${quantosDoSexo(total, virada.sexo)}`,
      dados: { sexo: virada.sexo, idLinhagem: virada.idLinhagem, total },
    })

    return { idCaixa, sexo: virada.sexo }
  })
}
