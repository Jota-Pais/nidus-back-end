// Os eventos da ficha de uma caixa, por data: o que aconteceu com os animais dela (a trilha de
// ocorrencias), as datas do ciclo dos casais que passaram por ela e o que mudou na propria caixa
// (posicao, virar estoque, liberacao). Cada fato aparece uma vez: o que e dos animais vem da
// trilha, o resto das tabelas, e o historico so diz quem registrou e as correcoes. A correcao
// entra pelo historico, com o motivo: a dos partos dos casais da caixa e, quando a caixa recebeu
// animais de outra, a do nascimento ou do desmame dos partos desses animais registrada depois que
// eles chegaram, que pode ter criado, anulado ou trocado de sexo animais daqui

import { prisma } from '../../shared/prisma.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import { descreverOcorrencia, selecaoDaDescricao } from '../colonia/descricao.ts'
import { quantosAnimais } from '../colonia/tipos.ts'
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
/**
 * O 'virar caixa de estoque' de antes do modelo por rato: a mesma acao gravava a passagem para o
 * estoque, com o parto nos dados, que a conversao virou mudanca e aparece pela trilha
 */
const VIRAR_ESTOQUE_ANTIGO = 'estoque'
const DA_CAIXA = ['mudanca_de_posicao', 'virar_estoque', VIRAR_ESTOQUE_ANTIGO, 'liberacao']
/** O tipo do evento de cada acao da caixa que muda de nome na ficha */
const TIPO_DO_EVENTO_DA_CAIXA: Record<string, string> = {
  mudanca_de_posicao: 'posicao',
  [VIRAR_ESTOQUE_ANTIGO]: 'virar_estoque',
}

/** Se os dados do registro tem o parto: a passagem antiga para o estoque, e nao o virar estoque */
function temParto(dados: unknown): boolean {
  return typeof dados === 'object' && dados !== null && 'idParto' in dados
}

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
    select: { ...selecaoDaDescricao, dtFato: true, dtRegistro: true, usuario: { select: { nome: true } } },
  })
}

function eventoDaOcorrencia(ocorrencia: OcorrenciaLida, idCaixa: number): Evento {
  return evento(
    dataISO(ocorrencia.dtFato),
    ocorrencia.tipo,
    descreverOcorrencia(ocorrencia, idCaixa),
    ocorrencia.usuario?.nome ?? NOME_DO_SISTEMA,
    ocorrencia.dtRegistro,
    { id: ocorrencia.id, anulavel: ocorrencia.tipo === 'baixa' && ocorrencia.anulacoes.length === 0 },
  )
}

/** Um parto de casal de outra caixa com animais que chegaram nesta */
type ParteDeFora = {
  /** a identificacao do casal, para a correcao dizer de quem e */
  casal: string
  /** quando a primeira chegada de animais dele foi registrada aqui */
  registro: Date
}

/**
 * Os partos de casais de outras caixas cujos animais chegaram nesta (pela mudanca, pela volta da
 * anulacao ou como animais a mais da correcao), com quando a primeira chegada foi registrada: a
 * correcao do parto depois disso muda animais que sao ou foram daqui, e a ficha mostra; a de antes
 * foi na caixa de onde eles vieram
 */
async function chegadasDeFora(idCaixa: number): Promise<Map<number, ParteDeFora>> {
  const chegadas = await prisma.ocorrencia.findMany({
    where: {
      idCaixaDestino: idCaixa,
      animais: { some: { animal: { parto: { casal: { idCaixa: { not: idCaixa } } } } } },
    },
    orderBy: [{ dtRegistro: 'asc' }, { id: 'asc' }],
    select: {
      dtRegistro: true,
      animais: {
        select: {
          animal: {
            select: { idParto: true, parto: { select: { casal: { select: { idCaixa: true, identificacao: true } } } } },
          },
        },
      },
    },
  })

  const porParto = new Map<number, ParteDeFora>()

  for (const chegada of chegadas) {
    for (const { animal } of chegada.animais) {
      if (animal.parto.casal.idCaixa === idCaixa || porParto.has(animal.idParto)) continue
      porParto.set(animal.idParto, { casal: animal.parto.casal.identificacao.trim(), registro: chegada.dtRegistro })
    }
  }

  return porParto
}

// ------------------------------------------------------------ o resto

/**
 * Os eventos da ficha da caixa, do mais antigo para o mais novo. 'desmamados' sao as contagens do
 * desmame de cada parto (por id), que a ficha ja contou nos animais
 */
export async function eventosDaCaixa(idCaixa: number, desmamados: Map<number, PorSexo>): Promise<EventoDaFicha[]> {
  const [caixa, casais, ocorrencias, partosDeFora] = await Promise.all([
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
    chegadasDeFora(idCaixa),
  ])

  const registros = await prisma.historico.findMany({
    where: {
      OR: [
        { entidade: 'casal', idEntidade: { in: casais.map((casal) => casal.id) }, acao: { in: ['formacao', 'encerramento'] } },
        {
          entidade: 'parto',
          idEntidade: { in: casais.flatMap((casal) => casal.partos.map((parto) => parto.id)) },
          acao: { in: ['acasalamento', 'sem_ninhada', ...CORRECOES] },
        },
        { entidade: 'parto', idEntidade: { in: [...partosDeFora.keys()] }, acao: { in: CORRECOES_DOS_ANIMAIS } },
        { entidade: 'caixa', idEntidade: idCaixa, acao: { in: DA_CAIXA } },
      ],
    },
    orderBy: { id: 'asc' },
    select: {
      entidade: true,
      acao: true,
      idEntidade: true,
      dtHora: true,
      descricao: true,
      dados: true,
      usuario: { select: { nome: true } },
    },
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
            `Desmame ${doParto}${qtd === undefined ? '' : `: ${quantosAnimais(qtd)}`}.`,
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

    // a passagem do modelo antigo, com o parto nos dados, ja esta na trilha como mudanca
    if (registro.acao === VIRAR_ESTOQUE_ANTIGO && temParto(registro.dados)) continue

    const deFora = registro.entidade === 'parto' ? partosDeFora.get(registro.idEntidade) : undefined

    // de um parto de fora, so a correcao registrada depois de os animais dele chegarem aqui
    if (deFora !== undefined && registro.dtHora < deFora.registro) continue

    eventos.push(
      evento(
        hojeISO(registro.dtHora),
        correcao ? 'correcao' : TIPO_DO_EVENTO_DA_CAIXA[registro.acao] ?? registro.acao,
        deFora === undefined ? registro.descricao : `Casal ${deFora.casal}: ${registro.descricao}`,
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
