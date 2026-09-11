// `RN-08` e `RN-09` - quanto um parto tem para oferecer, e com que confiança.
//
// **É a base de tudo que decide alocação:** a ficha (§6), o quadro (§8) e
// depois o motor de atendimento (`RF-MOT-03`). Por isso é função pura, testada
// isolada, e escrita antes de qualquer tela consumir.
//
// O `COALESCE` de três níveis da §5.1 do modelo de dados **é** o grau de
// certeza - não são duas regras, é uma:
//
//   disponivel = COALESCE(desmamado, nascido - eutanasiado, expectativa)
//              - compromissos ativos
//
// Dois pontos em que a leitura literal do documento erra, e que o trigger do
// banco (`compromisso_respeita_oferta`) já resolveu do mesmo jeito. **Manter os
// dois lados de acordo é obrigatório**: se a API calcular oferta diferente do
// trigger, o sistema mostra saldo que o banco recusa - ou pior, o contrário.
//
//   1. A §5.1 define `disponivel` DESCONTANDO compromissos e a §5.2 compara
//      `SUM(compromissos) <= disponivel`. Ao pé da letra isso é
//      `SUM <= oferta - SUM`, ou seja metade da oferta. O teto é a oferta
//      BRUTA, e por isso os dois conceitos têm nome separado aqui: `oferta`
//      (bruta) e `disponivel` (líquido, = oferta - comprometido).
//
//   2. A §5.1 escreve `nascido - eutanasiado`. Se o parto foi registrado e a
//      seleção ainda não, `eutanasiado` é nulo e a subtração inteira vira nula
//      em SQL - a oferta cairia para a expectativa PROJETADA de uma ninhada que
//      já nasceu. Aqui, como no trigger, **seleção ausente conta zero**.

import type { GrauCerteza } from '../../shared/traducao.ts'

/** Quantidade por sexo. É como o contrato conta animal em todo lugar. */
export type PorSexo = {
  m: number
  f: number
}

/** O que de um ciclo importa para o cálculo. Nada de datas: só contagem. */
export type ContagemDoCiclo = {
  nascidoM: number | null
  nascidoF: number | null
  eutanasiadoM: number | null
  eutanasiadoF: number | null
  desmamadoM: number | null
  desmamadoF: number | null
}

/**
 * `RN-08` - o grau de certeza sai da mesma cascata da oferta.
 *
 * Decidido pela CONTAGEM, não pela data: é a contagem que o `COALESCE` usa, e
 * grau e oferta que discordem seriam dois números contando histórias
 * diferentes sobre a mesma ninhada. (A data é o que decide o *próximo evento*
 * da grade, que é outra pergunta - ver `infra/proximoEvento.ts`.)
 */
export function calcularGrauCerteza(ciclo: ContagemDoCiclo): GrauCerteza {
  if (ciclo.desmamadoM !== null && ciclo.desmamadoF !== null) {
    return 'confirmado'
  }

  if (ciclo.nascidoM !== null && ciclo.nascidoF !== null) {
    return 'previsto'
  }

  return 'projetado'
}

/**
 * A oferta BRUTA do parto - o `COALESCE` de três níveis, sem descontar nada.
 *
 * É o teto que o `RN-09` cobra. Nunca é o que vai para a tela: quem mostra
 * número para o usuário usa `calcularDisponibilidade`.
 */
export function ofertaBruta(ciclo: ContagemDoCiclo, expectativa: PorSexo): PorSexo {
  if (ciclo.desmamadoM !== null && ciclo.desmamadoF !== null) {
    return { m: ciclo.desmamadoM, f: ciclo.desmamadoF }
  }

  if (ciclo.nascidoM !== null && ciclo.nascidoF !== null) {
    // Seleção ausente conta zero - ver o ponto 2 no topo do arquivo.
    return {
      m: ciclo.nascidoM - (ciclo.eutanasiadoM ?? 0),
      f: ciclo.nascidoF - (ciclo.eutanasiadoF ?? 0),
    }
  }

  return { m: expectativa.m, f: expectativa.f }
}

export type Disponibilidade = {
  grauCerteza: GrauCerteza
  /** Oferta bruta: o teto do `RN-09`. */
  oferta: PorSexo
  /** Soma dos compromissos ativos. */
  comprometido: PorSexo
  /**
   * O que ainda dá para prometer - **já líquido**.
   *
   * A API entrega assim e o front nunca subtrai: se o front subtrair, subtrai
   * errado, porque não conhece os compromissos das outras remessas.
   */
  disponivel: PorSexo
}

/**
 * Disponibilidade completa de um ciclo. É esta a função que a ficha, o quadro e
 * o motor chamam.
 *
 * `disponivel` nunca desce abaixo de zero. Negativo aqui não seria informação
 * nova - seria oferta comprometida além do teto, o que o trigger do `RN-09`
 * não deixa acontecer; mas se acontecer por correção de registro a posteriori
 * (`RF-REP-09` prevê exatamente isso), a tela tem de ler "nada disponível", e
 * não "-2 machos".
 */
export function calcularDisponibilidade(
  ciclo: ContagemDoCiclo,
  { expectativa, comprometido }: { expectativa: PorSexo; comprometido: PorSexo },
): Disponibilidade {
  const oferta = ofertaBruta(ciclo, expectativa)

  return {
    grauCerteza: calcularGrauCerteza(ciclo),
    oferta,
    comprometido,
    disponivel: {
      m: Math.max(0, oferta.m - comprometido.m),
      f: Math.max(0, oferta.f - comprometido.f),
    },
  }
}

/** Um `parametro_biologico` como o cálculo precisa ver. */
export type ParametroVigente = {
  /** Nulo vale para a espécie inteira; preenchido manda na linhagem dela. */
  idLinhagem: number | null
  expectativaM: number
  expectativaF: number
  /** `aaaa-mm-dd`. */
  dtVigenciaInicio: string
  /** `aaaa-mm-dd`, ou nulo para vigência aberta. */
  dtVigenciaFim: string | null
}

/**
 * O parâmetro que vale para uma linhagem numa data.
 *
 * `RN-01` manda o parâmetro ser **versionado**: cálculo feito no passado
 * precisa continuar reproduzível. Por isso a escolha é pela DATA do cálculo, e
 * não por "quem está com `dtVigenciaFim` nulo" - filtrar pelo nulo devolve o
 * parâmetro de hoje, que é a resposta errada para recalcular algo de maio.
 *
 * Entre dois que cobrem a data, o da linhagem ganha do da espécie: é o mais
 * específico. Empate real não existe no Anexo A (há um por espécie), e se
 * passar a existir a ordem de entrada decide - o que é motivo para o cadastro
 * não deixar criar vigência sobreposta.
 */
export function parametroNaData<T extends ParametroVigente>(
  parametros: T[],
  { idLinhagem, em }: { idLinhagem: number | null; em: string },
): T | undefined {
  const candidatos = parametros.filter(
    (parametro) =>
      parametro.dtVigenciaInicio <= em &&
      (parametro.dtVigenciaFim === null || em <= parametro.dtVigenciaFim) &&
      (parametro.idLinhagem === null || parametro.idLinhagem === idLinhagem),
  )

  return (
    candidatos.find((parametro) => parametro.idLinhagem === idLinhagem && idLinhagem !== null) ??
    candidatos.find((parametro) => parametro.idLinhagem === null)
  )
}

/**
 * A expectativa que vale para uma linhagem numa data.
 *
 * Estoura se não houver parâmetro: uma ninhada projetada sem expectativa não
 * tem oferta nenhuma, e devolver um palpite (4 e 4, os números do Anexo A)
 * seria transformar carga inicial em constante de código - exatamente o que o
 * `RNF-05` proíbe.
 */
export function expectativaNaData(
  parametros: ParametroVigente[],
  alvo: { idLinhagem: number | null; em: string },
): PorSexo {
  const parametro = parametroNaData(parametros, alvo)

  if (parametro === undefined) {
    throw new Error(
      `Sem parametro_biologico vigente em ${alvo.em} para a linhagem ${alvo.idLinhagem ?? '(especie)'}.`,
    )
  }

  return { m: parametro.expectativaM, f: parametro.expectativaF }
}
