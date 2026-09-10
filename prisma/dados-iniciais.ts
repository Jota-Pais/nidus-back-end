// Anexo A dos requisitos: os valores que o cliente forneceu.
//
// Sao DADOS DE CADASTRO, nao constante de codigo (RNF-05). Ficam aqui porque
// alguem tem de escrever a primeira linha no banco vazio - dai para frente a
// manutencao e por tela de parametrizacao, sem deploy. Um quinto modelo de
// estante entra por cadastro; nao volta neste arquivo.
//
// Fonte: docs/requisitos.md Anexo A e RN-07 · docs/contrato-api.md secao 4.

/** A.1 - as duas especies e as cinco linhagens. */
export const especies = [
  {
    nome: 'Rato',
    nomeCientifico: 'Rattus norvegicus',
    linhagens: ['Wistar', 'SHR', 'Kyoto'],
  },
  {
    nome: 'Camundongo',
    nomeCientifico: 'Mus musculus',
    linhagens: ['Swiss', 'C57BL/6J'],
  },
] as const

/**
 * Vigencia da carga inicial. RN-01 manda o parametro ser versionado, entao a
 * primeira faixa precisa de uma data de inicio - e nao do dia em que o seed
 * rodou, que faria a mesma carga produzir historico diferente em cada maquina.
 */
export const inicioVigencia = new Date('2026-01-01T00:00:00.000Z')

/**
 * Parametros biologicos vigentes, um por especie (`idLinhagem` nulo vale para a
 * especie inteira). Os dois valem os mesmos numeros hoje; estao separados
 * porque a vigencia e por especie e vao divergir.
 */
export const parametrosBiologicos = {
  gestacaoDias: 23,
  aleitamentoDias: 22,
  intervaloCicloDias: 6,
  maxPartoCasal: 5,
  expectativaM: 4,
  expectativaF: 4,
} as const

/**
 * RN-07 - a variacao aceita cresce com a idade pedida. Oito faixas; a ultima e
 * aberta (`idadeMaxDias` nulo = sem teto), que e a linha "> 90" da tabela.
 */
export const toleranciasIdade = [
  { idadeMinDias: 21, idadeMaxDias: 22, variacaoDias: 1 },
  { idadeMinDias: 23, idadeMaxDias: 25, variacaoDias: 2 },
  { idadeMinDias: 26, idadeMaxDias: 30, variacaoDias: 3 },
  { idadeMinDias: 31, idadeMaxDias: 40, variacaoDias: 4 },
  { idadeMinDias: 41, idadeMaxDias: 50, variacaoDias: 5 },
  { idadeMinDias: 51, idadeMaxDias: 60, variacaoDias: 7 },
  { idadeMinDias: 61, idadeMaxDias: 90, variacaoDias: 10 },
  { idadeMinDias: 91, idadeMaxDias: null, variacaoDias: 15 },
] as const

/** A.3 - rotacao em anel. RN-02: so estes cinco pares formam casal. */
export const paresGeneticos = [
  { grupoMacho: 'A', grupoFemea: 'B' },
  { grupoMacho: 'B', grupoFemea: 'C' },
  { grupoMacho: 'C', grupoFemea: 'D' },
  { grupoMacho: 'D', grupoFemea: 'E' },
  { grupoMacho: 'E', grupoFemea: 'A' },
] as const

/**
 * A.2 - os quatro modelos de estante, com uma estante real de cada um para a
 * infraestrutura de hoje: 3 salas de criacao.
 *
 * `capacidade` e derivada (faces x linhas x colunas) e o banco cobra isso no
 * CHECK `estante_capacidade_derivada` - por isso ela nao esta escrita aqui.
 *
 * `linhas` x `colunas` segue a leitura do Anexo A ("8 x 7"). Qual dos dois eixos
 * a LETRA do endereco designa e o CONF-07, ainda aberto - e nao afeta estas
 * linhas, so a geracao de `caixa.codigo`, que nao entra na carga inicial.
 */
export const estantes = [
  { sala: 'Sala 1', fabricante: 'ALESCO', modelo: 'Modelo 1', numeroVisivel: 'E-01', faces: 2, linhas: 8, colunas: 8 },
  { sala: 'Sala 1', fabricante: 'ALESCO', modelo: 'Modelo 2', numeroVisivel: 'E-02', faces: 2, linhas: 5, colunas: 5 },
  { sala: 'Sala 2', fabricante: 'TECNIPLAST', modelo: 'Modelo 1', numeroVisivel: 'E-03', faces: 2, linhas: 8, colunas: 7 },
  { sala: 'Sala 3', fabricante: 'TECNIPLAST', modelo: 'Modelo 2', numeroVisivel: 'E-04', faces: 2, linhas: 5, colunas: 4 },
] as const
