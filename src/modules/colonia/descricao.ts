// O texto de uma ocorrencia da trilha, num lugar so: a ficha da caixa o mostra visto da caixa
// ("chegaram da caixa F1A"), e a tela Historico, sem ponto de vista ("mudaram da caixa F1A para a
// caixa F2C")

import type { Prisma } from '@prisma/client'
import { MOTIVO_NAO_CHEGOU_AO_DESMAME, MOTIVO_SELECAO, contarPorSexo } from './tipos.ts'
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
  anulacao: { select: { id: true } },
  animais: { select: { animal: { select: { sexo: true, idCaixa: true } } } },
} satisfies Prisma.OcorrenciaSelect

export type OcorrenciaDescrita = Prisma.OcorrenciaGetPayload<{ select: typeof selecaoDaDescricao }>

const animais = ({ m, f }: PorSexo) => `${m} M, ${f} F`

function doParto(ocorrencia: OcorrenciaDescrita): string {
  const { parto } = ocorrencia
  return parto === null ? '' : ` do ${parto.ordem}o parto do casal ${parto.casal.identificacao.trim()}`
}

function descricaoDaBaixa(ocorrencia: OcorrenciaDescrita, qtd: PorSexo, naCaixa: string): string {
  const anulada = ocorrencia.anulacao === null ? '' : ' (anulada)'

  if (ocorrencia.motivo === MOTIVO_SELECAO) return `Eutanasia de selecao${doParto(ocorrencia)}: ${animais(qtd)}.${anulada}`
  if (ocorrencia.motivo === MOTIVO_NAO_CHEGOU_AO_DESMAME) {
    return `${animais(qtd)}${doParto(ocorrencia)} nao chegaram ao desmame.${anulada}`
  }

  return `Baixa de ${animais(qtd)}${naCaixa}${ocorrencia.motivo === null ? '' : `: ${ocorrencia.motivo}`}.${anulada}`
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
      return `Nascimento${doParto(ocorrencia)}: ${animais(qtd)}${daCaixa === undefined ? ` na caixa ${destino}` : ''}.`
    case 'baixa':
      return descricaoDaBaixa(ocorrencia, qtd, daCaixa === undefined ? ` na caixa ${origem}` : '')
    case 'mudanca':
      if (daCaixa === undefined) return `${animais(qtd)} mudaram da caixa ${origem} para a caixa ${destino}.`
      return ocorrencia.idCaixaOrigem === daCaixa
        ? `${animais(qtd)} mudaram para a caixa ${destino}.`
        : `${animais(qtd)} chegaram da caixa ${origem}.`
    case 'anulacao': {
      const motivo = ` Motivo: ${ocorrencia.motivo ?? ''}`
      if (ocorrencia.idCaixaDestino === null) {
        return `Baixa anulada: ${animais(qtd)} voltaram a viver${daCaixa === undefined ? ` na caixa ${origem}` : ''}.${motivo}`
      }
      if (daCaixa === undefined || ocorrencia.idCaixaOrigem === daCaixa) {
        return `Baixa anulada: ${animais(qtd)} voltaram a viver na caixa ${destino}.${motivo}`
      }
      return `Baixa anulada: ${animais(qtd)} voltaram a viver, vindos da caixa ${origem}.${motivo}`
    }
    case 'entrega':
      return `${animais(qtd)} entregues ao ${pedido}.`
    case 'reserva':
      return `${animais(qtd)} reservados para o ${pedido}.`
    case 'reserva_desfeita':
      return `Reserva do ${pedido} desfeita: ${animais(qtd)} voltaram a ficar livres${ocorrencia.motivo === null ? '' : ` (${ocorrencia.motivo})`}.`
    case 'correcao':
      return `Correcao${doParto(ocorrencia)} que mudou ${animais(qtd)}${ocorrencia.motivo === null ? '' : `: ${ocorrencia.motivo}`}.`
    default:
      return `${ocorrencia.tipo}: ${animais(qtd)}.`
  }
}
