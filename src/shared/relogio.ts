// O relogio do sistema. Em producao e o tempo real. Com RELOGIO_DE_TESTE=ligado, em um ambiente
// local apontado para uma copia do banco, o tempo anda para a frente a pedido: e como o dono
// testa o fluxo inteiro (pedido, casais, parto, desmame, reserva, entrega) sem esperar os dias

const DIA_EM_MS = 24 * 60 * 60 * 1000

/** Quantos dias o relogio de teste esta adiantado. So vale com o relogio ligado */
let deslocamentoDias = Number(process.env.RELOGIO_DESLOCAMENTO_DIAS ?? 0)

if (!Number.isFinite(deslocamentoDias)) {
  deslocamentoDias = 0
}

/** Lido a cada chamada, para o teste ligar e desligar sem recarregar o modulo */
export function relogioLigado(): boolean {
  return process.env.RELOGIO_DE_TESTE === 'ligado'
}

/**
 * O instante de negocio: data de pedido, prazo, validacao de data, carimbo de registro. Sessao,
 * tentativas de login, codigo de acesso, cookie e log continuam no tempo real (new Date())
 */
export function agora(): Date {
  const real = Date.now()
  return new Date(relogioLigado() ? real + deslocamentoDias * DIA_EM_MS : real)
}

/** Adianta o relogio de teste. Sem o relogio ligado nao faz nada */
export function avancarRelogio(dias: number): void {
  if (relogioLigado()) {
    deslocamentoDias += dias
  }
}

/** O hoje de Brasilia, 'aaaa-mm-dd', do relogio atual. Evita importar traducao.ts aqui */
function hojeDeBrasilia(instante: Date): string {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instante)
  const parte = (tipo: Intl.DateTimeFormatPartTypes) => partes.find((p) => p.type === tipo)?.value
  return `${parte('year')}-${parte('month')}-${parte('day')}`
}

export function lerRelogio(): { hoje: string; deslocamentoDias: number } {
  return { hoje: hojeDeBrasilia(agora()), deslocamentoDias: relogioLigado() ? deslocamentoDias : 0 }
}
