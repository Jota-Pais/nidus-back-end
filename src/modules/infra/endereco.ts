// RF-INF-02: o endereco como aparece na etiqueta fisica da estante

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** A letra de uma posicao. face e 1 ou 2, 'coluna' e 1-based. */
export function letraDaPosicao(face: number, coluna: number, colunas: number): string {
  const indiceDaLetra = (face - 1) * colunas + (coluna - 1)
  const letra = ALFABETO[indiceDaLetra]

  if (letra === undefined) {
    // Topologia grande demais para o alfabeto (faces x colunas > 26). Nenhum dos
    // quatro modelos do Anexo A chega perto mas cadastro e livre (RF-INF-01) e
    // falhar alto e melhor que gerar 'undefined1' na etiqueta
    throw new Error(
      `Topologia sem letra disponivel: face ${face}, coluna ${coluna} de ${colunas} (indice ${indiceDaLetra}).`,
    )
  }

  return letra
}

/** O codigo completo da posicao. ex: C3 */
export function codigoDaPosicao(
  face: number,
  linha: number,
  coluna: number,
  colunas: number,
): string {
  return `${letraDaPosicao(face, coluna, colunas)}${linha}`
}

/**
 * quantas letras a topologia consome. Serve para recusar cadastro impossivel no POST antes
 * de gravar, em vez de estourar na primeira leitura da grade.
 */
export function letrasNecessarias(faces: number, colunas: number): number {
  return faces * colunas
}

export const LETRAS_DISPONIVEIS = ALFABETO.length
