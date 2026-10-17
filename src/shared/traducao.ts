// O 'char(1)' do banco NUNCA cruza a rede.

import { naoEncontrado } from './erros.ts'

/** Constroi o par de mapas de um dominio a partir de um unico literal. */
function dicionario<Codigo extends string, Termo extends string>(
  paraApi: Readonly<Record<Codigo, Termo>>,
) {
  const paraBanco = Object.fromEntries(
    Object.entries(paraApi).map(([codigo, termo]) => [termo, codigo]),
  ) as Record<Termo, Codigo>

  return {
    /** Banco -> API */
    paraApi: (codigo: string) => {
      const termo = (paraApi as Record<string, Termo | undefined>)[codigo]

      if (termo === undefined) {
        // Dado invalido no banco e bug nosso, nao entrada do usuario: o CHECK de
        // dominio da migration das invariantes nao deveria ter deixado entrar
        throw new Error(`Codigo fora do dominio traduzivel: ${JSON.stringify(codigo)}`)
      }

      return termo
    },
    /** API -> banco. Devolve undefined para termo desconhecido */
    paraBanco: (termo: string) => (paraBanco as Record<string, Codigo | undefined>)[termo],
    /** Os termos da API, na ordem em que o dicionario foi escrito */
    termos: Object.values(paraApi) as Termo[],
  }
}

/**
 * infra.caixa.estado - as 5 colunas do kanban, com os nomes e na ordem da spec do cliente
 * (secao 1.9). A ordem aqui e a ordem das colunas na tela.
 */
export const estadoCaixa = dicionario({
  R: 'livres',
  P: 'pre_reserva',
  E: 'estoque',
  T: 'reserva',
  X: 'enviado',
} as const)

/** demanda.solicitacao.status */
export const statusSolicitacao = dicionario({
  RA: 'rascunho',
  EN: 'enviada',
  AN: 'em_analise',
  AP: 'aprovada',
  RE: 'recusada',
  AJ: 'ajustada',
  AT: 'em_atendimento',
  CO: 'concluida',
  CA: 'cancelada',
} as const)

/** demanda.solicitacao.regime - entrega unica ou cronograma */
export const cronograma = dicionario({
  U: 'unica',
  S: 'semanal',
  Q: 'quinzenal',
  M: 'mensal',
  A: 'avulsas',
} as const)

/** infra.caixa.finalidade */
export const finalidadeCaixa = dicionario({
  R: 'reproducao',
  M: 'maternidade',
  C: 'recria',
  E: 'expedicao',
} as const)

/** reproducao.parto.grau_certeza */
export const grauCerteza = dicionario({
  C: 'confirmado',
  P: 'previsto',
  J: 'projetado',
} as const)

/** login.usuario.perfil - os tres perfis de acesso. */
export const perfil = dicionario({
  P: 'pesquisador',
  T: 'tecnico',
  G: 'gestor',
} as const)

/** infra.caixa.face - a face faz parte do endereco, nao e sufixo */
export const face = dicionario({
  '1': 'frontal',
  '2': 'traseira',
} as const)

export type EstadoCaixa = (typeof estadoCaixa.termos)[number]
export type FinalidadeCaixa = (typeof finalidadeCaixa.termos)[number]
export type GrauCerteza = (typeof grauCerteza.termos)[number]
export type Perfil = (typeof perfil.termos)[number]
export type Face = (typeof face.termos)[number]

/** Codigo da especie usado em rota e filtro (rato | camundongo) */
export function codigoDaEspecie(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
}

/** Data de calendario no formato da API: 'aaaa-mm-dd', nunca timestamp */
export function dataISO(data: Date): string {
  return data.toISOString().slice(0, 10)
}

/** A data de hoje em UTC, para comparar com coluna '@db.Date' */
export function hojeISO(agora: Date = new Date()): string {
  return dataISO(agora)
}

/** Traduz um termo de API para 'char(1)', ou 404 se nao existe */
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
