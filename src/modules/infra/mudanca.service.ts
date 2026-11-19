// Os animais mudando de caixa: a passagem da caixa do casal para o estoque, a mudanca de estoque
// para estoque (juntar ou separar caixas) e a caixa do casal encerrado que vira de estoque no
// lugar, sem ninguem sair dela.
//
// Tudo numa transacao, com as caixas travadas (colonia/travas.ts) e os animais escolhidos e
// travados (colonia/escolha.ts): o que se confere e o que se grava e a mesma coisa.

import { agora } from '../../shared/relogio.ts'
import type { Prisma } from '@prisma/client'
import { ErroDeAplicacao, campoInvalido, camposInvalidos, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
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
import { ROTULO_DO_SEXO, SEXOS, doSexo, noNumero, origemDaNinhada, quantosDoSexo } from '../colonia/tipos.ts'
import type { Sexo } from '../colonia/tipos.ts'
import { travarCaixas } from '../colonia/travas.ts'
import { exigirOrdem } from '../reproducao/ordemDasDatas.ts'
import { exigirPosicaoVazia } from './posicao.ts'
import type { PosicaoNaEstante } from './posicao.ts'

type Transacao = Prisma.TransactionClient

// ------------------------------------------------------------ mudanca de animais

/** Para onde vao os animais: uma caixa de estoque que ja existe, ou uma posicao vazia */
export type DestinoDaMudanca = { idCaixa: number } | { posicao: PosicaoNaEstante }

/** Os animais de um sexo que mudam para um destino */
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

/** Um sexo vai todo para uma caixa (um grupo) ou dividido em varias (uma lista, uma parte por caixa) */
export type SexoQueMuda = GrupoQueMuda | GrupoQueMuda[]

export type Mudanca = { dtFato: string; machos?: SexoQueMuda | undefined; femeas?: SexoQueMuda | undefined }

/**
 * Uma parte da mudanca: os animais de um sexo que vao para um destino. 'campo' e o prefixo dos
 * campos dela no formulario: 'machos' no grupo unico, 'machos.1' na segunda parte da lista
 */
export type ParteDaMudanca = GrupoQueMuda & { sexo: Sexo; campo: string }

/** A caixa de onde os animais saem, travada */
type Origem = { id: number; codigo: string; idEspecie: number }

/** O campo do formulario de cada sexo */
const CAMPO: Record<Sexo, string> = { M: 'machos', F: 'femeas' }

/** As partes da mudanca, machos primeiro e na ordem da lista, cada uma com o campo dela */
export function partesDaMudanca(dados: Mudanca): ParteDaMudanca[] {
  return SEXOS.flatMap((sexo) => {
    const oQueMuda = sexo === 'M' ? dados.machos : dados.femeas
    if (oQueMuda === undefined) return []
    if (!Array.isArray(oQueMuda)) return [{ ...oQueMuda, sexo, campo: CAMPO[sexo] }]
    return oQueMuda.map((parte, i) => ({ ...parte, sexo, campo: `${CAMPO[sexo]}.${i}` }))
  })
}

/**
 * A linhagem dos animais escolhidos e a recusa de quem ainda nao desmamou: filhote que mama fica
 * com a mae, e caixa de estoque so recebe desmamado. A chegada na caixa nova e no dia do desmame
 * ou depois (na ninhada do cadastro inicial, o desmame e o dia da entrada)
 */
async function linhagemDosDesmamados(tx: Transacao, escolhidos: Escolhido[], dtFato: string): Promise<number> {
  const partos = await tx.parto.findMany({
    where: { animais: { some: { id: { in: escolhidos.map((animal) => animal.id) } } } },
    orderBy: { id: 'asc' },
    select: { ordem: true, idLinhagem: true, dtDesmameReal: true, casal: { select: { identificacao: true } } },
  })

  const mamando = partos.find((parto) => parto.dtDesmameReal === null)

  if (mamando !== undefined) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `A ninhada ${origemDaNinhada({ ordem: mamando.ordem, casal: mamando.casal?.identificacao.trim() ?? null })} ainda não desmamou: registre o desmame antes de passar os animais para outra caixa.`,
    )
  }

  exigirOrdem('dtFato', dtFato, {
    depoisDe: partos.map((parto) => ({
      evento: parto.ordem === null ? 'da entrada no cadastro inicial' : `do desmame do ${parto.ordem}º parto`,
      data: parto.dtDesmameReal,
    })),
  })

  const [primeiro] = partos
  if (primeiro === undefined) throw naoEncontrado('Parto')

  // dentro de uma caixa os vivos sao de uma linhagem so; se nao forem, o trigger dos animais
  // recusa a caixa de destino
  return primeiro.idLinhagem
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

function chaveDoDestino(destino: DestinoDaMudanca): string {
  if ('idCaixa' in destino) return `caixa ${destino.idCaixa}`

  const { idEstante, face, linha, coluna } = destino.posicao
  return `posicao ${idEstante} ${face} ${linha} ${coluna}`
}

/**
 * Cada parte vai para um destino so dela: duas partes na mesma caixa de estoque ou na mesma
 * posicao vazia e recusa, todas de uma vez, no destino da parte que repete. Do mesmo sexo, as
 * quantidades ficam numa parte so; de sexos diferentes, machos e femeas nao dividem caixa
 */
export function exigirDestinosDiferentes(partes: ParteDaMudanca[]): void {
  const vistos = new Map<string, ParteDaMudanca>()
  const campos: Record<string, string> = {}

  for (const parte of partes) {
    const chave = chaveDoDestino(parte.destino)
    const antes = vistos.get(chave)

    if (antes === undefined) {
      vistos.set(chave, parte)
    } else if (antes.sexo !== parte.sexo) {
      campos[`${parte.campo}.destino`] = 'Machos e fêmeas vão em caixas diferentes.'
    } else {
      const qual = 'idCaixa' in parte.destino ? 'Esta caixa' : 'Esta posição'
      campos[`${parte.campo}.destino`] = `${qual} já está em outra parte: junte as quantidades numa parte só.`
    }
  }

  if (Object.keys(campos).length > 0) throw camposInvalidos(campos)
}

/** Uma parte com a idade ja decidida (idadeDoGrupo): undefined quando o sexo tem uma idade so */
export type ParteComIdade = ParteDaMudanca & { dtNascimento: string | undefined }

/**
 * As partes de cada sexo e idade, somadas, nao passam dos vivos daquele sexo e idade na caixa.
 * Recusa com SEM_ANIMAIS, como a escolha, com a mensagem na quantidade da primeira parte que
 * passa do total. Os reservados ainda podem faltar na escolha de cada parte (escolherAnimais)
 */
export function exigirSomaQueCabe(
  partes: ParteComIdade[],
  ninhadas: Pick<VivosDoParto, 'dtNascimento' | 'vivos'>[],
): void {
  const grupos = new Map<string, ParteComIdade[]>()

  for (const parte of partes) {
    const chave = `${parte.sexo} ${parte.dtNascimento ?? ''}`
    grupos.set(chave, [...(grupos.get(chave) ?? []), parte])
  }

  for (const doGrupo of grupos.values()) {
    const [primeira] = doGrupo
    if (primeira === undefined) continue

    const { sexo, dtNascimento } = primeira
    const ha = ninhadas
      .filter((ninhada) => dtNascimento === undefined || ninhada.dtNascimento === dtNascimento)
      .reduce((soma, ninhada) => soma + doSexo(ninhada.vivos, sexo), 0)
    const soma = doGrupo.reduce((total, parte) => total + parte.qtd, 0)

    if (soma <= ha) continue

    const idades = new Set(ninhadas.filter((ninhada) => doSexo(ninhada.vivos, sexo) > 0).map((ninhada) => ninhada.dtNascimento))
    const onde = idades.size > 1 ? 'nesta caixa e idade' : 'nesta caixa'
    const uma = doGrupo.length === 1
    const mensagem =
      ha === 0
        ? `Não há ${ROTULO_DO_SEXO[sexo]} ${sexo === 'F' ? 'vivas' : 'vivos'} ${onde} para esta mudança.`
        : `${uma ? 'Pediu' : 'As caixas somam'} ${quantosDoSexo(soma, sexo)}, mas só há ${ha} ${onde}.`

    // a primeira parte que, somada as de antes, passa do que ha
    let antes = 0
    for (const parte of doGrupo) {
      if (antes + parte.qtd > ha) {
        const sobram = Math.max(ha - antes, 0)
        const noCampo = uma
          ? `Só há ${ha} ${onde}.`
          : `Passa do total: ${noNumero(sobram, 'sobra', 'sobram')} ${sobram} para esta caixa.`

        throw erroDeRegra('SEM_ANIMAIS', mensagem, { campos: { [`${parte.campo}.qtd`]: noCampo } })
      }
      antes += parte.qtd
    }
  }
}

/**
 * Escolhe e trava os animais da parte, sem repetir os que outra parte ja levou. A falta de
 * animais (os reservados que nao bastam) volta com a mensagem na quantidade da parte
 */
async function escolherDaParte(
  tx: Transacao,
  idOrigem: number,
  parte: ParteComIdade,
  jaEscolhidos: number[],
): Promise<Escolhido[]> {
  const grupo = { idCaixa: idOrigem, sexo: parte.sexo, dtNascimento: parte.dtNascimento }

  try {
    return await escolherAnimais(tx, grupo, parte.qtd, {
      idPedido: parte.idPedido,
      soDoPedido: parte.soDoPedido === true,
      excluir: jaEscolhidos,
      campoDoPedido: `${parte.campo}.idPedido`,
    })
  } catch (erro) {
    if (erro instanceof ErroDeAplicacao && erro.codigo === 'SEM_ANIMAIS' && erro.extras.campos === undefined) {
      throw erroDeRegra('SEM_ANIMAIS', erro.message, { campos: { [`${parte.campo}.qtd`]: erro.message } })
    }
    throw erro
  }
}

/**
 * POST /api/caixas/:id/mudanca - animais desmamados mudam de caixa: da caixa do casal para o
 * estoque (a passagem) ou de uma caixa de estoque para outra, para juntar ou separar. Cada sexo
 * vai todo para uma caixa ou dividido em partes, cada parte para uma caixa de estoque que ja
 * existe ou para uma nova, numa posicao vazia. Duas partes nunca vao para o mesmo destino
 * (exigirDestinosDiferentes) e a soma nao passa dos vivos (exigirSomaQueCabe). Em cada parte saem
 * os livres primeiro e, se nao bastarem, os reservados do pedido indicado (escolherAnimais); com
 * soDoPedido, so os reservados dele. A reserva vai junto. Tudo ou nada, numa transacao so. A caixa
 * de onde sairam e liberada se esvaziou (a de casal, so com o casal encerrado e sem parto
 * pendente). Devolve uma caixa por parte, na ordem das partes
 */
export async function registrarMudanca(idOrigem: number, dados: Mudanca, idUsuario: number) {
  const partes = partesDaMudanca(dados)
  exigirDestinosDiferentes(partes)

  return prisma.$transaction(async (tx) => {
    const destinosQueExistem = partes.flatMap((parte) => ('idCaixa' in parte.destino ? [parte.destino.idCaixa] : []))
    await travarCaixas(tx, [idOrigem, ...destinosQueExistem])

    const origem = await tx.caixa.findUnique({
      where: { id: idOrigem },
      select: { id: true, codigo: true, ativa: true, idEspecie: true },
    })

    if (origem === null) throw naoEncontrado('Caixa')
    if (!origem.ativa) throw caixaLiberada(origem.codigo)

    // a idade de cada parte, decidida antes de qualquer animal sair da caixa
    const comIdade: ParteComIdade[] = []
    for (const parte of partes) {
      const dtNascimento = await idadeDoGrupo(tx, idOrigem, parte.sexo, parte.dtNascimento, `${parte.campo}.dtNascimento`)
      comIdade.push({ ...parte, dtNascimento })
    }

    exigirSomaQueCabe(comIdade, (await vivosNasCaixas(tx, [idOrigem])).get(idOrigem)?.partos ?? [])

    const caixas: { idCaixa: number; codigo: string; sexo: Sexo; qtd: number }[] = []
    const jaEscolhidos: number[] = []

    for (const parte of comIdade) {
      const escolhidos = await escolherDaParte(tx, idOrigem, parte, jaEscolhidos)
      jaEscolhidos.push(...escolhidos.map((animal) => animal.id))

      exigirDepoisDaChegada('dtFato', dados.dtFato, escolhidos)
      const idLinhagem = await linhagemDosDesmamados(tx, escolhidos, dados.dtFato)

      const destino = await caixaDeDestino(
        tx,
        origem,
        parte.destino,
        `${parte.campo}.destino`,
        { sexo: parte.sexo, idLinhagem },
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

      caixas.push({ idCaixa: destino.id, codigo: destino.codigo, sexo: parte.sexo, qtd: escolhidos.length })
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
      'O casal desta caixa ainda tem um parto pendente: registre o parto ou feche o parto sem ninhada antes.',
    )
  }

  const [primeira] = caixa.ninhadas
  if (primeira === undefined) return recusa('SEQUENCIA_INVALIDA', 'Não sobrou animal vivo nesta caixa.')

  const mamando = caixa.ninhadas.find((ninhada) => !ninhada.desmamado)
  if (mamando !== undefined) {
    return recusa(
      'CAIXA_COM_ANIMAIS',
      `A ninhada ${origemDaNinhada(mamando)} ainda está em aleitamento nesta caixa: registre o desmame antes.`,
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
      data: { tipo: 'estoque', sexo: virada.sexo, idLinhagem: virada.idLinhagem, dtManutencao: agora() },
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
