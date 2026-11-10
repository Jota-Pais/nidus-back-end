// O card de cada caixa, como a grade da estante mostra (spec do cliente, secao 1.13).
// A caixa de casal mostra o casal, o parto em curso, a previsao do proximo e os vivos dela por
// ninhada; a de estoque, o sexo, a linhagem e os vivos por data de nascimento. Os numeros sao
// todos contados nos animais (vivosNasCaixas), e a fase (a cor na grade) sai de faseDaCaixa

import type { Prisma } from '@prisma/client'
import { MAX_PARTOS_POR_CASAL } from '../../shared/parametros.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import { semVivos, vivosNasCaixas } from '../colonia/consultas.ts'
import { faseDaCaixa } from '../colonia/fase.ts'
import type { Fase } from '../colonia/fase.ts'
import type { VivosDoParto, VivosNaCaixa } from '../colonia/consultas.ts'
import type { PorSexo, Sexo } from '../colonia/tipos.ts'
import { calcularCicloInicial, diasEntre } from '../reproducao/cadeiaTemporal.ts'

// ------------------------------------------------------------ o casal

type PartoDoCard = { ordem: number; dtAcasalamento: Date; dtPartoReal: Date | null; dtSemNinhada: Date | null }

type CasalDoCard = {
  identificacao: string
  ativo: boolean
  /** em ordem crescente de 'ordem' */
  partos: PartoDoCard[]
}

/**
 * O parto em curso: o ultimo aberto. O 1o nasce com o casal e cada seguinte no acasalamento dele,
 * entao com o acasalamento do 2o registrado o casal ja esta no 2o, mesmo antes do nascimento.
 * Nunca passa de 5
 */
export function partoAtual(partos: PartoDoCard[]): number {
  return Math.max(1, Math.min(partos.length, MAX_PARTOS_POR_CASAL))
}

/**
 * A previsao do parto pendente (nem nasceu, nem foi fechado sem ninhada), ou null quando nao ha.
 * Vale tambem para o casal encerrado: a femea ainda pare o que carrega
 */
export function partoPrevisto(partos: PartoDoCard[]): string | null {
  const pendente = partos.find((parto) => parto.dtPartoReal === null && parto.dtSemNinhada === null)
  return pendente === undefined ? null : calcularCicloInicial(dataISO(pendente.dtAcasalamento)).dtPartoPrevisto
}

/** Uma ninhada no card: os vivos de um parto que estao nesta caixa, com a idade de hoje */
export type NinhadaNoCard = PorSexo & { casal: string; parto: number; idadeDias: number; mamando: boolean }

function ninhadaNoCard(parto: VivosDoParto, hoje: string): NinhadaNoCard {
  return {
    casal: parto.casal,
    parto: parto.ordem,
    m: parto.vivos.m,
    f: parto.vivos.f,
    idadeDias: diasEntre(parto.dtNascimento, hoje),
    mamando: !parto.desmamado,
  }
}

/**
 * O casal no card: o casal da caixa (o ativo, ou o mais recente), o parto em curso, a previsao
 * do pendente e as ninhadas, que sao os vivos da caixa por parto, inclusive a que um casal
 * encerrado deixou nela. 'reservado' e quantos desses vivos estao reservados. Null sem casal
 */
export function casalNoCard(casal: CasalDoCard | undefined, naCaixa: VivosNaCaixa, hoje: string = hojeISO()) {
  if (casal === undefined) return null

  const ninhadas = naCaixa.partos.map((parto) => ninhadaNoCard(parto, hoje))

  return {
    identificacao: casal.identificacao.trim(),
    partoAtual: partoAtual(casal.partos),
    partoPrevisto: partoPrevisto(casal.partos),
    encerrado: !casal.ativo,
    aguardandoDesmame: !casal.ativo && ninhadas.some((ninhada) => ninhada.mamando),
    ninhadas,
    reservado: naCaixa.reservados.m + naCaixa.reservados.f,
  }
}

// ------------------------------------------------------------ o estoque

/** Os vivos da caixa que nasceram no mesmo dia: dentro da caixa, so a idade distingue os ratos */
export type GrupoPorNascimento = {
  /** 'aaaa-mm-dd' */
  dtNascimento: string
  idadeDias: number
  total: number
  reservados: number
  livres: number
  /** os partos de onde vieram, do mais antigo para o mais novo */
  partos: VivosDoParto[]
}

const somaDe = (contagem: PorSexo) => contagem.m + contagem.f

/** Os vivos da caixa agrupados por data de nascimento, do mais velho para o mais novo */
export function gruposPorNascimento(partos: VivosDoParto[], hoje: string = hojeISO()): GrupoPorNascimento[] {
  const porData = new Map<string, GrupoPorNascimento>()

  for (const parto of partos) {
    const grupo = porData.get(parto.dtNascimento) ?? {
      dtNascimento: parto.dtNascimento,
      idadeDias: diasEntre(parto.dtNascimento, hoje),
      total: 0,
      reservados: 0,
      livres: 0,
      partos: [],
    }

    grupo.total += somaDe(parto.vivos)
    grupo.reservados += somaDe(parto.reservados)
    grupo.livres = grupo.total - grupo.reservados
    grupo.partos.push(parto)
    porData.set(parto.dtNascimento, grupo)
  }

  return [...porData.values()].sort((a, b) => a.dtNascimento.localeCompare(b.dtNascimento))
}

/**
 * A caixa de estoque no card e na grade: o sexo e a linhagem dela (a MiniGrade filtra os destinos
 * da mudanca por eles), quantos vivos tem, quantos reservados e as idades por data de nascimento
 */
export function estoqueNoCard(
  caixa: { sexo: string | null; idLinhagem: number | null },
  naCaixa: VivosNaCaixa,
  hoje: string = hojeISO(),
) {
  const grupos = gruposPorNascimento(naCaixa.partos, hoje)

  return {
    sexo: (caixa.sexo === 'M' ? 'M' : 'F') as Sexo,
    idLinhagem: caixa.idLinhagem,
    total: somaDe(naCaixa.vivos),
    reservado: somaDe(naCaixa.reservados),
    nascimentoDe: grupos[0]?.dtNascimento ?? null,
    nascimentoAte: grupos.at(-1)?.dtNascimento ?? null,
    grupos: grupos.map(({ dtNascimento, idadeDias, total, reservados }) => ({
      dtNascimento,
      idadeDias,
      total,
      reservados,
    })),
  }
}

// ------------------------------------------------------------ a leitura

const selecaoDaCaixaDoCard = {
  id: true,
  face: true,
  linha: true,
  coluna: true,
  codigo: true,
  tipo: true,
  sexo: true,
  idLinhagem: true,
  ativa: true,
  estante: { select: { numeroVisivel: true } },
  linhagem: { select: { nome: true } },
  // o casal da caixa: o ativo, ou o mais recente
  casais: {
    orderBy: [{ ativo: 'desc' }, { dtFormacao: 'desc' }, { id: 'desc' }],
    take: 1,
    select: {
      identificacao: true,
      ativo: true,
      idLinhagem: true,
      linhagem: { select: { nome: true } },
      partos: {
        orderBy: { ordem: 'asc' },
        select: { ordem: true, dtAcasalamento: true, dtPartoReal: true, dtSemNinhada: true },
      },
    },
  },
} satisfies Prisma.CaixaSelect

type Leitura = Pick<Prisma.TransactionClient, 'caixa' | 'animal' | 'parto' | 'pedido'>

/** Uma caixa com o card dela: o endereco, a fase (a cor na grade) e o que mostra */
export type CardDaCaixa = {
  id: number
  face: number
  linha: number
  coluna: number
  codigo: string
  numeroVisivel: string
  /** a fase da caixa (faseDaCaixa); null na liberada e na de casal sem ciclo aberto */
  fase: Fase | null
  /** o parto previsto passou sem nascimento, ou um filhote passou da idade de desmamar */
  atrasado: boolean
  /** a linhagem da caixa de estoque, ou a do casal da caixa; null sem nenhuma */
  idLinhagem: number | null
  linhagem: string | null
  casal: ReturnType<typeof casalNoCard>
  estoque: ReturnType<typeof estoqueNoCard> | null
}

/**
 * As caixas que atendem o filtro, cada uma com o card, numa leitura so: as caixas, depois os
 * vivos de todas elas. Na ordem da estante (estante, face, linha, coluna)
 */
export async function lerCards(banco: Leitura, onde: Prisma.CaixaWhereInput, hoje: string = hojeISO()) {
  const caixas = await banco.caixa.findMany({
    where: onde,
    orderBy: [{ idEstante: 'asc' }, { face: 'asc' }, { linha: 'asc' }, { coluna: 'asc' }, { id: 'asc' }],
    select: selecaoDaCaixaDoCard,
  })

  const vivos = await vivosNasCaixas(
    banco,
    caixas.map((caixa) => caixa.id),
  )

  return caixas.map((caixa): CardDaCaixa => {
    const naCaixa = vivos.get(caixa.id) ?? semVivos()
    const [casal] = caixa.casais
    const deEstoque = caixa.tipo === 'estoque'

    return {
      id: caixa.id,
      face: caixa.face,
      linha: caixa.linha,
      coluna: caixa.coluna,
      codigo: caixa.codigo,
      numeroVisivel: caixa.estante.numeroVisivel,
      ...faseDaCaixa(
        {
          tipo: deEstoque ? 'estoque' : 'casal',
          ativa: caixa.ativa,
          ninhadas: naCaixa.partos,
          partoPrevisto: casal === undefined ? null : partoPrevisto(casal.partos),
        },
        hoje,
      ),
      idLinhagem: deEstoque ? caixa.idLinhagem : (casal?.idLinhagem ?? null),
      linhagem: deEstoque ? (caixa.linhagem?.nome ?? null) : (casal?.linhagem.nome ?? null),
      casal: deEstoque ? null : casalNoCard(casal, naCaixa, hoje),
      estoque: deEstoque ? estoqueNoCard(caixa, naCaixa, hoje) : null,
    }
  })
}
