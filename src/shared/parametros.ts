// Parametros biologicos da colonia, como no 'config/settings.py' do sistema do cliente:
// rato e camundongo usam os mesmos numeros. O codigo le daqui, e so daqui. O banco repete
// um numero so: o 4 e 4 de ESPERADOS_POR_CASAL, no trigger compromisso_respeita_oferta
// (migration 'enxuga_o_banco'). Mudou aqui, muda la tambem

/** parto previsto = acasalamento + 23 dias */
export const GESTACAO_DIAS = 23

/** desmame previsto = parto + 22 dias */
export const ALEITAMENTO_DIAS = 22

/** proximo acasalamento = parto real anterior + 6 dias */
export const INTERVALO_ACASALAMENTO_DIAS = 6

/** do 1o ao 5o parto; no 5o o casal encerra */
export const MAX_PARTOS_POR_CASAL = 5

/**
 * 5 machos e 5 femeas nascidos, menos 1 de cada na selecao: o que se espera de um parto
 * que ainda nao nasceu
 */
export const ESPERADOS_POR_CASAL = { m: 4, f: 4 } as const

/**
 * A variacao aceita cresce com a idade pedida (spec do cliente, secao 1.6). A ultima faixa
 * e aberta: 'idadeMaxDias' nulo e a "> 90 dias"
 */
export const FAIXAS_IDADE = [
  { idadeMinDias: 21, idadeMaxDias: 22, variacaoDias: 1 },
  { idadeMinDias: 23, idadeMaxDias: 25, variacaoDias: 2 },
  { idadeMinDias: 26, idadeMaxDias: 30, variacaoDias: 3 },
  { idadeMinDias: 31, idadeMaxDias: 40, variacaoDias: 4 },
  { idadeMinDias: 41, idadeMaxDias: 50, variacaoDias: 5 },
  { idadeMinDias: 51, idadeMaxDias: 60, variacaoDias: 7 },
  { idadeMinDias: 61, idadeMaxDias: 90, variacaoDias: 10 },
  { idadeMinDias: 91, idadeMaxDias: null, variacaoDias: 15 },
] as const
