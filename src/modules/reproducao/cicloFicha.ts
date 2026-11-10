// A ficha de um parto: as datas do ciclo e as contagens, todas contadas nos animais do parto,
// estejam onde estiverem. Nenhum numero vem gravado no parto

import { naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO } from '../../shared/traducao.ts'
import { animaisDoParto } from '../colonia/consultas.ts'
import type { AnimalDoParto } from '../colonia/consultas.ts'
import { contarPorSexo, sexoDe, somarUm } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { calcularCicloInicial, calcularDesmamePrevisto } from './cadeiaTemporal.ts'
import { limitesDoDesmame, primeiraSaida, primeiroFatoDoNascimento } from './trilhaDoParto.ts'

/** Uma caixa onde estao vivos do parto */
export type OndeEstao = {
  idCaixa: number
  codigo: string
  numeroVisivel: string
  tipo: string
  m: number
  f: number
  reservados: number
  /** os vivos reservados nesta caixa, por pedido */
  pedidos: (PorSexo & { idPedido: number })[]
}

export type ContagemDoParto = {
  /** Os que nasceram: todo animal do parto menos o registro anulado */
  nascidos: PorSexo
  /** Os mortos ate o desmame (no dia do desmame inclusive), ou ate agora se nao desmamou */
  baixasAntesDoDesmame: PorSexo
  /** Os que chegaram vivos ao desmame. Null enquanto nao desmamou */
  desmamados: PorSexo | null
  vivos: PorSexo
  entregues: PorSexo
  onde: OndeEstao[]
  reservados: (PorSexo & { idPedido: number })[]
}

/** As contagens por pedido, em ordem de pedido */
function porPedido(contagens: Map<number, PorSexo>): (PorSexo & { idPedido: number })[] {
  return [...contagens.entries()].sort(([a], [b]) => a - b).map(([idPedido, qtd]) => ({ idPedido, ...qtd }))
}

/** As contagens do parto a partir dos seus animais */
export function contarDoParto(dtDesmameReal: Date | null, animais: AnimalDoParto[]): ContagemDoParto {
  const existiram = animais.filter((animal) => animal.situacao !== 'anulado')
  const vivos = animais.filter((animal) => animal.situacao === 'vivo')
  const mortosAntes = animais.filter(
    (animal) =>
      animal.situacao === 'morto' &&
      (dtDesmameReal === null || (animal.dtSaida !== null && animal.dtSaida <= dtDesmameReal)),
  )
  const baixasAntesDoDesmame = contarPorSexo(mortosAntes)
  const nascidos = contarPorSexo(existiram)

  const onde = new Map<number, Omit<OndeEstao, 'pedidos'>>()
  const pedidosNaCaixa = new Map<number, Map<number, PorSexo>>()
  const reservados = new Map<number, PorSexo>()

  for (const animal of vivos) {
    const lugar = onde.get(animal.idCaixa) ?? {
      idCaixa: animal.idCaixa,
      codigo: animal.caixa.codigo,
      numeroVisivel: animal.caixa.estante.numeroVisivel,
      tipo: animal.caixa.tipo,
      m: 0,
      f: 0,
      reservados: 0,
    }
    const sexo = sexoDe(animal)

    onde.set(animal.idCaixa, {
      ...lugar,
      m: lugar.m + (sexo === 'M' ? 1 : 0),
      f: lugar.f + (sexo === 'F' ? 1 : 0),
      reservados: lugar.reservados + (animal.idPedido === null ? 0 : 1),
    })

    if (animal.idPedido !== null) {
      reservados.set(animal.idPedido, somarUm(reservados.get(animal.idPedido) ?? { m: 0, f: 0 }, sexo))

      const naCaixa = pedidosNaCaixa.get(animal.idCaixa) ?? new Map<number, PorSexo>()
      naCaixa.set(animal.idPedido, somarUm(naCaixa.get(animal.idPedido) ?? { m: 0, f: 0 }, sexo))
      pedidosNaCaixa.set(animal.idCaixa, naCaixa)
    }
  }

  return {
    nascidos,
    baixasAntesDoDesmame,
    desmamados:
      dtDesmameReal === null
        ? null
        : { m: nascidos.m - baixasAntesDoDesmame.m, f: nascidos.f - baixasAntesDoDesmame.f },
    vivos: contarPorSexo(vivos),
    entregues: contarPorSexo(animais.filter((animal) => animal.situacao === 'entregue')),
    onde: [...onde.values()]
      .sort((a, b) => a.idCaixa - b.idCaixa)
      .map((lugar) => ({ ...lugar, pedidos: porPedido(pedidosNaCaixa.get(lugar.idCaixa) ?? new Map()) })),
    reservados: porPedido(reservados),
  }
}

const iso = (data: Date | null) => (data === null ? null : dataISO(data))

/**
 * O objeto parto da ficha, reaproveitado pela ficha da caixa. As datas
 * previstas sao calculadas da cadeia temporal
 */
export async function cicloFicha(idParto: number) {
  const parto = await prisma.parto.findUnique({
    where: { id: idParto },
    select: {
      id: true,
      ordem: true,
      dtAcasalamento: true,
      dtPartoReal: true,
      dtDesmameReal: true,
      dtSemNinhada: true,
      motivoSemNinhada: true,
      casal: { select: { idCaixa: true } },
    },
  })

  if (parto === null) {
    throw naoEncontrado('Parto')
  }

  const contagem = contarDoParto(parto.dtDesmameReal, await animaisDoParto(prisma, idParto))
  const dtPartoPrevisto = calcularCicloInicial(dataISO(parto.dtAcasalamento)).dtPartoPrevisto
  const dtPartoReal = iso(parto.dtPartoReal)
  const nasceu = dtPartoReal !== null
  // os limites que as correcoes conferem, das mesmas funcoes que recusam a data fora deles. O parto
  // que nao nasceu nao tem animal, nem trilha que limite
  const desmame = nasceu ? await limitesDoDesmame(prisma, parto) : null
  const primeiroFato = nasceu ? await primeiroFatoDoNascimento(prisma, idParto) : null

  return {
    id: parto.id,
    ordem: parto.ordem,
    dtAcasalamento: dataISO(parto.dtAcasalamento),
    dtPartoPrevisto,
    dtPartoReal,
    dtDesmamePrevisto: calcularDesmamePrevisto(dtPartoPrevisto, dtPartoReal),
    dtDesmameReal: iso(parto.dtDesmameReal),
    /** O parto de casal encerrado que nao nasceu e foi fechado sem ninhada */
    dtSemNinhada: iso(parto.dtSemNinhada),
    motivoSemNinhada: parto.motivoSemNinhada,
    nascidoM: nasceu ? contagem.nascidos.m : null,
    nascidoF: nasceu ? contagem.nascidos.f : null,
    baixasAntesDoDesmame: contagem.baixasAntesDoDesmame,
    desmamadoM: contagem.desmamados?.m ?? null,
    desmamadoF: contagem.desmamados?.f ?? null,
    vivos: contagem.vivos,
    /** As caixas onde estao os vivos do parto, com quantos de cada sexo e quantos reservados */
    onde: contagem.onde,
    /** Os vivos reservados, por pedido */
    reservados: contagem.reservados,
    entregues: contagem.entregues,
    /** a ultima eutanasia de selecao nao anulada: o desmame nao fica antes dela */
    dtUltimaSelecao: iso(desmame?.ultimaSelecao ?? null),
    /** o primeiro dia em que um animal do parto deixou a caixa do casal: o desmame nao passa dele */
    dtPrimeiraSaida: iso(desmame === null ? null : primeiraSaida(desmame)),
    /** a primeira baixa, mudanca ou entrega nao anulada dos animais: o nascimento nao passa dela */
    dtPrimeiroFato: iso(primeiroFato?.dtFato ?? null),
  }
}

export type CicloFicha = Awaited<ReturnType<typeof cicloFicha>>
