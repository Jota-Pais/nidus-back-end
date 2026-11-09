// A transacao dos testes de integracao dos servicos (*.banco.test.ts): o Prisma dos servicos e
// trocado por uma transacao so, aberta no inicio da suite e desfeita no fim. O $transaction de cada
// servico vira um SAVEPOINT dentro dela (tudo ou nada, como a transacao de verdade), e cada caso
// roda noutro SAVEPOINT, desfeito no fim do caso. Nada fica gravado; so as sequencias andam.
//
// Cada suite troca o Prisma assim, antes de importar os servicos:
//
//   vi.mock('../../shared/prisma.ts', async () => ({
//     prisma: (await import('../../shared/testes/transacao.ts')).prismaDaTransacao,
//   }))
//
// Fica fora do build (tsconfig.build.json): so os testes importam.

import { PrismaPg } from '@prisma/adapter-pg'
import { Prisma, PrismaClient } from '@prisma/client'

type Transacao = Prisma.TransactionClient

let aberta: Transacao | undefined

function tx(): Transacao {
  if (aberta === undefined) throw new Error('a transacao do teste nao esta aberta')
  return aberta
}

/** O $transaction do servico: um SAVEPOINT na transacao do teste, desfeito se o servico falha */
async function transacao<T>(servico: (tx: Transacao) => Promise<T>): Promise<T> {
  await tx().$executeRawUnsafe('SAVEPOINT servico')

  try {
    const resultado = await servico(tx())
    await tx().$executeRawUnsafe('RELEASE SAVEPOINT servico')
    return resultado
  } catch (erro) {
    await tx().$executeRawUnsafe('ROLLBACK TO SAVEPOINT servico')
    throw erro
  }
}

/** O que os servicos recebem no lugar do Prisma: tudo vai para a transacao do teste */
export const prismaDaTransacao = new Proxy(
  {},
  {
    get(_, campo) {
      if (campo === '$transaction') return transacao
      // quem so sonda o objeto (await, inspecao) nao precisa da transacao aberta
      if (typeof campo === 'symbol' || campo === 'then') return undefined
      const valor: unknown = Reflect.get(tx(), campo)
      return typeof valor === 'function' ? valor.bind(tx()) : valor
    },
  },
)

/**
 * Abre a transacao do teste no banco de 'url' e devolve como desfaze-la. Ela fica aberta ate
 * 'desfazer', que termina em ROLLBACK e fecha a conexao
 */
export async function abrirTransacaoDoTeste(url: string): Promise<{ tx: Transacao; desfazer: () => Promise<void> }> {
  const cliente = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  let desfaz: () => void = () => undefined
  let terminada: Promise<unknown> = Promise.resolve()

  await new Promise<void>((pronta, falhou) => {
    terminada = cliente
      .$transaction(
        async (aquela) => {
          aberta = aquela
          pronta()
          await new Promise<never>((_, rejeita) => {
            desfaz = () => rejeita(new Error('fim do teste: desfaz tudo'))
          })
        },
        { maxWait: 60_000, timeout: 900_000 },
      )
      .catch((erro: unknown) => {
        if (aberta === undefined) falhou(erro)
      })
  })

  return {
    tx: tx(),
    desfazer: async () => {
      desfaz()
      await terminada
      aberta = undefined
      await cliente.$disconnect()
    },
  }
}

/** Cada caso num SAVEPOINT, desfeito no fim dele: para o beforeEach e o afterEach da suite */
export const abrirCaso = () => tx().$executeRawUnsafe('SAVEPOINT caso')
export const desfazerCaso = () => tx().$executeRawUnsafe('ROLLBACK TO SAVEPOINT caso')
