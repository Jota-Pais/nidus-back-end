// Morte ou eutanasia em qualquer caixa (uma acao so: a baixa) e a anulacao de uma baixa lancada
// por engano. A correcao de uma baixa do parto (reproducao/correcao.service.ts) anula e lanca de
// novo pelas pecas daqui

import { ErroDeAplicacao, campoInvalido, camposInvalidos, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import type { Prisma } from '@prisma/client'
import { contagemDosPedidos, faltasDosPedidos, ninhadasNaCaixa } from './consultas.ts'
import { exigirEstoqueQueRecebe, recusaDoEstoque } from './destino.ts'
import { escolherAnimais, exigirDepoisDaChegada, idadeDoGrupo, pedidosTocados } from './escolha.ts'
import type { Escolhido } from './escolha.ts'
import type { CausaDaBaixa } from './causa.ts'
import { caixaLiberada, liberarSeVazia } from './liberacao.ts'
import { lancarOcorrencia } from './ocorrencia.ts'
import { soltosNaAnulacao } from './reserva.ts'
import {
  MOTIVO_DA_ANULACAO,
  MOTIVO_SELECAO,
  ROTULO_DO_SEXO,
  SEXOS,
  contarPorSexo,
  noNumero,
  origemDaNinhada,
  quantosDoSexo,
  sexoDe,
} from './tipos.ts'
import type { PorSexo, Sexo } from './tipos.ts'
import { travarCaixas, travarOcorrencia, travarPedidos } from './travas.ts'

// ------------------------------------------------------------ baixa

export type ItemDaBaixa = {
  sexo: Sexo
  qtd: number
  /** So quando a caixa tem mais de uma idade naquele sexo */
  dtNascimento?: string | undefined
  /** De qual pedido saem os reservados, quando os livres nao bastam */
  idPedido?: number | undefined
}

/** A causa da baixa, como o formulario a chama: quem registra escolhe, sem padrao */
export type TipoDaBaixa = CausaDaBaixa

export type Baixa = {
  dtFato: string
  /** Morte ou eutanasia: vira a causa da ocorrencia. O motivo escrito (se houver) e so o texto */
  tipo: TipoDaBaixa
  /** So na eutanasia: a baixa e a selecao deste parto, a mesma que a ficha da ninhada sempre gravou */
  idParto?: number | undefined
  motivo?: string | undefined
  itens: ItemDaBaixa[]
}

/** O motivo que a baixa grava quando quem registra nao escreve um: o nome da causa */
export const MOTIVO_DO_TIPO: Record<TipoDaBaixa, string> = { morte: 'morte', eutanasia: 'eutanásia' }

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

    const ids = escolhidos.map((animal) => animal.id)
    const selecao = dados.tipo === 'eutanasia' && dados.idParto !== undefined

    if (selecao) {
      const doParto = await tx.animal.count({ where: { id: { in: ids }, idParto: dados.idParto } })
      if (doParto !== ids.length) throw campoInvalido('idParto', 'Os animais não são deste parto.')
    }

    const lancada = await lancarOcorrencia(tx, {
      tipo: 'baixa',
      dtFato: dados.dtFato,
      idUsuario,
      idCaixa,
      causa: dados.tipo,
      idParto: selecao ? dados.idParto : undefined,
      motivo: selecao ? MOTIVO_SELECAO : (dados.motivo ?? MOTIVO_DO_TIPO[dados.tipo]),
      ids,
    })

    const liberada = await liberarSeVazia(tx, idCaixa, dados.dtFato, 'baixa', idUsuario)

    return { idOcorrencia: lancada.idOcorrencia, baixas, liberada, faltas: await faltasDosPedidos(tx, pedidosTocados(escolhidos)) }
  })
}

// ------------------------------------------------------------ anulacao

export type AnulacaoDeBaixa = {
  /** Sem ele, a trilha diz que a baixa foi lancada por engano */
  motivo?: string | undefined
  /** Para onde voltam os machos, quando a caixa da baixa nao serve mais para eles */
  idCaixaMachos?: number | undefined
  /** Para onde voltam as femeas, quando a caixa da baixa nao serve mais para elas */
  idCaixaFemeas?: number | undefined
}

/** O campo do formulario com a caixa de cada sexo */
const CAMPO_DO_DESTINO: Record<Sexo, 'idCaixaMachos' | 'idCaixaFemeas'> = { M: 'idCaixaMachos', F: 'idCaixaFemeas' }

/** Um animal da baixa a anular, com o que decide para onde ele volta */
export type AnimalDaBaixa = {
  id: number
  sexo: Sexo
  idPedido: number | null
  idParto: number
  desmamado: boolean
  idLinhagem: number
}

/** O que se le de cada animal da baixa para decidir para onde ele volta */
export const selecaoDoAnimalDaBaixa = {
  id: true,
  sexo: true,
  idPedido: true,
  idParto: true,
  parto: { select: { dtDesmameReal: true, idLinhagem: true } },
} satisfies Prisma.AnimalSelect

export function animalDaBaixa(animal: Prisma.AnimalGetPayload<{ select: typeof selecaoDoAnimalDaBaixa }>): AnimalDaBaixa {
  return {
    id: animal.id,
    sexo: sexoDe(animal),
    idPedido: animal.idPedido,
    idParto: animal.idParto,
    desmamado: animal.parto.dtDesmameReal !== null,
    idLinhagem: animal.parto.idLinhagem,
  }
}

/** A caixa onde a baixa aconteceu, com o que decide se os animais voltam para ela */
export type CaixaDaBaixa = {
  id: number
  codigo: string
  ativa: boolean
  tipo: string
  sexo: string | null
  idLinhagem: number | null
  /** a correcao da data da baixa nao passa dela */
  dtLiberacao: Date | null
}

export const selecaoDaCaixaDaBaixa = {
  id: true,
  codigo: true,
  ativa: true,
  tipo: true,
  sexo: true,
  idLinhagem: true,
  dtLiberacao: true,
} satisfies Prisma.CaixaSelect

/** Para onde voltou cada sexo da baixa */
export type Volta = { sexo: Sexo; qtd: number; idCaixa: number; codigo: string }

/**
 * Por que a caixa da baixa nao recebe a volta destes animais (os de um sexo), ou null se recebe. A
 * liberada nao volta. A de casal nao recebe quando ja tem vivos de outro parto: duas ninhadas nao
 * dividem a caixa (a mesma regra do nascimento). A de estoque, tambem a de casal que virou estoque
 * depois da baixa, so recebe desmamados do sexo e da linhagem dela
 */
export async function porQueNaoVolta(
  tx: Prisma.TransactionClient,
  origem: CaixaDaBaixa,
  animais: AnimalDaBaixa[],
): Promise<string | null> {
  if (!origem.ativa) return 'já foi liberada'

  if (origem.tipo === 'casal') {
    const partos = new Set(animais.map((animal) => animal.idParto))
    const outra = (await ninhadasNaCaixa(tx, origem.id)).find((ninhada) => !partos.has(ninhada.idParto))

    return outra === undefined ? null : `tem agora a ninhada ${origemDaNinhada(outra)}`
  }

  const cabem = animais.every((animal) => animal.desmamado && recusaDoEstoque(origem, animal) === null)

  return cabem ? null : `virou caixa de estoque de ${ROTULO_DO_SEXO[sexoDe({ sexo: origem.sexo ?? '' })]}`
}

/**
 * Para onde voltam os animais de um sexo da baixa: a caixa onde estavam, se continua servindo para
 * eles (porQueNaoVolta), e entao nenhuma outra pode ser indicada; senao, a caixa de estoque
 * indicada no campo do sexo, que tem de aceitar o sexo e a linhagem deles e ja existir hoje, o dia
 * da volta. Filhote que mama nao sai da caixa da mae
 */
async function caixaDaVolta(
  tx: Prisma.TransactionClient,
  origem: CaixaDaBaixa,
  sexo: Sexo,
  animais: AnimalDaBaixa[],
  indicada: number | undefined,
  dtVolta: string,
): Promise<{ idCaixa: number; codigo: string }> {
  const campo = CAMPO_DO_DESTINO[sexo]
  const quantos = quantosDoSexo(animais.length, sexo)
  const [primeiro] = animais
  const estado = await porQueNaoVolta(tx, origem, animais)

  if (estado === null || primeiro === undefined) {
    if (indicada !== undefined) {
      throw campoInvalido(
        campo,
        `A caixa ${origem.codigo} continua servindo: ${quantos} da baixa ${noNumero(animais.length, 'volta', 'voltam')} para ela.`,
      )
    }

    return { idCaixa: origem.id, codigo: origem.codigo }
  }

  if (!animais.every((animal) => animal.desmamado)) {
    throw erroDeRegra(
      'SEQUENCIA_INVALIDA',
      `${quantos} da baixa ainda ${noNumero(animais.length, 'está em aleitamento', 'estão em aleitamento')}, e a caixa ${origem.codigo} ${estado}: filhote em aleitamento só fica com a mãe.`,
    )
  }

  if (indicada === undefined || indicada === origem.id) {
    throw campoInvalido(
      campo,
      `A caixa ${origem.codigo} ${estado}: diga para qual caixa de estoque ${noNumero(animais.length, 'volta', 'voltam')} ${quantos}.`,
    )
  }

  // os vivos de uma caixa sao de uma linhagem so, e os mortos dela tambem; se nao fossem, o
  // trigger dos animais recusaria a caixa indicada
  const { codigo } = await exigirEstoqueQueRecebe(
    tx,
    indicada,
    campo,
    { sexo, idLinhagem: primeiro.idLinhagem },
    { data: dtVolta, campo, deQue: 'de hoje' },
  )

  return { idCaixa: indicada, codigo }
}

/** A baixa que se anula, lida depois de travada e conferida: e baixa, tem caixa e esta de pe */
export type BaixaAnulavel = {
  id: number
  dtFato: Date
  causa: string | null
  motivo: string | null
  idParto: number | null
  idCaixaOrigem: number
  animais: AnimalDaBaixa[]
}

/**
 * Le a baixa que quem chama ja travou (travarOcorrencia) e confere que ela se anula: existe, e
 * baixa, e ainda nao foi anulada. A anulacao e as correcoes que anulam para lancar de novo leem por
 * aqui
 */
export async function lerBaixaAnulavel(tx: Prisma.TransactionClient, idOcorrencia: number): Promise<BaixaAnulavel> {
  const baixa = await tx.ocorrencia.findUnique({
    where: { id: idOcorrencia },
    select: {
      tipo: true,
      dtFato: true,
      causa: true,
      motivo: true,
      idParto: true,
      idCaixaOrigem: true,
      anulacoes: { select: { id: true }, take: 1 },
      animais: { orderBy: { idAnimal: 'asc' }, select: { animal: { select: selecaoDoAnimalDaBaixa } } },
    },
  })

  if (baixa === null) throw naoEncontrado('Baixa')

  if (baixa.tipo !== 'baixa' || baixa.idCaixaOrigem === null) {
    throw erroDeRegra('SEQUENCIA_INVALIDA', 'Só a baixa se anula.')
  }

  if (baixa.anulacoes.length > 0) {
    throw erroDeRegra('OCORRENCIA_JA_ANULADA', 'Esta baixa já foi anulada. Atualize a tela e tente de novo.')
  }

  return {
    id: idOcorrencia,
    dtFato: baixa.dtFato,
    causa: baixa.causa,
    motivo: baixa.motivo,
    idParto: baixa.idParto,
    idCaixaOrigem: baixa.idCaixaOrigem,
    animais: baixa.animais.map(({ animal }) => animalDaBaixa(animal)),
  }
}

/** A caixa onde a baixa aconteceu, lida depois de travada */
export async function lerCaixaDaBaixa(tx: Prisma.TransactionClient, idCaixa: number): Promise<CaixaDaBaixa> {
  const caixa = await tx.caixa.findUnique({ where: { id: idCaixa }, select: selecaoDaCaixaDaBaixa })

  if (caixa === null) throw naoEncontrado('Caixa')

  return caixa
}

/**
 * Grava a volta dos animais da baixa: uma ocorrencia de anulacao por caixa de destino, todas
 * apontando a baixa, como a mudanca (uma origem, um destino); os dois sexos que voltam para a caixa
 * da baixa ficam numa so. A reserva volta junto quando o pedido continua reservado e comporta o
 * animal; senao, ele volta livre. Devolve os ids dos que voltaram soltos
 */
async function lancarVolta(
  tx: Prisma.TransactionClient,
  baixa: BaixaAnulavel,
  voltas: { idCaixa: number; animais: AnimalDaBaixa[] }[],
  lancamento: { motivo: string; dtVolta: string; idUsuario: number },
): Promise<number[]> {
  const pedidos = pedidosTocados(baixa.animais)
  await travarPedidos(tx, pedidos)
  const soltos = soltosNaAnulacao(baixa.animais, await contagemDosPedidos(tx, pedidos))

  for (const idCaixa of [...new Set(voltas.map((volta) => volta.idCaixa))]) {
    const ids = voltas.filter((volta) => volta.idCaixa === idCaixa).flatMap((volta) => volta.animais.map((a) => a.id))

    await lancarOcorrencia(tx, {
      tipo: 'anulacao',
      dtFato: lancamento.dtVolta,
      idUsuario: lancamento.idUsuario,
      idAnulada: baixa.id,
      motivo: lancamento.motivo,
      idParto: baixa.idParto ?? undefined,
      idCaixaOrigem: baixa.idCaixaOrigem,
      idCaixaDestino: idCaixa === baixa.idCaixaOrigem ? undefined : idCaixa,
      ids,
      soltos: soltos.filter((id) => ids.includes(id)),
    })
  }

  return soltos
}

/**
 * A anulacao que faz parte de uma correcao (da baixa, da contagem do desmame), na transacao de quem
 * corrige, que ja travou a baixa e a caixa dela: os animais voltam vivos para a caixa da baixa na
 * data da propria baixa, e quem corrige lanca logo em seguida a baixa certa. A volta e de passagem,
 * entao nao vai para outra caixa: se a caixa da baixa nao serve mais para os animais (porQueNaoVolta),
 * recusa com a mensagem que 'naoVolta' monta com o codigo da caixa e o motivo. Devolve os animais
 * como ficaram, sem a reserva os que voltaram soltos
 */
export async function anularParaCorrigir(
  tx: Prisma.TransactionClient,
  baixa: BaixaAnulavel,
  origem: CaixaDaBaixa,
  lancamento: { motivo: string; idUsuario: number },
  naoVolta: (caixa: string, estado: string) => string,
): Promise<AnimalDaBaixa[]> {
  const estado = await porQueNaoVolta(tx, origem, baixa.animais)
  if (estado !== null) throw erroDeRegra('SEQUENCIA_INVALIDA', naoVolta(origem.codigo, estado))

  const soltos = await lancarVolta(tx, baixa, [{ idCaixa: origem.id, animais: baixa.animais }], {
    ...lancamento,
    dtVolta: dataISO(baixa.dtFato),
  })

  return baixa.animais.map((animal) => (soltos.includes(animal.id) ? { ...animal, idPedido: null } : animal))
}

/**
 * POST /api/ocorrencias/:id/anulacao - desfaz uma baixa lancada por engano: os animais voltam a
 * viver, cada sexo na caixa onde estava ou, quando ela nao serve mais para ele, na caixa de
 * estoque indicada para o sexo (caixaDaVolta). A reserva volta junto quando o pedido continua
 * reservado e comporta o animal; senao, ele volta livre (lancarVolta). Sem motivo escrito, a trilha
 * diz que a baixa foi lancada por engano. A baixa se anula uma vez so: ela fica travada, e a segunda
 * anulacao ve a primeira. E tambem o Excluir da baixa na edicao do parto
 */
export async function anularBaixa(
  idOcorrencia: number,
  dados: AnulacaoDeBaixa,
  idUsuario: number,
): Promise<{ voltaram: Volta[]; soltos: PorSexo }> {
  return prisma.$transaction(async (tx) => {
    await travarOcorrencia(tx, idOcorrencia)

    const baixa = await lerBaixaAnulavel(tx, idOcorrencia)
    const { animais } = baixa

    const indicadas: Record<Sexo, number | undefined> = { M: dados.idCaixaMachos, F: dados.idCaixaFemeas }

    for (const sexo of SEXOS) {
      if (indicadas[sexo] !== undefined && !animais.some((animal) => animal.sexo === sexo)) {
        throw campoInvalido(CAMPO_DO_DESTINO[sexo], `Esta baixa não tem ${ROTULO_DO_SEXO[sexo]}.`)
      }
    }

    await travarCaixas(tx, [baixa.idCaixaOrigem, ...SEXOS.flatMap((sexo) => indicadas[sexo] ?? [])])

    const origem = await lerCaixaDaBaixa(tx, baixa.idCaixaOrigem)

    const dtVolta = hojeISO()
    const voltas: (Volta & { animais: AnimalDaBaixa[] })[] = []
    // a caixa que falta ou nao serve, de cada sexo, vai junto num 400 so: a tela pede as duas de uma
    // vez, e nao uma depois da outra
    const recusas: Record<string, string> = {}

    for (const sexo of SEXOS) {
      const doSexo = animais.filter((animal) => animal.sexo === sexo)
      if (doSexo.length === 0) continue

      try {
        const destino = await caixaDaVolta(tx, origem, sexo, doSexo, indicadas[sexo], dtVolta)
        voltas.push({ sexo, qtd: doSexo.length, ...destino, animais: doSexo })
      } catch (erro) {
        if (!(erro instanceof ErroDeAplicacao) || erro.status !== 400 || erro.extras.campos === undefined) throw erro
        Object.assign(recusas, erro.extras.campos)
      }
    }

    if (Object.keys(recusas).length > 0) throw camposInvalidos(recusas)

    const soltos = await lancarVolta(tx, baixa, voltas, {
      motivo: dados.motivo ?? MOTIVO_DA_ANULACAO,
      dtVolta,
      idUsuario,
    })

    return {
      voltaram: voltas.map(({ animais: _animais, ...volta }) => volta),
      soltos: contarPorSexo(animais.filter((animal) => soltos.includes(animal.id))),
    }
  })
}
