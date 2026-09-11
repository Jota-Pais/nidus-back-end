// Secao 1.1 do contrato: o `char(1)` do banco NUNCA cruza a rede.
//
// O banco guarda estado em `char(1)` porque o RNF-05 proibe deploy para
// acrescentar valor de dominio - `ALTER TYPE` de ENUM e DDL. A API traduz, e
// **o back-end e o dono dessa conversao**: o front nunca ve 'R', 'P' ou 'C'.
//
// Este arquivo e a UNICA fonte da conversao nos dois sentidos. Nenhum modulo
// escreve 'R' ou 'confirmado' na mao - quem faz isso espalha o vocabulario e a
// proxima mudanca vira caca ao literal.
//
// Os valores da direita sao, textualmente, os de
// `nidus-front-end/src/dominio/tipos.ts` e `estados.ts`. **Sao eles o
// contrato** - renomear aqui quebra o front, e muda nos dois repos no mesmo PR.

import { naoEncontrado } from './erros.ts'

/** Constroi o par de mapas de um dominio a partir de um unico literal. */
function dicionario<Codigo extends string, Termo extends string>(
  paraApi: Readonly<Record<Codigo, Termo>>,
) {
  const paraBanco = Object.fromEntries(
    Object.entries(paraApi).map(([codigo, termo]) => [termo, codigo]),
  ) as Record<Termo, Codigo>

  return {
    /** Banco -> API. */
    paraApi: (codigo: string) => {
      const termo = (paraApi as Record<string, Termo | undefined>)[codigo]

      if (termo === undefined) {
        // Dado invalido no banco e bug nosso, nao entrada do usuario: o CHECK de
        // dominio da migration das invariantes nao deveria ter deixado entrar.
        throw new Error(`Codigo fora do dominio traduzivel: ${JSON.stringify(codigo)}`)
      }

      return termo
    },
    /** API -> banco. Devolve `undefined` para termo desconhecido. */
    paraBanco: (termo: string) => (paraBanco as Record<string, Codigo | undefined>)[termo],
    /** Os termos da API, na ordem em que o dicionario foi escrito. */
    termos: Object.values(paraApi) as Termo[],
  }
}

/** `infra.caixa.estado` - as 5 colunas do quadro (`RF-CIC-01`). */
export const estadoCaixa = dicionario({
  R: 'em_reproducao',
  P: 'parcialmente_comprometida',
  T: 'totalmente_comprometida',
  E: 'preparada_para_envio',
  X: 'expedida',
} as const)

/** `infra.caixa.finalidade`. */
export const finalidadeCaixa = dicionario({
  R: 'reproducao',
  M: 'maternidade',
  C: 'recria',
  E: 'expedicao',
} as const)

/** `reproducao.parto.grau_certeza` - `RN-08`. */
export const grauCerteza = dicionario({
  C: 'confirmado',
  P: 'previsto',
  J: 'projetado',
} as const)

/** `login.usuario.perfil` - os tres perfis do `RF-ACS-*`. */
export const perfil = dicionario({
  P: 'pesquisador',
  T: 'tecnico',
  G: 'gestor',
} as const)

/** `infra.caixa.face` - a face faz parte do endereco, nao e sufixo. */
export const face = dicionario({
  '1': 'frontal',
  '2': 'traseira',
} as const)

export type EstadoCaixa = (typeof estadoCaixa.termos)[number]
export type FinalidadeCaixa = (typeof finalidadeCaixa.termos)[number]
export type GrauCerteza = (typeof grauCerteza.termos)[number]
export type Perfil = (typeof perfil.termos)[number]
export type Face = (typeof face.termos)[number]

/**
 * Codigo da especie usado em rota e filtro (`rato` | `camundongo`).
 *
 * Nao ha coluna `codigo` em `catalogo.especie` - e derivado do nome, que tem
 * unique. Fica aqui junto das outras conversoes por ser a mesma natureza de
 * problema: termo estavel de API a partir de dado do banco.
 */
export function codigoDaEspecie(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
}

/**
 * Data de calendario no formato do contrato: `aaaa-mm-dd`, nunca timestamp.
 *
 * As colunas sao `@db.Date` e o Prisma as devolve como `Date` na meia-noite
 * UTC - `toISOString` e a leitura correta, e `toLocaleDateString` seria o erro
 * classico de deslocar um dia no fuso do servidor.
 */
export function dataISO(data: Date): string {
  return data.toISOString().slice(0, 10)
}

/** A data de hoje em UTC, para comparar com coluna `@db.Date`. */
export function hojeISO(agora: Date = new Date()): string {
  return dataISO(agora)
}

/**
 * Traduz um termo de API para `char(1)`, ou 404 se nao existe.
 *
 * Usado onde o termo chega pela URL - `?especie=rato` ja e validado pelo Zod,
 * mas filtro por estado vem de lista aberta.
 */
export function exigirCodigo<T extends string>(
  dic: { paraBanco: (termo: string) => T | undefined },
  termo: string,
  oQue: string,
): T {
  const codigo = dic.paraBanco(termo)

  if (codigo === undefined) {
    throw naoEncontrado(oQue)
  }

  return codigo
}
