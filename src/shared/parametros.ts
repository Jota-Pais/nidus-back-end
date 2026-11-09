// Parametros biologicos da colonia, como no 'config/settings.py' do sistema do cliente:
// rato e camundongo usam os mesmos numeros. O codigo le daqui, e so daqui: o banco nao
// repete nenhum

/** parto previsto = acasalamento + 23 dias */
export const GESTACAO_DIAS = 23

/** desmame previsto = parto real + 22 dias (o previsto, enquanto nao nasce) */
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

// Os dois abaixo nao vem do sistema do cliente: sao a folga da sugestao de acasalamento novo
// na janela de reservar, quando o plantel nao tem os animais do pedido

/**
 * A ninhada varia em torno do esperado de 4 de cada sexo: de 3 a 5. Com 5, saem menos
 * acasalamentos; com 3, mais
 */
export const NINHADA_POR_SEXO = { menor: 3, maior: 5 } as const

/** O casal recem-formado so acasala no proximo cio, ate 4 dias depois (o ciclo estral) */
export const CIO_DIAS = 4

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
