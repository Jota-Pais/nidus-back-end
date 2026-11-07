import { liberarCaixaDoCasal } from './estoque.service.ts'

/**
 * As caixas cujos partos contam para o estoque e a busca: a de casal em Livres ou Pre-reserva, a
 * de estoque com animal (a caixa do casal encerrado que virou de estoque tem os partos dela) e a
 * ja liberada, cujos desmamados podem estar em caixas de estoque
 */
export const caixaComEstoque = {
  OR: [{ ativa: true, estado: { in: ['R', 'P', 'E'] } }, { ativa: false }],
}

/**
 * A caixa de casal sem casal ativo e sem animal dentro libera a posicao. Desmamado que ainda nao
 * foi para o estoque prende a caixa, como o filhote mamando: nao fica animal sem caixa
 */
export const liberarCaixaVazia = liberarCaixaDoCasal
