// Carga inicial: os valores que o cliente forneceu, gravados por `prisma/seed.ts`.
//
// Sao dados de banco, nao constante de codigo. Ficam aqui so porque alguem tem
// de escrever a primeira linha no banco vazio.

/**
 * As duas especies e as cinco linhagens, com o cruzamento das familias A-E que o CPMR
 * descreveu: heterogenicas em rodizio, isogenicas na mesma letra.
 */
export const especies = [
  {
    nome: 'Rato',
    linhagens: [
      { nome: 'Wistar', cruzamento: 'rodizio' },
      { nome: 'SHR', cruzamento: 'mesma_letra' },
      { nome: 'Kyoto', cruzamento: 'mesma_letra' },
    ],
  },
  {
    nome: 'Camundongo',
    linhagens: [
      { nome: 'Swiss', cruzamento: 'rodizio' },
      { nome: 'C57BL/6J', cruzamento: 'mesma_letra' },
    ],
  },
] as const

/** As 3 salas de criacao de hoje. Depois da carga, o gestor muda nos Cadastros. */
export const salas = ['Sala 1', 'Sala 2', 'Sala 3'] as const

/**
 * Os quatro modelos de estante, com uma estante real de cada um. `sala` e o nome
 * de uma das `salas` acima: a carga troca pelo id dela.
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
