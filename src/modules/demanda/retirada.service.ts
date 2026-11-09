// De que caixas tirar os animais de um pedido na entrega: onde os reservados estao de fato. Se o
// tecnico juntou os reservados numa caixa, a retirada mostra essa caixa

import { naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO } from '../../shared/traducao.ts'
import { sexoDe } from '../colonia/tipos.ts'
import type { Sexo } from '../colonia/tipos.ts'

/** Os reservados de uma caixa, de um sexo e de uma data de nascimento */
export type LugarDaRetirada = {
  tipo: 'casal' | 'estoque'
  codigo: string
  numeroVisivel: string
  sexo: Sexo
  /** 'aaaa-mm-dd' */
  dtNascimento: string
  qtd: number
  /** de qual parto saem os animais */
  partos: { ordem: number; casal: string }[]
}

/**
 * GET /api/pedidos/:id/retirada - os vivos reservados para o pedido, agrupados por caixa,
 * sexo e data de nascimento, na ordem da estante
 */
export async function retiradaDoPedido(idPedido: number) {
  const pedido = await prisma.pedido.findUnique({ where: { id: idPedido }, select: { id: true } })
  if (pedido === null) throw naoEncontrado('Pedido')

  const linhas = await prisma.animal.groupBy({
    by: ['idCaixa', 'idParto', 'sexo'],
    where: { idPedido, situacao: 'vivo' },
    _count: { _all: true },
  })

  const [caixas, partos] = await Promise.all([
    prisma.caixa.findMany({
      where: { id: { in: [...new Set(linhas.map((linha) => linha.idCaixa))] } },
      select: { id: true, codigo: true, tipo: true, estante: { select: { numeroVisivel: true } } },
    }),
    prisma.parto.findMany({
      where: { id: { in: [...new Set(linhas.map((linha) => linha.idParto))] } },
      orderBy: { id: 'asc' },
      select: { id: true, ordem: true, dtPartoReal: true, casal: { select: { identificacao: true } } },
    }),
  ])

  const porLugar = new Map<string, LugarDaRetirada>()

  for (const linha of linhas) {
    const caixa = caixas.find((c) => c.id === linha.idCaixa)
    const parto = partos.find((p) => p.id === linha.idParto)
    if (caixa === undefined || parto === undefined || parto.dtPartoReal === null) continue

    const sexo = sexoDe(linha)
    const dtNascimento = dataISO(parto.dtPartoReal)
    const chave = `${caixa.id}:${sexo}:${dtNascimento}`
    const lugar = porLugar.get(chave) ?? {
      tipo: caixa.tipo === 'estoque' ? 'estoque' : 'casal',
      codigo: caixa.codigo,
      numeroVisivel: caixa.estante.numeroVisivel,
      sexo,
      dtNascimento,
      qtd: 0,
      partos: [],
    }

    lugar.qtd += linha._count._all
    lugar.partos.push({ ordem: parto.ordem, casal: parto.casal.identificacao.trim() })
    porLugar.set(chave, lugar)
  }

  return {
    retirada: [...porLugar.values()].sort(
      (a, b) =>
        a.numeroVisivel.localeCompare(b.numeroVisivel) ||
        a.codigo.localeCompare(b.codigo) ||
        a.sexo.localeCompare(b.sexo) ||
        a.dtNascimento.localeCompare(b.dtNascimento),
    ),
  }
}
