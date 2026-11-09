// Os eventos da ficha de uma caixa, por data: o que aconteceu com os animais dela (a trilha de
// ocorrencias), as datas do ciclo dos casais que passaram por ela e o que mudou na propria caixa
// (posicao, virar estoque, liberacao). Cada fato aparece uma vez: o que e dos animais vem da
// trilha, o resto das tabelas, e o historico so diz quem registrou e as correcoes. A correcao
// entra pelo historico, com o motivo: a dos partos dos casais da caixa e, quando a caixa recebeu
// animais de outra, a do nascimento ou do desmame dos partos desses animais, que pode ter criado,
// anulado ou trocado de sexo animais daqui

import { prisma } from '../../shared/prisma.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import { MOTIVO_NAO_CHEGOU_AO_DESMAME, MOTIVO_SELECAO, contarPorSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { NOME_DO_SISTEMA } from '../historico/historico.service.ts'

export type EventoDaFicha = {
  /** o dia do fato, 'aaaa-mm-ddT00:00:00.000Z' */
  dataHora: string
  tipo: string
  descricao: string
  autor: string
  /** so nos fatos dos animais: a ocorrencia da trilha */
  idOcorrencia: number | null
  /** a baixa que ainda pode ser anulada */
  anulavel: boolean
}

/** No mesmo dia, a ordem em que as coisas acontecem na colonia */
const ORDEM_NO_DIA: Record<string, number> = {
  acasalamento: 0,
  nascimento: 1,
  baixa: 2,
  anulacao: 3,
  desmame: 4,
  mudanca: 5,
  entrega: 6,
  virar_estoque: 7,
  encerramento: 8,
  sem_ninhada: 8,
  liberacao: 9,
}

const CORRECOES = ['correcao_acasalamento', 'correcao_nascimento', 'correcao_desmame']
/** As correcoes que dizem respeito aos animais, e nao ao casal: as que valem fora da caixa dele */
const CORRECOES_DOS_ANIMAIS = ['correcao_nascimento', 'correcao_desmame']
const DA_CAIXA = ['mudanca_de_posicao', 'virar_estoque', 'liberacao']

const DESCONHECIDO = 'Desconhecido'

type Evento = EventoDaFicha & { registro: Date | null }

function evento(
  data: string,
  tipo: string,
  descricao: string,
  autor: string,
  registro: Date | null,
  ocorrencia: { id: number; anulavel: boolean } | null = null,
): Evento {
  return {
    dataHora: `${data}T00:00:00.000Z`,
    tipo,
    descricao,
    autor,
    idOcorrencia: ocorrencia?.id ?? null,
    anulavel: ocorrencia?.anulavel ?? false,
    registro,
  }
}

const animais = ({ m, f }: PorSexo) => `${m} M, ${f} F`

// ------------------------------------------------------------ a trilha dos animais

type OcorrenciaLida = Awaited<ReturnType<typeof lerOcorrencias>>[number]

/** As ocorrencias que tocaram a caixa: nela nasceram, morreram, chegaram, sairam ou foram entregues */
function lerOcorrencias(idCaixa: number) {
  return prisma.ocorrencia.findMany({
    where: {
      // a correcao aparece pelo historico (partosDeFora), com o motivo e o antes e depois
      tipo: { not: 'correcao' },
      OR: [
        { idCaixaOrigem: idCaixa },
        { idCaixaDestino: idCaixa },
        // o entregue fica na caixa de onde saiu
        { tipo: 'entrega', animais: { some: { animal: { idCaixa } } } },
      ],
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      tipo: true,
      dtFato: true,
      dtRegistro: true,
      idCaixaOrigem: true,
      idCaixaDestino: true,
      idPedido: true,
      motivo: true,
      usuario: { select: { nome: true } },
      parto: { select: { ordem: true, casal: { select: { identificacao: true } } } },
      caixaOrigem: { select: { codigo: true } },
      caixaDestino: { select: { codigo: true } },
      anulacao: { select: { id: true } },
      animais: { select: { animal: { select: { sexo: true, idCaixa: true } } } },
    },
  })
}

function doParto(ocorrencia: OcorrenciaLida): string {
  const { parto } = ocorrencia
  return parto === null ? '' : ` do ${parto.ordem}o parto do casal ${parto.casal.identificacao.trim()}`
}

function descricaoDaBaixa(ocorrencia: OcorrenciaLida, qtd: PorSexo): string {
  const anulada = ocorrencia.anulacao === null ? '' : ' (anulada)'

  if (ocorrencia.motivo === MOTIVO_SELECAO) return `Eutanasia de selecao${doParto(ocorrencia)}: ${animais(qtd)}.${anulada}`
  if (ocorrencia.motivo === MOTIVO_NAO_CHEGOU_AO_DESMAME) {
    return `${animais(qtd)}${doParto(ocorrencia)} nao chegaram ao desmame.${anulada}`
  }

  return `Baixa de ${animais(qtd)}${ocorrencia.motivo === null ? '' : `: ${ocorrencia.motivo}`}.${anulada}`
}

function descricaoDaOcorrencia(ocorrencia: OcorrenciaLida, idCaixa: number): string {
  const daqui = ocorrencia.animais.map((ligacao) => ligacao.animal)
  const qtd = contarPorSexo(ocorrencia.tipo === 'entrega' ? daqui.filter((animal) => animal.idCaixa === idCaixa) : daqui)
  const origem = ocorrencia.caixaOrigem?.codigo ?? ''
  const destino = ocorrencia.caixaDestino?.codigo ?? ''

  switch (ocorrencia.tipo) {
    case 'nascimento':
      return `Nascimento${doParto(ocorrencia)}: ${animais(qtd)}.`
    case 'baixa':
      return descricaoDaBaixa(ocorrencia, qtd)
    case 'mudanca':
      return ocorrencia.idCaixaOrigem === idCaixa
        ? `${animais(qtd)} mudaram para a caixa ${destino}.`
        : `${animais(qtd)} chegaram da caixa ${origem}.`
    case 'anulacao': {
      const onde =
        ocorrencia.idCaixaDestino === null
          ? ''
          : ocorrencia.idCaixaOrigem === idCaixa
            ? ` na caixa ${destino}`
            : `, vindos da caixa ${origem}`
      return `Baixa anulada: ${animais(qtd)} voltaram a viver${onde}. Motivo: ${ocorrencia.motivo ?? ''}`
    }
    case 'entrega':
      return `${animais(qtd)} entregues ao pedido #${ocorrencia.idPedido}.`
    default:
      return `${ocorrencia.tipo}: ${animais(qtd)}.`
  }
}

function eventoDaOcorrencia(ocorrencia: OcorrenciaLida, idCaixa: number): Evento {
  return evento(
    dataISO(ocorrencia.dtFato),
    ocorrencia.tipo,
    descricaoDaOcorrencia(ocorrencia, idCaixa),
    ocorrencia.usuario?.nome ?? NOME_DO_SISTEMA,
    ocorrencia.dtRegistro,
    { id: ocorrencia.id, anulavel: ocorrencia.tipo === 'baixa' && ocorrencia.anulacao === null },
  )
}

/**
 * Os partos de casais de outras caixas com animais que estao nesta (vivos ou nao) ou passaram por
 * ela: a correcao deles muda animais daqui, e a ficha mostra
 */
function partosDeFora(idCaixa: number) {
  return prisma.parto.findMany({
    where: {
      casal: { idCaixa: { not: idCaixa } },
      animais: {
        some: {
          OR: [
            { idCaixa },
            { ocorrencias: { some: { ocorrencia: { OR: [{ idCaixaOrigem: idCaixa }, { idCaixaDestino: idCaixa }] } } } },
          ],
        },
      },
    },
    select: { id: true, casal: { select: { identificacao: true } } },
  })
}

// ------------------------------------------------------------ o resto

/**
 * Os eventos da ficha da caixa, do mais antigo para o mais novo. 'desmamados' sao as contagens do
 * desmame de cada parto (por id), que a ficha ja contou nos animais
 */
export async function eventosDaCaixa(idCaixa: number, desmamados: Map<number, PorSexo>): Promise<EventoDaFicha[]> {
  const [caixa, casais, ocorrencias, deFora] = await Promise.all([
    prisma.caixa.findUnique({ where: { id: idCaixa }, select: { dtLiberacao: true } }),
    prisma.casal.findMany({
      where: { idCaixa },
      select: {
        id: true,
        identificacao: true,
        dtEncerramento: true,
        motivoEncerramento: true,
        partos: {
          orderBy: { ordem: 'asc' },
          select: {
            id: true,
            ordem: true,
            dtAcasalamento: true,
            dtDesmameReal: true,
            dtRegistroDesmame: true,
            dtSemNinhada: true,
            motivoSemNinhada: true,
            usuarioDesmame: { select: { nome: true } },
          },
        },
      },
    }),
    lerOcorrencias(idCaixa),
    partosDeFora(idCaixa),
  ])

  // o casal de cada parto de fora, para a correcao dizer de quem e
  const casalDeFora = new Map(deFora.map((parto) => [parto.id, parto.casal.identificacao.trim()]))

  const registros = await prisma.historico.findMany({
    where: {
      OR: [
        { entidade: 'casal', idEntidade: { in: casais.map((casal) => casal.id) }, acao: { in: ['formacao', 'encerramento'] } },
        {
          entidade: 'parto',
          idEntidade: { in: casais.flatMap((casal) => casal.partos.map((parto) => parto.id)) },
          acao: { in: ['acasalamento', 'sem_ninhada', ...CORRECOES] },
        },
        { entidade: 'parto', idEntidade: { in: [...casalDeFora.keys()] }, acao: { in: CORRECOES_DOS_ANIMAIS } },
        { entidade: 'caixa', idEntidade: idCaixa, acao: { in: DA_CAIXA } },
      ],
    },
    orderBy: { id: 'asc' },
    select: { entidade: true, acao: true, idEntidade: true, dtHora: true, descricao: true, usuario: { select: { nome: true } } },
  })

  // quem registrou cada fato: o primeiro registro dele
  const primeiro = (entidade: string, acao: string, idEntidade: number) =>
    registros.find((r) => r.entidade === entidade && r.acao === acao && r.idEntidade === idEntidade)
  const autorDo = (registro: (typeof registros)[number] | undefined) =>
    registro === undefined ? DESCONHECIDO : (registro.usuario?.nome ?? NOME_DO_SISTEMA)

  const eventos: Evento[] = ocorrencias.map((ocorrencia) => eventoDaOcorrencia(ocorrencia, idCaixa))

  for (const casal of casais) {
    const identificacao = casal.identificacao.trim()

    for (const parto of casal.partos) {
      const doParto = `do ${parto.ordem}o parto do casal ${identificacao}`
      // o 1o acasalamento e o da formacao do casal
      const acasalamento =
        parto.ordem === 1 ? primeiro('casal', 'formacao', casal.id) : primeiro('parto', 'acasalamento', parto.id)

      eventos.push(
        evento(
          dataISO(parto.dtAcasalamento),
          'acasalamento',
          `Acasalamento ${doParto}.`,
          autorDo(acasalamento),
          acasalamento?.dtHora ?? null,
        ),
      )

      if (parto.dtDesmameReal !== null) {
        const qtd = desmamados.get(parto.id)
        eventos.push(
          evento(
            dataISO(parto.dtDesmameReal),
            'desmame',
            `Desmame ${doParto}${qtd === undefined ? '' : `: ${animais(qtd)}`}.`,
            parto.usuarioDesmame?.nome ?? DESCONHECIDO,
            parto.dtRegistroDesmame,
          ),
        )
      }

      if (parto.dtSemNinhada !== null) {
        const registro = primeiro('parto', 'sem_ninhada', parto.id)
        eventos.push(
          evento(
            dataISO(parto.dtSemNinhada),
            'sem_ninhada',
            `O ${parto.ordem}o parto do casal ${identificacao} fechou sem ninhada: ${parto.motivoSemNinhada ?? ''}`,
            autorDo(registro),
            registro?.dtHora ?? null,
          ),
        )
      }
    }

    if (casal.dtEncerramento !== null) {
      const registro = primeiro('casal', 'encerramento', casal.id)
      eventos.push(
        evento(
          dataISO(casal.dtEncerramento),
          'encerramento',
          `Casal ${identificacao} encerrado${casal.motivoEncerramento ? `: ${casal.motivoEncerramento}` : '.'}`,
          autorDo(registro),
          registro?.dtHora ?? null,
        ),
      )
    }
  }

  // as correcoes, a posicao e o virar estoque so existem no historico, com a data do registro
  for (const registro of registros) {
    const correcao = CORRECOES.includes(registro.acao)
    const daCaixa = registro.entidade === 'caixa' && registro.acao !== 'liberacao'
    if (!correcao && !daCaixa) continue

    const deOutroCasal = registro.entidade === 'parto' ? casalDeFora.get(registro.idEntidade) : undefined

    eventos.push(
      evento(
        hojeISO(registro.dtHora),
        correcao ? 'correcao' : registro.acao === 'mudanca_de_posicao' ? 'posicao' : registro.acao,
        deOutroCasal === undefined ? registro.descricao : `Casal ${deOutroCasal}: ${registro.descricao}`,
        autorDo(registro),
        registro.dtHora,
      ),
    )
  }

  // a liberacao tem a data do fato que esvaziou a caixa, gravada nela
  if (caixa?.dtLiberacao) {
    const registro = primeiro('caixa', 'liberacao', idCaixa)
    eventos.push(
      evento(
        dataISO(caixa.dtLiberacao),
        'liberacao',
        registro?.descricao ?? 'Caixa liberada.',
        autorDo(registro),
        registro?.dtHora ?? null,
      ),
    )
  }

  return eventos
    .sort(
      (a, b) =>
        a.dataHora.localeCompare(b.dataHora) ||
        (ORDEM_NO_DIA[a.tipo] ?? 10) - (ORDEM_NO_DIA[b.tipo] ?? 10) ||
        (a.registro?.getTime() ?? 0) - (b.registro?.getTime() ?? 0),
    )
    .map(({ registro: _registro, ...resto }) => resto)
}
