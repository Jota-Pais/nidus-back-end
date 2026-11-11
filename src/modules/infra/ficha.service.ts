// A ficha da caixa (GET /api/caixas/:id). A de casal mostra o casal, os partos (1 a 5), os casais
// que vieram antes; a de estoque, os vivos por data de nascimento com as origens, os
// pedidos com reservado nela e os casais da caixa, se ela ja foi de casal. Tudo
// contado nos animais: nenhum numero vem gravado

import { naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { codigoDaEspecie, dataISO } from '../../shared/traducao.ts'
import { chegadaDosAnimais } from '../colonia/escolha.ts'
import { semVivos, vivosNasCaixas } from '../colonia/consultas.ts'
import { faseDaCaixa } from '../colonia/fase.ts'
import type { MotivoDaLiberacao, Sexo } from '../colonia/tipos.ts'
import { cicloFicha } from '../reproducao/cicloFicha.ts'
import { casalFicha } from '../reproducao/reproducao.service.ts'
import { gruposPorNascimento, partoPrevisto } from './card.ts'
import { viradaParaEstoque } from './mudanca.service.ts'

/** Os partos do casal, do 1o ao ultimo, como a ficha mostra */
async function partosDoCasal(idCasal: number) {
  const partos = await prisma.parto.findMany({ where: { idCasal }, orderBy: { ordem: 'asc' }, select: { id: true } })

  // No maximo 5 partos por casal: N+1 aqui e uma ficha aberta por vez, nao uma lista
  return Promise.all(partos.map((parto) => cicloFicha(parto.id)))
}

/** Os casais da caixa, cada um com os partos, na ordem em que vieram: o ativo (ou o mais recente) primeiro */
function casaisComPartos(idsCasal: number[]) {
  return Promise.all(
    idsCasal.map(async (idCasal) => {
      const [casal, partos] = await Promise.all([casalFicha(idCasal), partosDoCasal(idCasal)])
      return { casal, partos }
    }),
  )
}

/** Os vivos da caixa um a um, com o que cada idade da ficha de estoque mostra alem das contagens */
function vivosUmAUm(idCaixa: number) {
  return prisma.animal.findMany({
    where: { idCaixa, situacao: 'vivo' },
    orderBy: { id: 'asc' },
    select: { idPedido: true, dtMovimento: true, parto: { select: { dtPartoReal: true } } },
  })
}

type VivoUmAUm = Awaited<ReturnType<typeof vivosUmAUm>>[number]

/**
 * Os vivos de uma idade na caixa: os reservados por pedido e a chegada mais recente deles na caixa,
 * a mesma que a baixa, a mudanca e a entrega conferem (chegadaDosAnimais) quando todos os escolhidos
 * sao desta idade
 */
function daIdade(vivos: VivoUmAUm[], dtNascimento: string) {
  const daqui = vivos.filter((animal) => animal.parto.dtPartoReal !== null && dataISO(animal.parto.dtPartoReal) === dtNascimento)
  const pedidos = new Map<number, number>()

  for (const animal of daqui) {
    if (animal.idPedido !== null) pedidos.set(animal.idPedido, (pedidos.get(animal.idPedido) ?? 0) + 1)
  }

  const chegada = chegadaDosAnimais(daqui)

  return {
    /** os reservados desta idade, por pedido */
    pedidos: [...pedidos.entries()].sort(([a], [b]) => a - b).map(([idPedido, qtd]) => ({ idPedido, qtd })),
    /** a chegada mais recente dos vivos desta idade na caixa; null se nenhum chegou de outra */
    dtChegada: chegada === null ? null : dataISO(chegada),
  }
}

/**
 * GET /api/caixas/:id - a ficha da caixa, de casal ou de estoque. 'fase' e 'atrasado' sao os da
 * grade (faseDaCaixa): null na caixa liberada
 */
export async function montarFicha(idCaixa: number) {
  const caixa = await prisma.caixa.findUnique({
    where: { id: idCaixa },
    select: {
      id: true,
      codigo: true,
      tipo: true,
      sexo: true,
      idLinhagem: true,
      ativa: true,
      dtLiberacao: true,
      motivoLiberacao: true,
      especie: { select: { nome: true } },
      linhagem: { select: { nome: true } },
      estante: { select: { numeroVisivel: true, sala: { select: { nome: true } } } },
      // o casal ativo (ou o mais recente, a ficha e historico) primeiro, e depois os que vieram antes
      casais: {
        orderBy: [{ ativo: 'desc' }, { dtFormacao: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          partos: {
            orderBy: { ordem: 'asc' },
            select: { ordem: true, dtAcasalamento: true, dtPartoReal: true, dtSemNinhada: true },
          },
        },
      },
    },
  })

  if (caixa === null) throw naoEncontrado('Caixa')

  const [vivos, casais] = await Promise.all([
    vivosNasCaixas(prisma, [idCaixa]),
    casaisComPartos(caixa.casais.map((casal) => casal.id)),
  ])
  const naCaixa = vivos.get(idCaixa) ?? semVivos()

  const total = naCaixa.vivos.m + naCaixa.vivos.f
  const reservado = naCaixa.reservados.m + naCaixa.reservados.f
  const dtLiberacao = caixa.dtLiberacao === null ? null : dataISO(caixa.dtLiberacao)
  const motivoLiberacao = caixa.motivoLiberacao as MotivoDaLiberacao | null
  const deEstoque = caixa.tipo === 'estoque'

  const dadosDaCaixa = {
    id: caixa.id,
    endereco: { numeroVisivel: caixa.estante.numeroVisivel, sala: caixa.estante.sala.nome, codigo: caixa.codigo },
    especie: codigoDaEspecie(caixa.especie.nome),
    ...faseDaCaixa({
      tipo: deEstoque ? 'estoque' : 'casal',
      ativa: caixa.ativa,
      ninhadas: naCaixa.partos,
      // o casal da caixa e o primeiro: o ativo, ou o mais recente
      partoPrevisto: deEstoque || caixa.casais[0] === undefined ? null : partoPrevisto(caixa.casais[0].partos),
    }),
    ativa: caixa.ativa,
    dtLiberacao,
    motivoLiberacao,
  }

  if (deEstoque) {
    const grupos = gruposPorNascimento(naCaixa.partos)
    const umAUm = await vivosUmAUm(idCaixa)

    return {
      tipo: 'estoque' as const,
      caixa: {
        ...dadosDaCaixa,
        linhagem: caixa.linhagem?.nome ?? null,
        idLinhagem: caixa.idLinhagem,
        sexo: (caixa.sexo === 'M' ? 'M' : 'F') as Sexo,
      },
      total,
      reservado,
      livre: total - reservado,
      nascimentoDe: grupos[0]?.dtNascimento ?? null,
      nascimentoAte: grupos.at(-1)?.dtNascimento ?? null,
      /** os vivos por data de nascimento, com os partos de onde vieram */
      grupos: grupos.map(({ partos, ...grupo }) => ({
        ...grupo,
        ...daIdade(umAUm, grupo.dtNascimento),
        origens: partos.map((parto) => ({
          idParto: parto.idParto,
          ordem: parto.ordem,
          casal: parto.casal,
          codigoOrigem: parto.caixaDoCasal.codigo,
          numeroVisivelOrigem: parto.caixaDoCasal.numeroVisivel,
          qtd: parto.vivos.m + parto.vivos.f,
        })),
      })),
      /** o que cada pedido tem reservado nesta caixa */
      pedidos: naCaixa.pedidos.map((pedido) => ({ idPedido: pedido.idPedido, qtd: pedido.m + pedido.f })),
      /** os casais da caixa, quando ela era de casal antes de virar de estoque */
      casaisAnteriores: casais,
    }
  }

  const [atual, ...anteriores] = casais

  const virada = viradaParaEstoque({
    codigo: caixa.codigo,
    ativa: caixa.ativa,
    tipo: caixa.tipo,
    casalAtivo: casais.some(({ casal }) => casal.ativo),
    partoPendente: casais.some(({ partos }) =>
      partos.some((parto) => parto.dtPartoReal === null && parto.dtSemNinhada === null),
    ),
    ninhadas: naCaixa.partos,
  })

  return {
    tipo: 'casal' as const,
    /** o sexo que a caixa teria se virasse de estoque no lugar; null quando nao pode */
    virarEstoque: 'recusa' in virada ? null : virada.sexo,
    // a linhagem vem do casal, e aparece mesmo com o casal encerrado: a ficha e historico
    caixa: { ...dadosDaCaixa, linhagem: atual?.casal.linhagem ?? null, idLinhagem: atual?.casal.idLinhagem ?? null },
    casal: atual?.casal ?? null,
    partos: atual?.partos ?? [],
    /** os casais que vieram antes do atual nesta caixa, com os partos deles */
    anteriores,
  }
}
