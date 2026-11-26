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
 * Uma estante real de cada um dos quatro formatos da spec. `formato` e o nome de um
 * dos formatos que a migration 20261126150000_estante_com_formato cria (ALESCO
 * Modelo 1 = 2 faces 8 x 8, ALESCO Modelo 2 = 2 faces 5 x 5, TECNIPLAST Modelo 1 =
 * 2 faces 8 x 7, TECNIPLAST Modelo 2 = 2 faces 5 x 4), e `sala`, o de uma das
 * `salas` acima: a carga troca cada nome pelo id.
 *
 * As medidas e a capacidade sao as do formato. `linhas` x `colunas` segue a leitura
 * do cliente ("8 x 7"); a letra do endereco e a coluna (`src/modules/infra/endereco.ts`).
 */
export const estantes = [
  { sala: 'Sala 1', formato: 'ALESCO Modelo 1', numeroVisivel: 'E-01' },
  { sala: 'Sala 1', formato: 'ALESCO Modelo 2', numeroVisivel: 'E-02' },
  { sala: 'Sala 2', formato: 'TECNIPLAST Modelo 1', numeroVisivel: 'E-03' },
  { sala: 'Sala 3', formato: 'TECNIPLAST Modelo 2', numeroVisivel: 'E-04' },
] as const
