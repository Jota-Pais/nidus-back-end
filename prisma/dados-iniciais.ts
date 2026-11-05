// Carga inicial: os valores que o cliente forneceu, gravados por `prisma/seed.ts`.
//
// Sao dados de banco, nao constante de codigo. Ficam aqui so porque alguem tem
// de escrever a primeira linha no banco vazio.

/** As duas especies e as cinco linhagens. */
export const especies = [
  {
    nome: 'Rato',
    linhagens: ['Wistar', 'SHR', 'Kyoto'],
  },
  {
    nome: 'Camundongo',
    linhagens: ['Swiss', 'C57BL/6J'],
  },
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
