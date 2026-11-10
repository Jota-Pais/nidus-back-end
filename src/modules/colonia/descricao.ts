// O texto de uma ocorrencia da trilha, num lugar so: a ficha da caixa o mostra visto da caixa
// ("2 machos chegaram da caixa F1A"), e a tela Historico, sem ponto de vista ("2 machos mudaram da
// caixa F1A para a caixa F2C"). A quantidade sai de quantosAnimais e o verbo concorda com ela

import type { Prisma } from '@prisma/client'
import { MOTIVO_NAO_CHEGOU_AO_DESMAME, MOTIVO_SELECAO, contarPorSexo, noNumero, quantosAnimais } from './tipos.ts'
import type { PorSexo } from './tipos.ts'

/** O que o texto le da ocorrencia */
export const selecaoDaDescricao = {
  id: true,
  tipo: true,
  idCaixaOrigem: true,
  idCaixaDestino: true,
  idPedido: true,
  motivo: true,
  parto: { select: { ordem: true, casal: { select: { identificacao: true } } } },
  caixaOrigem: { select: { codigo: true } },
  caixaDestino: { select: { codigo: true } },
  // basta saber se a baixa tem anulacao: a primeira diz
  anulacoes: { select: { id: true }, take: 1 },
  animais: { select: { animal: { select: { sexo: true, idCaixa: true } } } },
} satisfies Prisma.OcorrenciaSelect

export type OcorrenciaDescrita = Prisma.OcorrenciaGetPayload<{ select: typeof selecaoDaDescricao }>

/** O verbo concorda com os animais; 'nenhum animal' tambem pede o singular */
function concordar(qtd: PorSexo, singular: string, plural: string): string {
  return noNumero(Math.max(qtd.m + qtd.f, 1), singular, plural)
}

/** Os animais e o verbo: '2 machos e 1 femea mudaram', '1 femea mudou', 'nenhum animal mudou' */
function comVerbo(qtd: PorSexo, singular: string, plural: string): string {
  return `${quantosAnimais(qtd)} ${concordar(qtd, singular, plural)}`
}

function doParto(ocorrencia: OcorrenciaDescrita): string {
  const { parto } = ocorrencia
  return parto === null ? '' : ` do ${parto.ordem}º parto do casal ${parto.casal.identificacao.trim()}`
}

function descricaoDaBaixa(ocorrencia: OcorrenciaDescrita, qtd: PorSexo, naCaixa: string): string {
  const anulada = ocorrencia.anulacoes.length === 0 ? '' : ' (anulada)'

  if (ocorrencia.motivo === MOTIVO_SELECAO) {
    return `Eutanásia de seleção${doParto(ocorrencia)}: ${quantosAnimais(qtd)}.${anulada}`
  }

  if (ocorrencia.motivo === MOTIVO_NAO_CHEGOU_AO_DESMAME) {
    const quem = `${quantosAnimais(qtd)}${doParto(ocorrencia)}`
    return `${quem} ${concordar(qtd, 'não chegou', 'não chegaram')} ao desmame.${anulada}`
  }

  return `Baixa de ${quantosAnimais(qtd)}${naCaixa}${ocorrencia.motivo === null ? '' : `: ${ocorrencia.motivo}`}.${anulada}`
}

/**
 * A anulacao de uma baixa: cada ocorrencia leva os animais que voltaram para uma caixa, a da baixa
 * (sem destino) ou a de estoque indicada para o sexo. Vista da caixa da baixa, da caixa para onde
 * voltaram, ou sem ponto de vista
 */
function descricaoDaAnulacao(ocorrencia: OcorrenciaDescrita, qtd: PorSexo, daCaixa: number | undefined): string {
  const origem = ocorrencia.caixaOrigem?.codigo ?? ''
  const motivo = ` Motivo: ${ocorrencia.motivo ?? ''}`
  const voltaram = comVerbo(qtd, 'voltou', 'voltaram')

  if (ocorrencia.idCaixaDestino === null) {
    return `Baixa anulada: ${voltaram} a viver${daCaixa === undefined ? ` na caixa ${origem}` : ''}.${motivo}`
  }

  const destino = ocorrencia.caixaDestino?.codigo ?? ''

  if (daCaixa === ocorrencia.idCaixaOrigem) return `Baixa anulada: ${voltaram} para a caixa ${destino}.${motivo}`
  if (daCaixa === ocorrencia.idCaixaDestino) return `Baixa da caixa ${origem} anulada: ${voltaram} para esta caixa.${motivo}`

  return `Baixa da caixa ${origem} anulada: ${voltaram} para a caixa ${destino}.${motivo}`
}

/**
 * O texto da ocorrencia. Com 'daCaixa', visto dessa caixa: a mudanca diz se os animais sairam ou
 * chegaram, e a entrega conta so os que sairam dela. Sem, o fato inteiro
 */
export function descreverOcorrencia(ocorrencia: OcorrenciaDescrita, daCaixa?: number): string {
  const tocados = ocorrencia.animais.map((ligacao) => ligacao.animal)
  const daqui = daCaixa === undefined ? tocados : tocados.filter((animal) => animal.idCaixa === daCaixa)
  const qtd = contarPorSexo(ocorrencia.tipo === 'entrega' ? daqui : tocados)
  const origem = ocorrencia.caixaOrigem?.codigo ?? ''
  const destino = ocorrencia.caixaDestino?.codigo ?? ''
  const pedido = `pedido #${ocorrencia.idPedido ?? ''}`

  switch (ocorrencia.tipo) {
    case 'nascimento':
      return `Nascimento${doParto(ocorrencia)}: ${quantosAnimais(qtd)}${daCaixa === undefined ? ` na caixa ${destino}` : ''}.`
    case 'baixa':
      return descricaoDaBaixa(ocorrencia, qtd, daCaixa === undefined ? ` na caixa ${origem}` : '')
    case 'mudanca':
      if (daCaixa === undefined) return `${comVerbo(qtd, 'mudou', 'mudaram')} da caixa ${origem} para a caixa ${destino}.`
      return ocorrencia.idCaixaOrigem === daCaixa
        ? `${comVerbo(qtd, 'mudou', 'mudaram')} para a caixa ${destino}.`
        : `${comVerbo(qtd, 'chegou', 'chegaram')} da caixa ${origem}.`
    case 'anulacao':
      return descricaoDaAnulacao(ocorrencia, qtd, daCaixa)
    case 'entrega':
      return `${comVerbo(qtd, 'entregue', 'entregues')} ao ${pedido}.`
    case 'reserva':
      return `Reserva para o ${pedido}: ${quantosAnimais(qtd)}.`
    case 'reserva_desfeita': {
      const motivo = ocorrencia.motivo === null ? '' : ` (${ocorrencia.motivo})`
      const livres = concordar(qtd, 'livre', 'livres')
      return `Reserva do ${pedido} desfeita: ${comVerbo(qtd, 'voltou', 'voltaram')} a ficar ${livres}${motivo}.`
    }
    case 'correcao':
      return `Correção${doParto(ocorrencia)} que mudou ${quantosAnimais(qtd)}${ocorrencia.motivo === null ? '' : `: ${ocorrencia.motivo}`}.`
    default:
      return `${ocorrencia.tipo}: ${quantosAnimais(qtd)}.`
  }
}
