// O endereco como aparece na etiqueta fisica da estante, no formato da spec do cliente:
// face + linha + letra da coluna. ex: F1A (frontal, linha 1, coluna A), T2K (traseira)

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * A letra de uma posicao. face e 1 ou 2, 'coluna' e 1-based. A traseira continua a
 * sequencia da frontal: ALESCO M1 e A-H na frontal e I-P na traseira
 */
export function letraDaPosicao(face: number, coluna: number, colunas: number): string {
  const indiceDaLetra = (face - 1) * colunas + (coluna - 1)
  const letra = ALFABETO[indiceDaLetra]

  if (letra === undefined) {
    // Topologia grande demais para o alfabeto (faces x colunas > 26): falhar alto e melhor
    // que gerar 'undefined1' na etiqueta
    throw new Error(
      `Topologia sem letra disponivel: face ${face}, coluna ${coluna} de ${colunas} (indice ${indiceDaLetra}).`,
    )
  }

  return letra
}

/** O codigo completo da posicao. ex: F1A */
export function codigoDaPosicao(
  face: number,
  linha: number,
  coluna: number,
  colunas: number,
): string {
  return `${face === 1 ? 'F' : 'T'}${linha}${letraDaPosicao(face, coluna, colunas)}`
}

/**
 * quantas letras a topologia consome. Serve para recusar formato impossivel antes de gravar, em
 * vez de estourar na primeira leitura da grade.
 */
export function letrasNecessarias(faces: number, colunas: number): number {
  return faces * colunas
}

export const LETRAS_DISPONIVEIS = ALFABETO.length

/** A recusa no campo das colunas quando faces x colunas passa das letras do alfabeto */
export const COLUNAS_SEM_LETRA = `Faces x colunas não pode passar de ${LETRAS_DISPONIVEIS} - o endereço ficaria sem letra.`
