// Casais e o ciclo dos partos: formar casal, acasalamento, nascimento, eutanasia de selecao,
// desmame, encerramento e o parto que fecha sem ninhada.
//
// Os animais moram em colonia.animal e so mudam por lancarOcorrencia. As regras do casal, do
// parto e da caixa ficam aqui, conferidas na mesma transacao da escrita e com as linhas travadas
// (colonia/travas.ts): casal -> parto -> caixa.

import type { Prisma } from '@prisma/client'
import { ErroDeAplicacao, campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { animaisDoParto, faltasDosPedidos, ninhadasNaCaixa } from '../colonia/consultas.ts'
import type { NinhadaNaCaixa } from '../colonia/consultas.ts'
import { escolherAnimais, exigirDepoisDaChegada, pedidosTocados } from '../colonia/escolha.ts'
import type { Escolhido } from '../colonia/escolha.ts'
import { caixaLiberada, liberarSeVazia, partoPendente } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import { MOTIVO_NAO_CHEGOU_AO_DESMAME, MOTIVO_SELECAO, SEXOS, contarPorSexo, doSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { travarCaixas, travarCasal, travarParto } from '../colonia/travas.ts'
import { cicloFicha } from './cicloFicha.ts'
import { exigirOrdem } from './ordemDasDatas.ts'
import { contarNoDesmame, exigirDataDoDesmame } from './trilhaDoParto.ts'

type Transacao = Prisma.TransactionClient

/**
 * Contagem que passou do limite, com a mensagem no campo de cada sexo que passou
 * ('desmamadoM', 'desmamadoF'...): o formulario destaca o campo certo
 */
export function contagemInvalida(campo: string, passou: { m: boolean; f: boolean }, mensagem: string) {
  return new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
    campos: {
      ...(passou.m ? { [`${campo}M`]: mensagem } : {}),
      ...(passou.f ? { [`${campo}F`]: mensagem } : {}),
    },
  })
}

/**
 * Valida o par genetico ANTES do insert, para dar a mensagem rica
 * ("com macho do grupo A, so e valido o grupo B").
 */
async function validarParGenetico(grupoMacho: string, grupoFemea: string): Promise<void> {
  const par = await prisma.grupoGeneticoPar.findFirst({
    where: { grupoMacho, grupoFemea, ativo: true },
  })

  if (par !== null) {
    return
  }

  const validos = await prisma.grupoGeneticoPar.findMany({
    where: { grupoMacho, ativo: true },
    select: { grupoFemea: true },
  })

  const femeas = validos.map((v) => v.grupoFemea).join(', ')

  throw erroDeRegra(
    'PAR_GENETICO_INVALIDO',
    `O par ${grupoMacho}${grupoFemea} nao esta na rotacao permitida.`,
    {
      campos: {
        grupoFemea:
          femeas.length > 0
            ? `Com macho do grupo ${grupoMacho}, so e valido o grupo ${femeas}.`
            : `O grupo ${grupoMacho} nao tem par valido cadastrado.`,
      },
    },
  )
}

/**
 * O objeto casal da ficha, reaproveitado pelo cadastro, pelo
 * encerramento e pela ficha da posicao (infra/ficha.service.ts).
 */
export async function casalFicha(idCasal: number) {
  const casal = await prisma.casal.findUnique({
    where: { id: idCasal },
    include: { linhagem: { select: { nome: true } } },
  })

  if (casal === null) {
    throw naoEncontrado('Casal')
  }

  return {
    id: casal.id,
    identificacao: casal.identificacao.trim(),
    grupoMacho: casal.grupoMacho,
    grupoFemea: casal.grupoFemea,
    linhagem: casal.linhagem.nome,
    dtFormacao: dataISO(casal.dtFormacao),
    ativo: casal.ativo,
    dtEncerramento: casal.dtEncerramento === null ? null : dataISO(casal.dtEncerramento),
  }
}

/**
 * A recusa de usar a caixa do casal enquanto ha vivos de outra ninhada nela. 'para' e o que se
 * queria fazer: "registrar este parto", "formar casal novo nela". Null quando a caixa esta livre
 */
export function recusaDaCaixaOcupada(ninhadas: NinhadaNaCaixa[], para: string) {
  const [primeira] = ninhadas
  if (primeira === undefined) return null

  const animais = `${primeira.m} M e ${primeira.f} F`

  if (!primeira.desmamado) {
    return erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      `A ninhada do ${primeira.ordem}o parto do casal ${primeira.casal} ainda mama nesta caixa (${animais}). Registre o desmame e passe os animais para o estoque antes de ${para}.`,
    )
  }

  return erroDeRegra(
    'CAIXA_COM_ANIMAIS',
    `A caixa ainda tem ${animais} desmamados do ${primeira.ordem}o parto do casal ${primeira.casal}. Passe-os para o estoque, ou registre a baixa, antes de ${para}.`,
  )
}

/** Trava o casal e o parto, nessa ordem, e le o parto com o casal */
export async function travarELerParto(tx: Transacao, idParto: number) {
  const base = await tx.parto.findUnique({ where: { id: idParto }, select: { idCasal: true } })

  if (base === null) {
    throw naoEncontrado('Parto')
  }

  await travarCasal(tx, base.idCasal)
  await travarParto(tx, idParto)

  const parto = await tx.parto.findUnique({
    where: { id: idParto },
    include: {
      casal: {
        select: {
          id: true,
          ativo: true,
          idCaixa: true,
          idLinhagem: true,
          identificacao: true,
          dtFormacao: true,
          dtEncerramento: true,
          caixa: { select: { codigo: true, ativa: true, tipo: true } },
        },
      },
    },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  return parto
}

export type PartoTravado = Awaited<ReturnType<typeof travarELerParto>>

// ------------------------------------------------------------ formar casal

export type PosicaoVazia = {
  idEstante: number
  face: 'frontal' | 'traseira'
  linha: number
  coluna: number
}

export type NovoCasal = {
  idCaixa?: number | undefined
  posicao?: PosicaoVazia | undefined
  idLinhagem: number
  grupoMacho: string
  grupoFemea: string
  dtFormacao: string
}

/** A estante e a caixa ativa que ocupa a posicao (null se vazia). Recusa posicao fora da estante */
async function caixaNaPosicao(tx: Transacao, posicao: PosicaoVazia) {
  const estante = await tx.estante.findUnique({ where: { id: posicao.idEstante } })

  if (estante === null) {
    throw naoEncontrado('Estante')
  }

  const face = posicao.face === 'frontal' ? 1 : 2

  if (face > estante.faces || posicao.linha > estante.linhas || posicao.coluna > estante.colunas) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Esta posicao nao existe na estante.')
  }

  const caixa = await tx.caixa.findFirst({
    where: { idEstante: estante.id, face, linha: posicao.linha, coluna: posicao.coluna, ativa: true },
    select: { id: true },
  })

  return { estante, face, caixa }
}

/**
 * A caixa que ja existe recebe casal novo so se for de casal, ativa, da especie da linhagem, sem
 * casal ativo, sem parto pendente do casal anterior e sem vivo dentro. A caixa ja esta travada
 */
async function exigirCaixaParaCasal(tx: Transacao, idCaixa: number, idEspecie: number) {
  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      codigo: true,
      ativa: true,
      tipo: true,
      idEspecie: true,
      casais: { select: { ativo: true, partos: { where: partoPendente, select: { ordem: true } } } },
    },
  })

  if (caixa === null) throw naoEncontrado('Caixa')
  if (!caixa.ativa) throw caixaLiberada(caixa.codigo)

  if (caixa.tipo === 'estoque') {
    throw erroDeRegra(
      'CAIXA_DE_ESTOQUE',
      'Esta e uma caixa de estoque: casal novo vai numa posicao vazia ou numa caixa de casal sem animal.',
    )
  }

  if (caixa.idEspecie !== idEspecie) {
    throw campoInvalido('idLinhagem', 'Esta linhagem nao pertence a especie da caixa.')
  }

  if (caixa.casais.some((casal) => casal.ativo)) {
    throw erroDeRegra(
      'CAIXA_JA_TEM_CASAL_ATIVO',
      'Esta caixa ja tem um casal ativo. Encerre o casal atual antes de formar outro.',
    )
  }

  const pendente = caixa.casais.flatMap((casal) => casal.partos)[0]

  if (pendente !== undefined) {
    throw erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      `O ${pendente.ordem}o parto do casal anterior ainda esta pendente nesta caixa: registre o nascimento ou feche o parto sem ninhada antes.`,
    )
  }

  const recusa = recusaDaCaixaOcupada(await ninhadasNaCaixa(tx, idCaixa), 'formar casal novo nela')
  if (recusa !== null) throw recusa
}

/**
 * POST /api/casais - forma o casal e ja abre o 1o parto, com o acasalamento no dia da formacao.
 * Numa posicao vazia a caixa de casal nasce na mesma transacao, com a especie da linhagem; o
 * codigo dela vem do trigger da posicao
 */
export async function formarCasal(dados: NovoCasal, idUsuario: number) {
  const linhagem = await prisma.linhagem.findUnique({ where: { id: dados.idLinhagem } })

  if (linhagem === null) {
    throw naoEncontrado('Linhagem')
  }

  // a mesma regra do pedido: linhagem inativa nao aparece no catalogo e nao recebe nada novo
  if (!linhagem.ativa) {
    throw campoInvalido('idLinhagem', 'Esta linhagem esta inativa e nao forma casal novo.')
  }

  await validarParGenetico(dados.grupoMacho, dados.grupoFemea)

  // um casal ativo por caixa tambem fica no indice parcial do banco, e uma posicao com uma caixa
  // ativa no outro: se a corrida passar por aqui, erros-do-banco.ts traduz
  const casal = await prisma.$transaction(async (tx) => {
    const naPosicao = dados.posicao === undefined ? null : await caixaNaPosicao(tx, dados.posicao)
    const idExistente = dados.idCaixa ?? naPosicao?.caixa?.id
    let idCaixa: number

    if (idExistente !== undefined) {
      await travarCaixas(tx, [idExistente])
      await exigirCaixaParaCasal(tx, idExistente, linhagem.idEspecie)
      idCaixa = idExistente
    } else if (naPosicao !== null && dados.posicao !== undefined) {
      const criada = await tx.caixa.create({
        data: {
          idEstante: naPosicao.estante.id,
          face: naPosicao.face,
          linha: dados.posicao.linha,
          coluna: dados.posicao.coluna,
          idEspecie: linhagem.idEspecie,
          tipo: 'casal',
        },
        select: { id: true },
      })
      idCaixa = criada.id
    } else {
      throw naoEncontrado('Caixa')
    }

    const criado = await tx.casal.create({
      data: {
        idCaixa,
        idLinhagem: dados.idLinhagem,
        grupoMacho: dados.grupoMacho,
        grupoFemea: dados.grupoFemea,
        identificacao: `${dados.grupoMacho}${dados.grupoFemea}`,
        dtFormacao: paraData(dados.dtFormacao),
      },
    })

    await tx.parto.create({
      data: { idCasal: criado.id, ordem: 1, dtAcasalamento: paraData(dados.dtFormacao) },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'casal',
      idEntidade: criado.id,
      acao: 'formacao',
      descricao: `Casal ${criado.identificacao} formado em ${dados.dtFormacao} (${linhagem.nome})`,
      dados: { idCaixa, idLinhagem: dados.idLinhagem, dtFormacao: dados.dtFormacao },
    })

    return criado
  })

  return { idCaixa: casal.idCaixa, casal: await casalFicha(casal.id) }
}

// ------------------------------------------------------------ acasalamento

export type Acasalamento = {
  dtAcasalamento: string
}

/**
 * POST /api/casais/:id/acasalamento - abre o parto seguinte. So com o casal ativo, o parto
 * anterior nascido e menos de 5 partos
 */
export async function registrarAcasalamento(idCasal: number, dados: Acasalamento, idUsuario: number) {
  const criado = await prisma.$transaction(async (tx) => {
    await travarCasal(tx, idCasal)

    const casal = await tx.casal.findUnique({
      where: { id: idCasal },
      include: { partos: { orderBy: { ordem: 'desc' }, take: 1 } },
    })

    if (casal === null) {
      throw naoEncontrado('Casal')
    }

    if (!casal.ativo) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este casal esta encerrado e nao recebe acasalamento novo.')
    }

    const [ultimo] = casal.partos

    if (ultimo !== undefined && ultimo.dtPartoReal === null) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        `Registre o ${ultimo.ordem}o parto antes do acasalamento seguinte. Se o acasalamento nao pegou, corrija a data dele.`,
      )
    }

    const ordem = (ultimo?.ordem ?? 0) + 1

    if (ordem > MAX_PARTOS_POR_CASAL) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', `Este casal ja teve os ${MAX_PARTOS_POR_CASAL} partos.`)
    }

    // no mesmo dia do parto anterior pode: a femea entra no cio logo depois de parir
    exigirOrdem('dtAcasalamento', dados.dtAcasalamento, {
      depoisDe: [
        { evento: 'da formacao do casal', data: casal.dtFormacao },
        { evento: `do ${ultimo?.ordem}o parto`, data: ultimo?.dtPartoReal },
      ],
    })

    const parto = await tx.parto.create({
      data: { idCasal, ordem, dtAcasalamento: paraData(dados.dtAcasalamento) },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: parto.id,
      acao: 'acasalamento',
      descricao: `Acasalamento do ${ordem}o parto do casal ${casal.identificacao.trim()} em ${dados.dtAcasalamento}`,
      dados: { ...dados },
    })

    return parto
  })

  return cicloFicha(criado.id)
}

// ------------------------------------------------------------ nascimento

export type Nascimento = {
  dtPartoReal: string
  nascidoM: number
  nascidoF: number
}

/**
 * POST /api/partos/:id/nascimento - grava a data e cria um animal vivo por filhote na caixa do
 * casal. Vale tambem para o parto pendente de casal ja encerrado: a femea pare o que carrega. A
 * caixa nao pode ter vivo de outra ninhada. No 5o parto o casal encerra na data do parto
 */
export async function registrarNascimento(idParto: number, dados: Nascimento, idUsuario: number) {
  await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)
    const { casal } = parto

    if (parto.dtPartoReal !== null) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'Este parto ja tem data real registrada. Para mudar, use Corrigir no parto.',
      )
    }

    if (parto.dtSemNinhada !== null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este parto foi fechado sem ninhada.')
    }

    exigirOrdem('dtPartoReal', dados.dtPartoReal, {
      depoisDe: [{ evento: 'do acasalamento', data: parto.dtAcasalamento }],
    })

    await travarCaixas(tx, [casal.idCaixa])

    if (!casal.caixa.ativa) throw caixaLiberada(casal.caixa.codigo)

    // duas ninhadas nao dividem a caixa: a de antes desmama e sai primeiro
    const recusa = recusaDaCaixaOcupada(
      (await ninhadasNaCaixa(tx, casal.idCaixa)).filter((ninhada) => ninhada.idParto !== idParto),
      'registrar este parto',
    )
    if (recusa !== null) throw recusa

    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtPartoReal: paraData(dados.dtPartoReal),
        idUsuarioParto: idUsuario,
        dtRegistroParto: new Date(),
      },
    })

    await lancarOcorrencia(tx, {
      tipo: 'nascimento',
      dtFato: dados.dtPartoReal,
      idUsuario,
      idParto,
      idCaixa: casal.idCaixa,
      nascidos: { m: dados.nascidoM, f: dados.nascidoF },
    })

    let encerrado = !casal.ativo

    if (casal.ativo && parto.ordem >= MAX_PARTOS_POR_CASAL) {
      // no ultimo parto o casal encerra sozinho; a caixa fica com a ninhada
      await tx.casal.update({
        where: { id: casal.id },
        data: {
          ativo: false,
          dtEncerramento: paraData(dados.dtPartoReal),
          motivoEncerramento: `Limite de ${MAX_PARTOS_POR_CASAL} partos atingido`,
          dtManutencao: new Date(),
        },
      })

      await registrarHistorico(tx, {
        idUsuario,
        entidade: 'casal',
        idEntidade: casal.id,
        acao: 'encerramento',
        descricao: `Casal ${casal.identificacao.trim()} encerrado em ${dados.dtPartoReal}: limite de ${MAX_PARTOS_POR_CASAL} partos atingido`,
        dados: { dtEncerramento: dados.dtPartoReal, automatico: true },
      })

      encerrado = true
    }

    // casal encerrado e parto sem filhote nenhum: a caixa ficou vazia
    if (encerrado) {
      await liberarSeVazia(tx, casal.idCaixa, dados.dtPartoReal, 'casal_encerrado', idUsuario)
    }
  })

  return cicloFicha(idParto)
}

// ------------------------------------------------------------ selecao e desmame

/**
 * A baixa de animais do parto na caixa do casal (a selecao e a diferenca do desmame): livres
 * primeiro, depois os reservados do pedido indicado. Devolve os escolhidos, ja baixados
 */
async function baixarDoParto(
  tx: Transacao,
  parto: PartoTravado,
  qtd: PorSexo,
  baixa: { campo: string; dtFato: string; motivo: string; idPedido: number | undefined; idUsuario: number },
): Promise<Escolhido[]> {
  const escolhidos: Escolhido[] = []

  for (const sexo of SEXOS) {
    escolhidos.push(
      ...(await escolherAnimais(
        tx,
        { idCaixa: parto.casal.idCaixa, idParto: parto.id, sexo },
        doSexo(qtd, sexo),
        { idPedido: baixa.idPedido, excluir: escolhidos.map((animal) => animal.id) },
      )),
    )
  }

  if (escolhidos.length === 0) return []

  exigirDepoisDaChegada(baixa.campo, baixa.dtFato, escolhidos)

  await lancarOcorrencia(tx, {
    tipo: 'baixa',
    dtFato: baixa.dtFato,
    idUsuario: baixa.idUsuario,
    idCaixa: parto.casal.idCaixa,
    idParto: parto.id,
    motivo: baixa.motivo,
    ids: escolhidos.map((animal) => animal.id),
  })

  return escolhidos
}

export type Selecao = {
  dtSelecao: string
  eutanasiadoM: number
  eutanasiadoF: number
  /** De qual pedido saem os reservados, quando os livres nao bastam */
  idPedido?: number | undefined
}

/**
 * POST /api/partos/:id/selecao - a eutanasia de selecao vira uma baixa dos animais do parto na
 * caixa do casal, antes do desmame. Pode se repetir: cada rodada e uma baixa com a sua data. Para
 * corrigir uma rodada, anula-se a baixa errada e lanca-se a certa
 */
export async function registrarSelecao(idParto: number, dados: Selecao, idUsuario: number) {
  const pedidos = await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)

    if (parto.dtPartoReal === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes da eutanasia.')
    }

    if (parto.dtDesmameReal !== null) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'O desmame ja foi registrado: a eutanasia de selecao vem antes dele. Depois do desmame, registre a baixa na caixa.',
      )
    }

    exigirOrdem('dtSelecao', dados.dtSelecao, {
      depoisDe: [{ evento: 'do parto', data: parto.dtPartoReal }],
    })

    await travarCaixas(tx, [parto.casal.idCaixa])

    const vivos = contarPorSexo(
      (await animaisDoParto(tx, idParto)).filter(
        (animal) => animal.situacao === 'vivo' && animal.idCaixa === parto.casal.idCaixa,
      ),
    )
    const passou = { m: dados.eutanasiadoM > vivos.m, f: dados.eutanasiadoF > vivos.f }

    if (passou.m || passou.f) {
      throw contagemInvalida(
        'eutanasiado',
        passou,
        `Nao pode passar dos vivos deste parto na caixa do casal (${vivos.m} M, ${vivos.f} F).`,
      )
    }

    const escolhidos = await baixarDoParto(tx, parto, { m: dados.eutanasiadoM, f: dados.eutanasiadoF }, {
      campo: 'dtSelecao',
      dtFato: dados.dtSelecao,
      motivo: MOTIVO_SELECAO,
      idPedido: dados.idPedido,
      idUsuario,
    })

    await liberarSeVazia(tx, parto.casal.idCaixa, dados.dtSelecao, 'baixa', idUsuario)

    return faltasDosPedidos(tx, pedidosTocados(escolhidos))
  })

  return { parto: await cicloFicha(idParto), faltas: pedidos }
}

export type Desmame = {
  dtDesmameReal: string
  desmamadoM: number
  desmamadoF: number
  /** De qual pedido saem os reservados que nao chegaram ao desmame, quando os livres nao bastam */
  idPedido?: number | undefined
}

/**
 * POST /api/partos/:id/desmame - grava a data. A contagem e conferencia contra os vivos do parto
 * na caixa do casal no dia do desmame (contarNoDesmame): abaixo deles, a diferenca vira baixa
 * ('nao chegou ao desmame') na data do desmame; acima, e erro de contagem do nascimento, que se
 * corrige la. Quem morreu depois da data, ja lancado na baixa da caixa, chegou ao desmame e conta
 * nele. Ninguem muda de caixa aqui
 */
export async function registrarDesmame(idParto: number, dados: Desmame, idUsuario: number) {
  const faltas = await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)

    if (parto.dtPartoReal === null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes do desmame.')
    }

    if (parto.dtDesmameReal !== null) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'O desmame deste parto ja foi registrado. Para mudar a data, use Corrigir no parto.',
      )
    }

    await travarCaixas(tx, [parto.casal.idCaixa])

    const animais = await animaisDoParto(tx, idParto)
    await exigirDataDoDesmame(tx, parto, dados.dtDesmameReal, animais)

    const { vivos, morreramDepois } = contarNoDesmame(animais, parto.casal.idCaixa, dados.dtDesmameReal)
    const acima = { m: dados.desmamadoM > vivos.m, f: dados.desmamadoF > vivos.f }

    if (acima.m || acima.f) {
      throw contagemInvalida(
        'desmamado',
        acima,
        `Nao pode passar dos vivos deste parto na caixa do casal no dia do desmame (${vivos.m} M, ${vivos.f} F). Se nasceram mais, corrija o nascimento.`,
      )
    }

    const abaixo = { m: dados.desmamadoM < morreramDepois.m, f: dados.desmamadoF < morreramDepois.f }

    if (abaixo.m || abaixo.f) {
      throw contagemInvalida(
        'desmamado',
        abaixo,
        `${morreramDepois.m} M e ${morreramDepois.f} F deste parto morreram depois desta data: chegaram ao desmame e contam nele.`,
      )
    }

    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtDesmameReal: paraData(dados.dtDesmameReal),
        idUsuarioDesmame: idUsuario,
        dtRegistroDesmame: new Date(),
      },
    })

    const naoChegaram = { m: vivos.m - dados.desmamadoM, f: vivos.f - dados.desmamadoF }
    const escolhidos = await baixarDoParto(tx, parto, naoChegaram, {
      campo: 'dtDesmameReal',
      dtFato: dados.dtDesmameReal,
      motivo: MOTIVO_NAO_CHEGOU_AO_DESMAME,
      idPedido: dados.idPedido,
      idUsuario,
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'desmame',
      descricao: `Desmame do ${parto.ordem}o parto em ${dados.dtDesmameReal}: ${dados.desmamadoM} M e ${dados.desmamadoF} F`,
      dados: { dtDesmameReal: dados.dtDesmameReal, desmamadoM: dados.desmamadoM, desmamadoF: dados.desmamadoF },
    })

    if (!parto.casal.ativo) {
      await liberarSeVazia(tx, parto.casal.idCaixa, dados.dtDesmameReal, 'baixa', idUsuario)
    }

    return faltasDosPedidos(tx, pedidosTocados(escolhidos))
  })

  return { parto: await cicloFicha(idParto), faltas }
}

// ------------------------------------------------------------ encerramento e sem ninhada

export type Encerramento = {
  dtEncerramento: string
  motivo: string
}

/**
 * POST /api/casais/:id/encerramento - nada e apagado, so encerra. A caixa libera se ficou sem
 * vivo e sem parto pendente; o parto pendente continua aberto (nasce depois ou fecha sem ninhada)
 */
export async function encerrarCasal(idCasal: number, dados: Encerramento, idUsuario: number) {
  await prisma.$transaction(async (tx) => {
    await travarCasal(tx, idCasal)

    const casal = await tx.casal.findUnique({
      where: { id: idCasal },
      include: { partos: { orderBy: { ordem: 'desc' }, take: 1 } },
    })

    if (casal === null) {
      throw naoEncontrado('Casal')
    }

    if (!casal.ativo) {
      throw campoInvalido('idCasal', 'Este casal ja esta encerrado.')
    }

    // o parto pode vir depois do encerramento, porque a femea separada do macho ainda pare a
    // ninhada que carrega. O acasalamento nao
    const [ultimo] = casal.partos

    exigirOrdem('dtEncerramento', dados.dtEncerramento, {
      depoisDe: [
        { evento: 'da formacao do casal', data: casal.dtFormacao },
        { evento: `do acasalamento do ${ultimo?.ordem}o parto`, data: ultimo?.dtAcasalamento },
      ],
    })

    await tx.casal.update({
      where: { id: idCasal },
      data: {
        ativo: false,
        dtEncerramento: paraData(dados.dtEncerramento),
        motivoEncerramento: dados.motivo,
        dtManutencao: new Date(),
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'casal',
      idEntidade: idCasal,
      acao: 'encerramento',
      descricao: `Casal ${casal.identificacao.trim()} encerrado em ${dados.dtEncerramento}: ${dados.motivo}`,
      dados: { ...dados },
    })

    await liberarSeVazia(tx, casal.idCaixa, dados.dtEncerramento, 'casal_encerrado', idUsuario)
  })

  return casalFicha(idCasal)
}

export type SemNinhada = {
  dtSemNinhada: string
  motivo: string
}

/**
 * POST /api/partos/:id/sem-ninhada - fecha o parto pendente de casal encerrado que nao vai nascer.
 * So com o casal encerrado: o casal ativo registra o nascimento ou corrige o acasalamento. Sem
 * parto pendente, a caixa vazia e liberada
 */
export async function fecharSemNinhada(idParto: number, dados: SemNinhada, idUsuario: number) {
  await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)
    const { casal } = parto

    if (parto.dtPartoReal !== null || parto.dtSemNinhada !== null) {
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este parto nao esta pendente: ja nasceu ou ja foi fechado.')
    }

    if (casal.ativo) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'O casal esta ativo: registre o nascimento ou, se o acasalamento nao pegou, corrija a data dele.',
      )
    }

    exigirOrdem('dtSemNinhada', dados.dtSemNinhada, {
      depoisDe: [
        { evento: 'do acasalamento', data: parto.dtAcasalamento },
        { evento: 'do encerramento do casal', data: casal.dtEncerramento },
      ],
    })

    await tx.parto.update({
      where: { id: idParto },
      data: {
        dtSemNinhada: paraData(dados.dtSemNinhada),
        motivoSemNinhada: dados.motivo,
        dtManutencao: new Date(),
      },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'parto',
      idEntidade: idParto,
      acao: 'sem_ninhada',
      descricao: `${parto.ordem}o parto do casal ${casal.identificacao.trim()} fechado sem ninhada em ${dados.dtSemNinhada}: ${dados.motivo}`,
      dados: { ...dados },
    })

    await liberarSeVazia(tx, casal.idCaixa, dados.dtSemNinhada, 'casal_encerrado', idUsuario)
  })

  return cicloFicha(idParto)
}
