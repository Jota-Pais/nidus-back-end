// RF-INF-02: o endereco como aparece na etiqueta fisica da estante.
//
// ⚠️ AQUI VIVE O `CONF-07`, e vive **so aqui**.
//
// A pergunta aberta com o cliente e se a letra do endereco designa a linha ou a
// coluna. Enquanto nao responderem, o sistema gera **letra = coluna, numero =
// linha** (`A1` = coluna A, linha 1), que e o que a contagem do Anexo A obriga:
// o TECNIPLAST Modelo 1 e "8 x 7 (A-G)" - sete letras para sete colunas, e nao
// oito. O front assumiu o mesmo (`contrato-api.md` secao 5).
//
// O contrato diz, com estas palavras, que nenhum dos dois lados deve espalhar a
// suposicao pelo resto do codigo. Por isso ela cabe em UMA funcao: responder o
// CONF-07 e trocar `indiceDaLetra` por `linha`, e nada mais no repositorio
// muda.
//
// A outra regra, essa ja confirmada: a sequencia de letras e **continua entre
// as faces** - no ALESCO Modelo 1 a frontal e A-H e a traseira I-P. A face faz
// parte do endereco, nao e sufixo dele.

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * A letra de uma posicao. `face` e 1 ou 2, `coluna` e 1-based.
 *
 * O deslocamento por face e o que faz a sequencia continuar em vez de repetir:
 * face 2, coluna 1 de uma estante de 8 colunas e a nona letra, `I`.
 */
export function letraDaPosicao(face: number, coluna: number, colunas: number): string {
  const indiceDaLetra = (face - 1) * colunas + (coluna - 1)
  const letra = ALFABETO[indiceDaLetra]

  if (letra === undefined) {
    // Topologia grande demais para o alfabeto (faces x colunas > 26). Nenhum
    // dos quatro modelos do Anexo A chega perto, mas cadastro e livre
    // (RF-INF-01) e falhar alto e melhor que gerar `undefined1` na etiqueta.
    throw new Error(
      `Topologia sem letra disponivel: face ${face}, coluna ${coluna} de ${colunas} (indice ${indiceDaLetra}).`,
    )
  }

  return letra
}

/** O codigo completo da posicao. Ex.: `C3`. */
export function codigoDaPosicao(
  face: number,
  linha: number,
  coluna: number,
  colunas: number,
): string {
  return `${letraDaPosicao(face, coluna, colunas)}${linha}`
}

/**
 * Quantas letras a topologia consome. Serve para recusar cadastro impossivel
 * no POST antes de gravar, em vez de estourar na primeira leitura da grade.
 */
export function letrasNecessarias(faces: number, colunas: number): number {
  return faces * colunas
}

export const LETRAS_DISPONIVEIS = ALFABETO.length
