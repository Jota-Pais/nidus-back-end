// As baixas lancadas da ficha de uma caixa que ainda podem ser anuladas, da mais recente para a
// mais antiga: o botao Anular da ficha. O resto do que aconteceu com a caixa fica no registro e
// na tela Historico do gestor

import { prisma } from '../../shared/prisma.ts'
import { dataISO } from '../../shared/traducao.ts'
import { descreverOcorrencia, selecaoDaDescricao } from '../colonia/descricao.ts'
import { animalDaBaixa, selecaoDaCaixaDaBaixa, selecaoDoAnimalDaBaixa, voltaNaOrigem } from '../colonia/baixa.service.ts'
import { contarPorSexo } from '../colonia/tipos.ts'
import type { PorSexo } from '../colonia/tipos.ts'
import { NOME_DO_SISTEMA } from '../historico/historico.service.ts'

export type BaixaDaFicha = {
  /** o dia da baixa, 'aaaa-mm-ddT00:00:00.000Z' */
  dataHora: string
  tipo: string
  descricao: string
  autor: string
  idOcorrencia: number
  anulavel: boolean
  /** o que a anulacao dela precisa saber antes */
  baixa: BaixaAnulavel | null
}

/** O que a anulacao de uma baixa pede: quantos de cada sexo, a linhagem e para onde voltam */
export type BaixaAnulavel = {
  sexos: PorSexo
  idLinhagem: number
  /** a caixa da baixa ainda recebe a volta (porQueNaoVolta); senao, a anulacao pede caixa de estoque */
  voltaNaOrigem: boolean
}

/** As baixas da caixa, com a descricao e quem lancou */
function lerBaixas(idCaixa: number) {
  return prisma.ocorrencia.findMany({
    where: { tipo: 'baixa', OR: [{ idCaixaOrigem: idCaixa }, { idCaixaDestino: idCaixa }] },
    orderBy: [{ dtFato: 'desc' }, { id: 'desc' }],
    select: { ...selecaoDaDescricao, dtFato: true, dtRegistro: true, usuario: { select: { nome: true } } },
  })
}

type BaixaLida = Awaited<ReturnType<typeof lerBaixas>>[number]

/**
 * O que a anulacao de cada baixa pede, por id: os animais dela por sexo, a linhagem deles e se a
 * caixa da baixa ainda os recebe, pela mesma regra da anulacao (voltaNaOrigem)
 */
async function oQueAnulacaoPede(baixas: BaixaLida[]): Promise<Map<number, BaixaAnulavel>> {
  const porId = new Map<number, BaixaAnulavel>()
  if (baixas.length === 0) return porId

  const ligacoes = await prisma.ocorrenciaAnimal.findMany({
    where: { idOcorrencia: { in: baixas.map((baixa) => baixa.id) } },
    orderBy: [{ idOcorrencia: 'asc' }, { idAnimal: 'asc' }],
    select: { idOcorrencia: true, animal: { select: selecaoDoAnimalDaBaixa } },
  })
  const caixas = await prisma.caixa.findMany({
    where: { id: { in: baixas.flatMap((baixa) => baixa.idCaixaOrigem ?? []) } },
    select: selecaoDaCaixaDaBaixa,
  })

  // uma baixa de cada vez: a regra le as ninhadas da caixa, e a ficha tem poucas baixas
  for (const baixa of baixas) {
    const animais = ligacoes
      .filter((ligacao) => ligacao.idOcorrencia === baixa.id)
      .map((ligacao) => animalDaBaixa(ligacao.animal))
    const origem = caixas.find((caixa) => caixa.id === baixa.idCaixaOrigem)
    const [primeiro] = animais
    if (origem === undefined || primeiro === undefined) continue

    porId.set(baixa.id, {
      sexos: contarPorSexo(animais),
      idLinhagem: primeiro.idLinhagem,
      voltaNaOrigem: await voltaNaOrigem(prisma, origem, animais),
    })
  }

  return porId
}

/** As baixas da ficha da caixa que ainda podem ser anuladas, da mais recente para a mais antiga */
export async function baixasDaCaixa(idCaixa: number): Promise<BaixaDaFicha[]> {
  const lidas = await lerBaixas(idCaixa)
  const anulaveis = lidas.filter((baixa) => baixa.anulacoes.length === 0)
  const pedido = await oQueAnulacaoPede(anulaveis)

  return anulaveis.map((baixa) => ({
    dataHora: `${dataISO(baixa.dtFato)}T00:00:00.000Z`,
    tipo: baixa.tipo,
    descricao: descreverOcorrencia(baixa, idCaixa),
    autor: baixa.usuario?.nome ?? NOME_DO_SISTEMA,
    idOcorrencia: baixa.id,
    anulavel: true,
    baixa: pedido.get(baixa.id) ?? null,
  }))
}
