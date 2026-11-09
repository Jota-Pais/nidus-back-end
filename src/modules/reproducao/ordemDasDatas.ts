import { ErroDeAplicacao } from '../../shared/erros.ts'
import { dataISO, dataLegivel } from '../../shared/traducao.ts'

/**
 * A ordem das datas da vida do casal: formacao, acasalamento, parto, eutanasia, desmame. Cada
 * data pode cair no mesmo dia da que vem antes (quem passa para o sistema os dados antigos da
 * colonia junta tudo num dia), mas nunca antes dela. Data no futuro a validacao da rota ja recusa
 */

/** Um evento ja registrado que limita a data nova. Sem data, ainda nao aconteceu e nao limita */
export type Marco = {
  /** como entra na mensagem: 'do acasalamento', 'da eutanasia', 'do 1o parto' */
  evento: string
  data: Date | null | undefined
}

export type Limites = {
  /** a data nao pode ser antes destes */
  depoisDe?: Marco[]
  /** a data nao pode ser depois destes */
  antesDe?: Marco[]
}

/** O motivo de a data 'aaaa-mm-dd' estar fora da ordem, ou null quando ela cabe */
export function foraDaOrdem(data: string, limites: Limites): string | null {
  for (const marco of limites.depoisDe ?? []) {
    if (marco.data === null || marco.data === undefined) continue
    const limite = dataISO(marco.data)
    if (data < limite) return `Nao pode ser antes ${marco.evento} (${dataLegivel(limite)}).`
  }

  for (const marco of limites.antesDe ?? []) {
    if (marco.data === null || marco.data === undefined) continue
    const limite = dataISO(marco.data)
    if (data > limite) return `Nao pode ser depois ${marco.evento} (${dataLegivel(limite)}).`
  }

  return null
}

/** Recusa a data fora da ordem com a mensagem no campo dela, que o formulario destaca */
export function exigirOrdem(campo: string, data: string, limites: Limites): void {
  const motivo = foraDaOrdem(data, limites)

  if (motivo !== null) {
    throw new ErroDeAplicacao(400, 'VALIDACAO', 'Confira os campos destacados.', {
      campos: { [campo]: motivo },
    })
  }
}
