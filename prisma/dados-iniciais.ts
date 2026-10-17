// Carga inicial: os valores que o cliente forneceu, gravados por `prisma/seed.ts`.
//
// Sao dados de banco, nao constante de codigo. Ficam aqui so porque alguem tem
// de escrever a primeira linha no banco vazio.

/** As duas especies e as cinco linhagens. */
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
 * Vigencia da carga inicial. O parametro e versionado, entao a
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
 * A variacao aceita cresce com a idade pedida. Oito faixas; a ultima e
 * aberta (`idadeMaxDias` nulo = sem teto), que e a faixa "> 90" dias.
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

/** Rotacao em anel: so estes cinco pares formam casal. */
export const paresGeneticos = [
  { grupoMacho: 'A', grupoFemea: 'B' },
  { grupoMacho: 'B', grupoFemea: 'C' },
  { grupoMacho: 'C', grupoFemea: 'D' },
  { grupoMacho: 'D', grupoFemea: 'E' },
  { grupoMacho: 'E', grupoFemea: 'A' },
] as const

/**
 * Os quatro modelos de estante, com uma estante real de cada um para a
 * infraestrutura de hoje: 3 salas de criacao.
 *
 * `capacidade` e derivada (faces x linhas x colunas) e o banco cobra isso no
 * CHECK `estante_capacidade_derivada` - por isso ela nao esta escrita aqui.
 *
 * `linhas` x `colunas` segue a leitura do cliente ("8 x 7"); a letra do
 * endereco e a coluna (`src/modules/infra/endereco.ts`).
 */
export const estantes = [
  { sala: 'Sala 1', fabricante: 'ALESCO', modelo: 'Modelo 1', numeroVisivel: 'E-01', faces: 2, linhas: 8, colunas: 8 },
  { sala: 'Sala 1', fabricante: 'ALESCO', modelo: 'Modelo 2', numeroVisivel: 'E-02', faces: 2, linhas: 5, colunas: 5 },
  { sala: 'Sala 2', fabricante: 'TECNIPLAST', modelo: 'Modelo 1', numeroVisivel: 'E-03', faces: 2, linhas: 8, colunas: 7 },
  { sala: 'Sala 3', fabricante: 'TECNIPLAST', modelo: 'Modelo 2', numeroVisivel: 'E-04', faces: 2, linhas: 5, colunas: 4 },
] as const
