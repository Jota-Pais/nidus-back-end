import type { Prisma } from '@prisma/client'
import { campoInvalido, erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { MAX_VIUVAS_POR_CAIXA } from '../../shared/parametros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, dataLegivel, paraData } from '../../shared/traducao.ts'
import { registrarHistorico } from '../historico/historico.service.ts'
import { lerPosicao } from '../infra/posicao.ts'
import type { PosicaoNaEstante } from '../infra/posicao.ts'
import { ninhadasNaCaixa } from '../colonia/consultas.ts'
import type { NinhadaNaCaixa } from '../colonia/consultas.ts'
import { caixaLiberada } from '../colonia/liberacao.ts'
import { travarCaixas, travarCasal } from '../colonia/travas.ts'
import { exigirOrdem } from './ordemDasDatas.ts'
import type { Marco } from './ordemDasDatas.ts'

type Transacao = Prisma.TransactionClient

type PartoDoCasal = {
  ordem: number | null
  dtPartoReal: Date | null
  dtDesmameReal: Date | null
  dtSemNinhada: Date | null
}

export type CasalParaViuva = {
  ativo: boolean
  viuva: { codigo: string; dtViuvez: Date } | null
  partos: PartoDoCasal[]
  ninhadas: Pick<NinhadaNaCaixa, 'ordem' | 'desmamado'>[]
}

export function porQueNaoViraViuva(casal: CasalParaViuva): string | null {
  if (casal.ativo) {
    return 'O casal ainda está ativo: a fêmea vai para as viúvas depois que o casal é desfeito.'
  }

  if (casal.viuva !== null) {
    return `A fêmea deste casal já foi para a caixa de viúvas ${casal.viuva.codigo} em ${dataLegivel(dataISO(casal.viuva.dtViuvez))}.`
  }

  const pendente = casal.partos.find((parto) => parto.dtPartoReal === null && parto.dtSemNinhada === null)

  if (pendente !== undefined) {
    return `O ${pendente.ordem}º parto do casal ainda está pendente: registre o parto ou feche o parto sem ninhada antes.`
  }

  const mamando = casal.ninhadas.find((ninhada) => !ninhada.desmamado)

  if (mamando !== undefined) {
    return `A ninhada do ${mamando.ordem}º parto ainda está em aleitamento na caixa do casal: a fêmea vai para as viúvas depois do desmame.`
  }

  return null
}

function ultimaData(partos: PartoDoCasal[], data: (parto: PartoDoCasal) => Date | null) {
  return partos.reduce<PartoDoCasal | undefined>((maior, parto) => {
    const esta = data(parto)
    if (esta === null) return maior
    const antes = maior === undefined ? null : data(maior)
    return antes === null || esta > antes ? parto : maior
  }, undefined)
}

function limitesDaViuvez(casal: { dtEncerramento: Date | null; partos: PartoDoCasal[] }): Marco[] {
  const parto = ultimaData(casal.partos, (p) => p.dtPartoReal)
  const desmame = ultimaData(casal.partos, (p) => p.dtDesmameReal)

  return [
    { evento: 'do encerramento do casal', data: casal.dtEncerramento },
    { evento: `do ${parto?.ordem}º parto`, data: parto?.dtPartoReal },
    { evento: `do desmame do ${desmame?.ordem}º parto`, data: desmame?.dtDesmameReal },
  ]
}

export type ViuvaDoCasal = {
  idCaixa: number
  codigoCaixa: string
  numeroVisivel: string
  dtViuvez: string
}

export async function viuvaNaFichaDoCasal(
  banco: Pick<Prisma.TransactionClient, 'animal' | 'parto' | 'pedido'>,
  casal: {
    ativo: boolean
    idCaixa: number
    partos: PartoDoCasal[]
    viuvas?: { idCaixa: number; dtViuvez: Date; caixa: { codigo: string; estante: { numeroVisivel: string } } }[] | undefined
  },
) {
  const [lida] = casal.viuvas ?? []
  const viuva: ViuvaDoCasal | null =
    lida === undefined
      ? null
      : {
          idCaixa: lida.idCaixa,
          codigoCaixa: lida.caixa.codigo,
          numeroVisivel: lida.caixa.estante.numeroVisivel,
          dtViuvez: dataISO(lida.dtViuvez),
        }

  const ninhadas = !casal.ativo && viuva === null ? await ninhadasNaCaixa(banco, casal.idCaixa) : []
  const porQue = porQueNaoViraViuva({
    ativo: casal.ativo,
    viuva: lida === undefined ? null : { codigo: lida.caixa.codigo, dtViuvez: lida.dtViuvez },
    partos: casal.partos,
    ninhadas,
  })

  return { viuva, podeVirarViuva: porQue === null, porQueNaoViraViuva: porQue }
}

export type IdaParaViuvas = {
  dtViuvez: string
  idCaixa?: number | undefined
  posicao?: PosicaoNaEstante | undefined
}

type CaixaDaViuva = { id: number; codigo: string }

async function exigirCaixaDeViuvas(tx: Transacao, idCaixa: number, idLinhagem: number): Promise<CaixaDaViuva> {
  const caixa = await tx.caixa.findUnique({
    where: { id: idCaixa },
    select: { id: true, codigo: true, ativa: true, tipo: true, idLinhagem: true, _count: { select: { viuvas: true } } },
  })

  if (caixa === null) throw naoEncontrado('Caixa')
  if (!caixa.ativa) throw caixaLiberada(caixa.codigo)

  if (caixa.tipo !== 'viuvas') {
    throw campoInvalido('idCaixa', 'Esta não é uma caixa de viúvas: escolha uma caixa de viúvas ou uma posição vazia.')
  }

  if (caixa.idLinhagem !== idLinhagem) {
    throw campoInvalido('idCaixa', 'Esta caixa de viúvas é de outra linhagem: a caixa de viúvas tem uma linhagem só.')
  }

  // o limite fica so aqui, com a caixa ja travada; o banco nao conta as viuvas
  if (caixa._count.viuvas >= MAX_VIUVAS_POR_CAIXA) {
    throw erroDeRegra(
      'CAIXA_DE_VIUVAS',
      `A caixa de viúvas ${caixa.codigo} já tem ${MAX_VIUVAS_POR_CAIXA} viúvas: escolha outra caixa ou uma posição vazia.`,
    )
  }

  return { id: caixa.id, codigo: caixa.codigo }
}

export async function levarParaViuvas(idCasal: number, dados: IdaParaViuvas, idUsuario: number) {
  return prisma.$transaction(async (tx) => {
    await travarCasal(tx, idCasal)

    const casal = await tx.casal.findUnique({
      where: { id: idCasal },
      select: {
        id: true,
        idCaixa: true,
        idLinhagem: true,
        identificacao: true,
        ativo: true,
        dtEncerramento: true,
        linhagem: { select: { idEspecie: true } },
        caixa: { select: { codigo: true } },
        partos: { orderBy: { ordem: 'asc' }, select: { ordem: true, dtPartoReal: true, dtDesmameReal: true, dtSemNinhada: true } },
        viuvas: { select: { dtViuvez: true, caixa: { select: { codigo: true } } } },
      },
    })

    if (casal === null) throw naoEncontrado('Casal')

    const naPosicao = dados.posicao === undefined ? null : await lerPosicao(tx, dados.posicao, 'posicao')
    const idExistente = dados.idCaixa ?? naPosicao?.ocupante?.id
    await travarCaixas(tx, [casal.idCaixa, ...(idExistente === undefined ? [] : [idExistente])])

    const [jaViuva] = casal.viuvas
    const porQue = porQueNaoViraViuva({
      ativo: casal.ativo,
      viuva: jaViuva === undefined ? null : { codigo: jaViuva.caixa.codigo, dtViuvez: jaViuva.dtViuvez },
      partos: casal.partos,
      ninhadas: casal.ativo || jaViuva !== undefined ? [] : await ninhadasNaCaixa(tx, casal.idCaixa),
    })

    if (porQue !== null) throw erroDeRegra('SEQUENCIA_INVALIDA', porQue)

    exigirOrdem('dtViuvez', dados.dtViuvez, { depoisDe: limitesDaViuvez(casal) })

    let caixa: CaixaDaViuva
    if (idExistente !== undefined) {
      caixa = await exigirCaixaDeViuvas(tx, idExistente, casal.idLinhagem)
    } else if (naPosicao !== null) {
      caixa = await tx.caixa.create({
        data: {
          idEstante: naPosicao.estante.id,
          face: naPosicao.face,
          linha: naPosicao.linha,
          coluna: naPosicao.coluna,
          idEspecie: casal.linhagem.idEspecie,
          tipo: 'viuvas',
          idLinhagem: casal.idLinhagem,
        },
        select: { id: true, codigo: true },
      })
    } else {
      throw naoEncontrado('Caixa')
    }

    const viuva = await tx.viuva.create({
      data: { idCaixa: caixa.id, idCasal: casal.id, idLinhagem: casal.idLinhagem, dtViuvez: paraData(dados.dtViuvez), idUsuario },
      select: { id: true },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'viuva',
      idEntidade: viuva.id,
      acao: 'formacao',
      descricao: `Fêmea do casal ${casal.identificacao.trim()} (caixa ${casal.caixa.codigo}) foi para a caixa de viúvas ${caixa.codigo} em ${dataLegivel(dados.dtViuvez)}`,
      dados: { idCasal: casal.id, idCaixaDeOrigem: casal.idCaixa, idCaixa: caixa.id, dtViuvez: dados.dtViuvez },
    })

    return { idCaixa: caixa.id, idViuva: viuva.id }
  })
}

export type ViuvaNaFicha = {
  id: number
  caixaDeOrigem: string
  dtViuvez: string
}

export async function viuvasDaFicha(idCaixa: number): Promise<ViuvaNaFicha[]> {
  const viuvas = await prisma.viuva.findMany({
    where: { idCaixa },
    orderBy: [{ dtViuvez: 'asc' }, { id: 'asc' }],
    select: { id: true, dtViuvez: true, casal: { select: { caixa: { select: { codigo: true } } } } },
  })

  return viuvas.map((viuva) => ({
    id: viuva.id,
    caixaDeOrigem: viuva.casal.caixa.codigo,
    dtViuvez: dataISO(viuva.dtViuvez),
  }))
}
