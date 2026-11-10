// Casais e o ciclo dos partos: formar casal, nascimento (que abre sozinho o acasalamento
// seguinte), eutanasia de selecao, desmame, encerramento e o parto que fecha sem ninhada.
//
// Os animais moram em colonia.animal e so mudam por lancarOcorrencia. As regras do casal, do
// parto e da caixa ficam aqui, conferidas na mesma transacao da escrita e com as linhas travadas
// (colonia/travas.ts): casal -> parto -> caixa.

import type { Prisma } from '@prisma/client'
import { ErroDeAplicacao, campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { INTERVALO_ACASALAMENTO_DIAS, MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { lerPosicao } from '../infra/posicao.ts'
import type { PosicaoNaEstante } from '../infra/posicao.ts'
import { animaisDoParto, faltasDosPedidos, ninhadasNaCaixa } from '../colonia/consultas.ts'
import type { NinhadaNaCaixa } from '../colonia/consultas.ts'
import { escolherAnimais, exigirDepoisDaChegada, pedidosTocados } from '../colonia/escolha.ts'
import type { Escolhido } from '../colonia/escolha.ts'
import { caixaLiberada, liberarSeVazia, partoPendente } from '../colonia/liberacao.ts'
import { lancarOcorrencia } from '../colonia/ocorrencia.ts'
import {
  MOTIVO_NAO_CHEGOU_AO_DESMAME,
  MOTIVO_SELECAO,
  SEXOS,
  contarPorSexo,
  doSexo,
  quantosAnimais,
} from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { travarCaixas, travarCasal, travarParto } from '../colonia/travas.ts'
import { calcularProximoCiclo } from './cadeiaTemporal.ts'
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
    `A combinação ${grupoMacho}${grupoFemea} não está na rotação genética permitida.`,
    {
      campos: {
        grupoFemea:
          femeas.length > 0
            ? `Com macho do grupo ${grupoMacho}, só é válido o grupo ${femeas}.`
            : `O grupo ${grupoMacho} não tem par válido cadastrado.`,
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
    idLinhagem: casal.idLinhagem,
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

  const animais = quantosAnimais(primeira)
  const doParto = `do ${primeira.ordem}º parto do casal ${primeira.casal}`

  if (!primeira.desmamado) {
    return erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      `A ninhada ${doParto} ainda está em aleitamento nesta caixa (${animais}). Registre o desmame e passe os animais para o estoque antes de ${para}.`,
    )
  }

  return erroDeRegra(
    'CAIXA_COM_ANIMAIS',
    `A caixa ainda tem a ninhada desmamada ${doParto} (${animais}). Passe os animais para o estoque, ou registre a baixa, antes de ${para}.`,
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

export type NovoCasal = {
  idCaixa?: number | undefined
  posicao?: PosicaoNaEstante | undefined
  idLinhagem: number
  grupoMacho: string
  grupoFemea: string
  dtFormacao: string
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
      'Esta é uma caixa de estoque: casal novo vai numa posição vazia ou numa caixa do casal sem animal.',
    )
  }

  if (caixa.idEspecie !== idEspecie) {
    throw campoInvalido('idLinhagem', 'Esta linhagem não pertence à espécie da caixa.')
  }

  if (caixa.casais.some((casal) => casal.ativo)) {
    throw erroDeRegra(
      'CAIXA_JA_TEM_CASAL_ATIVO',
      'Esta caixa já tem um casal ativo. Encerre o casal atual antes de formar outro.',
    )
  }

  const pendente = caixa.casais.flatMap((casal) => casal.partos)[0]

  if (pendente !== undefined) {
    throw erroDeRegra(
      'CAIXA_COM_ANIMAIS',
      `O ${pendente.ordem}º parto do casal anterior ainda está pendente nesta caixa: registre o parto ou feche o parto sem ninhada antes.`,
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
    throw campoInvalido('idLinhagem', 'Esta linhagem está inativa e não forma casal novo.')
  }

  await validarParGenetico(dados.grupoMacho, dados.grupoFemea)

  // um casal ativo por caixa tambem fica no indice parcial do banco, e uma posicao com uma caixa
  // ativa no outro: se a corrida passar por aqui, erros-do-banco.ts traduz
  const casal = await prisma.$transaction(async (tx) => {
    const naPosicao = dados.posicao === undefined ? null : await lerPosicao(tx, dados.posicao, 'posicao')
    const idExistente = dados.idCaixa ?? naPosicao?.ocupante?.id
    let idCaixa: number

    if (idExistente !== undefined) {
      await travarCaixas(tx, [idExistente])
      await exigirCaixaParaCasal(tx, idExistente, linhagem.idEspecie)
      idCaixa = idExistente
    } else if (naPosicao !== null) {
      const criada = await tx.caixa.create({
        data: {
          idEstante: naPosicao.estante.id,
          face: naPosicao.face,
          linha: naPosicao.linha,
          coluna: naPosicao.coluna,
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
      descricao: `Casal ${criado.identificacao} formado, com acasalamento em ${dataLegivel(dados.dtFormacao)} (${linhagem.nome})`,
      dados: { idCaixa, idLinhagem: dados.idLinhagem, dtFormacao: dados.dtFormacao },
    })

    return criado
  })

  return { idCaixa: casal.idCaixa, casal: await casalFicha(casal.id) }
}

// ------------------------------------------------------------ acasalamento

/**
 * A descricao do acasalamento que o sistema abre sozinho, no historico. A migration
 * 20261110120000_acasalamento_automatico escreve o mesmo texto para os casais de antes dela
 */
export function descricaoDoAcasalamentoAutomatico(casal: string, ordem: number, dtAcasalamento: string): string {
  return `Acasalamento do ${ordem}º parto do casal ${casal} em ${dataLegivel(dtAcasalamento)}, aberto automaticamente ${INTERVALO_ACASALAMENTO_DIAS} dias depois do ${ordem - 1}º parto`
}

/**
 * O acasalamento seguinte abre sozinho no nascimento, 6 dias depois do parto (a regra do cliente,
 * INTERVALO_ACASALAMENTO_DIAS): ninguem ve o casal acasalar, e a data so serve para prever o parto.
 * Quem souber a data certa corrige na ficha. No historico e acao do sistema, sem usuario
 */
async function abrirAcasalamentoSeguinte(
  tx: Transacao,
  casal: { id: number; identificacao: string },
  ordemDoNascido: number,
  dtPartoReal: string,
) {
  const ordem = ordemDoNascido + 1
  const jaAberto = await tx.parto.findFirst({ where: { idCasal: casal.id, ordem }, select: { id: true } })
  if (jaAberto !== null) return

  const { dtAcasalamento } = calcularProximoCiclo(dtPartoReal)
  const parto = await tx.parto.create({
    data: { idCasal: casal.id, ordem, dtAcasalamento: paraData(dtAcasalamento) },
  })

  await registrarHistorico(tx, {
    idUsuario: null,
    entidade: 'parto',
    idEntidade: parto.id,
    acao: 'acasalamento',
    descricao: descricaoDoAcasalamentoAutomatico(casal.identificacao.trim(), ordem, dtAcasalamento),
    dados: { dtAcasalamento, automatico: true },
  })
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
 * caixa nao pode ter vivo de outra ninhada. No 5o parto o casal encerra na data do parto; antes
 * dele, o casal ativo ganha sozinho o acasalamento seguinte
 */
export async function registrarNascimento(idParto: number, dados: Nascimento, idUsuario: number) {
  await prisma.$transaction(async (tx) => {
    const parto = await travarELerParto(tx, idParto)
    const { casal } = parto

    if (parto.dtPartoReal !== null) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'Este parto já tem data real registrada. Para mudar, use Corrigir no parto.',
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
        descricao: `Casal ${casal.identificacao.trim()} encerrado em ${dataLegivel(dados.dtPartoReal)}: limite de ${MAX_PARTOS_POR_CASAL} partos atingido`,
        dados: { dtEncerramento: dados.dtPartoReal, automatico: true },
      })

      encerrado = true
    }

    // casal encerrado e parto sem filhote nenhum: a caixa ficou vazia
    if (encerrado) {
      await liberarSeVazia(tx, casal.idCaixa, dados.dtPartoReal, 'casal_encerrado', idUsuario)
    } else {
      await abrirAcasalamentoSeguinte(tx, casal, parto.ordem, dados.dtPartoReal)
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
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Registre o parto antes da eutanásia.')
    }

    if (parto.dtDesmameReal !== null) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'O desmame já foi registrado: a eutanásia de seleção vem antes dele. Depois do desmame, registre a baixa na caixa.',
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
        `Não pode passar dos vivos deste parto na caixa do casal (${quantosAnimais(vivos)}).`,
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
        'O desmame deste parto já foi registrado. Para mudar a data, use Corrigir no parto.',
      )
    }

    await travarCaixas(tx, [parto.casal.idCaixa])

    const animais = await animaisDoParto(tx, idParto)
    await exigirDataDoDesmame(tx, parto, dados.dtDesmameReal)

    const { vivos, morreramDepois } = contarNoDesmame(animais, parto.casal.idCaixa, dados.dtDesmameReal)
    const acima = { m: dados.desmamadoM > vivos.m, f: dados.desmamadoF > vivos.f }

    if (acima.m || acima.f) {
      throw contagemInvalida(
        'desmamado',
        acima,
        `Não pode passar dos vivos deste parto na caixa do casal no dia do desmame (${quantosAnimais(vivos)}). Se nasceram mais, corrija o parto.`,
      )
    }

    const abaixo = { m: dados.desmamadoM < morreramDepois.m, f: dados.desmamadoF < morreramDepois.f }

    if (abaixo.m || abaixo.f) {
      throw contagemInvalida(
        'desmamado',
        abaixo,
        `Quem morreu depois desta data chegou ao desmame e conta nele: ${quantosAnimais(morreramDepois)} deste parto.`,
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
      descricao: `Desmame do ${parto.ordem}º parto em ${dataLegivel(dados.dtDesmameReal)}: ${quantosAnimais({ m: dados.desmamadoM, f: dados.desmamadoF })}`,
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
 * POST /api/casais/:id/encerramento - so encerra. A caixa libera se ficou sem vivo e sem parto
 * pendente; o parto pendente continua aberto (nasce depois ou fecha sem ninhada). O acasalamento
 * pendente com data depois do encerramento nao aconteceu, porque o casal ja estava separado: o
 * parto dele sai, com o registro no historico
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
      throw campoInvalido('idCasal', 'Este casal já está encerrado.')
    }

    // o parto pode vir depois do encerramento, porque a femea separada do macho ainda pare a
    // ninhada que carrega. O acasalamento nao: o pendente marcado para depois do encerramento
    // (o que o sistema abre 6 dias depois do parto) nao aconteceu, e o limite passa a ser o de antes
    const [ultimo] = casal.partos
    const naoAconteceu =
      ultimo !== undefined &&
      ultimo.ordem > 1 &&
      ultimo.dtPartoReal === null &&
      ultimo.dtSemNinhada === null &&
      dataISO(ultimo.dtAcasalamento) > dados.dtEncerramento
    const limite = naoAconteceu
      ? await tx.parto.findFirst({
          where: { idCasal, ordem: ultimo.ordem - 1 },
          select: { ordem: true, dtAcasalamento: true },
        })
      : ultimo

    exigirOrdem('dtEncerramento', dados.dtEncerramento, {
      depoisDe: [
        { evento: 'da formação do casal', data: casal.dtFormacao },
        { evento: `do acasalamento do ${limite?.ordem}º parto`, data: limite?.dtAcasalamento },
      ],
    })

    if (naoAconteceu) {
      const dtAcasalamento = dataISO(ultimo.dtAcasalamento)
      await tx.parto.delete({ where: { id: ultimo.id } })

      await registrarHistorico(tx, {
        idUsuario,
        entidade: 'parto',
        idEntidade: ultimo.id,
        acao: 'acasalamento_desfeito',
        descricao: `Acasalamento do ${ultimo.ordem}º parto do casal ${casal.identificacao.trim()} em ${dataLegivel(dtAcasalamento)} desfeito: o casal foi encerrado antes, em ${dataLegivel(dados.dtEncerramento)}`,
        dados: { dtAcasalamento, dtEncerramento: dados.dtEncerramento },
      })
    }

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
      descricao: `Casal ${casal.identificacao.trim()} encerrado em ${dataLegivel(dados.dtEncerramento)}: ${dados.motivo}`,
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
      throw erroDeRegra('SEQUENCIA_INVALIDA', 'Este parto não está pendente: já nasceu ou já foi fechado.')
    }

    if (casal.ativo) {
      throw erroDeRegra(
        'SEQUENCIA_INVALIDA',
        'O casal está ativo: registre o parto ou, se o acasalamento não pegou, corrija a data dele.',
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
      descricao: `${parto.ordem}º parto do casal ${casal.identificacao.trim()} fechado sem ninhada em ${dataLegivel(dados.dtSemNinhada)}: ${dados.motivo}`,
      dados: { ...dados },
    })

    await liberarSeVazia(tx, casal.idCaixa, dados.dtSemNinhada, 'casal_encerrado', idUsuario)
  })

  return cicloFicha(idParto)
}
