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
// A transacao do teste e uma conexao so, como a transacao interativa de cada servico. Por isso:
// - dentro do $transaction de um servico, duas consultas ao mesmo tempo (um Promise.all) falham o
//   teste: o driver as enfileira hoje, e o pg 9 deixa de aceitar. A vigia so ve as chamadas do
//   servico: as consultas das relacoes aninhadas que o proprio Prisma manda juntas passam (sao o
//   aviso de deprecacao do pg que a suite imprime), e por isso o pg fica na 8 (README, Stack);
// - fora dele, onde o servico usa o Prisma de verdade (um pool, uma conexao por consulta), as
//   consultas vao uma de cada vez, em fila, como se cada uma tivesse a sua conexao.
//
// O teste que precisa de mais de uma conexao (a reserva concorrente) abre outras transacoes
// (abrirTransacaoDoTeste) e roda cada servico na sua (naTransacao).
//
// Fica fora do build (tsconfig.build.json): so os testes importam.

import { AsyncLocalStorage } from 'node:async_hooks'
import { PrismaPg } from '@prisma/adapter-pg'
import { Prisma, PrismaClient } from '@prisma/client'

type Transacao = Prisma.TransactionClient

/** A transacao da suite: a primeira aberta */
let aberta: Transacao | undefined

/** A transacao da vez, quando o teste roda servicos em mais de uma conexao */
const daVez = new AsyncLocalStorage<Transacao>()

function tx(): Transacao {
  const transacao = daVez.getStore() ?? aberta
  if (transacao === undefined) throw new Error('a transacao do teste nao esta aberta')
  return transacao
}

/** Roda 'servico' na transacao 't' (de outra conexao), e nao na da suite */
export function naTransacao<T>(t: Transacao, servico: () => Promise<T>): Promise<T> {
  return daVez.run(t, servico)
}

// ------------------------------------------------------------ uma consulta de cada vez

type Embrulho = (consulta: PromiseLike<unknown>) => PromiseLike<unknown>

/**
 * Uma promessa que so comeca quando alguem a espera, e uma vez so, como a consulta do Prisma (que
 * so vai ao banco no then)
 */
function preguicosa(comecar: () => Promise<unknown>) {
  let comecada: Promise<unknown> | undefined
  const vez = () => (comecada ??= comecar())

  return {
    then: <A = unknown, B = never>(
      cumprir?: ((valor: unknown) => A | PromiseLike<A>) | null,
      falhar?: ((erro: unknown) => B | PromiseLike<B>) | null,
    ) => vez().then(cumprir, falhar),
    catch: <B = never>(falhar?: ((erro: unknown) => B | PromiseLike<B>) | null) => vez().catch(falhar),
    finally: (depois?: (() => void) | null) => vez().finally(depois),
  }
}

/** O resultado de uma chamada do Prisma, embrulhado quando e uma consulta (algo que se espera) */
function embrulhar(resultado: unknown, embrulho: Embrulho): unknown {
  const consulta = resultado as PromiseLike<unknown> | null
  return typeof consulta?.then === 'function' ? embrulho(consulta) : resultado
}

/** O cliente com cada consulta (dos modelos e do SQL bruto) passando pelo embrulho */
function comEmbrulho<T extends object>(cliente: T, embrulho: Embrulho): T {
  const chamada = (dono: object, funcao: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => embrulhar(funcao.apply(dono, args), embrulho)

  return new Proxy(cliente, {
    get(alvo, campo) {
      const valor: unknown = Reflect.get(alvo, campo)

      if (typeof valor === 'function') return chamada(alvo, valor as (...args: unknown[]) => unknown)
      if (typeof valor !== 'object' || valor === null || typeof campo === 'symbol') return valor

      // um modelo (tx.animal, tx.caixa...): os metodos dele sao as consultas
      return new Proxy(valor, {
        get(modelo, metodo) {
          const funcao: unknown = Reflect.get(modelo, metodo)
          return typeof funcao === 'function' ? chamada(modelo, funcao as (...args: unknown[]) => unknown) : funcao
        },
      })
    },
  })
}

/**
 * A transacao que o servico recebe: a segunda consulta que comeca com outra em andamento falha. A
 * consulta do Prisma so roda quando alguem a espera (then), e o Promise.all espera todas juntas
 */
function vigiada(transacao: Transacao): Transacao {
  let emAndamento = 0

  return comEmbrulho(transacao, (consulta) =>
    preguicosa(() => {
      if (emAndamento > 0) {
        return Promise.reject(
          new Error(
            'Duas consultas ao mesmo tempo dentro da transacao do servico (um Promise.all?): a transacao e uma conexao so; faca uma de cada vez.',
          ),
        )
      }

      emAndamento += 1
      return Promise.resolve(consulta).finally(() => {
        emAndamento -= 1
      })
    }),
  )
}

/** A fila de cada conexao, para as consultas de fora dos servicos */
const filas = new WeakMap<Transacao, Promise<unknown>>()

/** Uma consulta de cada vez na conexao, na ordem em que foram esperadas */
function naFila(transacao: Transacao): Embrulho {
  return (consulta) =>
    preguicosa(() => {
      const vez = (filas.get(transacao) ?? Promise.resolve()).then(() => consulta)
      filas.set(
        transacao,
        vez.then(
          () => undefined,
          () => undefined,
        ),
      )
      return vez
    })
}

// ------------------------------------------------------------ o Prisma dos servicos

/** O $transaction do servico: um SAVEPOINT na transacao do teste, desfeito se o servico falha */
async function transacao<T>(servico: (tx: Transacao) => Promise<T>): Promise<T> {
  const daqui = tx()
  await daqui.$executeRawUnsafe('SAVEPOINT servico')

  try {
    const resultado = await servico(vigiada(daqui))
    await daqui.$executeRawUnsafe('RELEASE SAVEPOINT servico')
    return resultado
  } catch (erro) {
    await daqui.$executeRawUnsafe('ROLLBACK TO SAVEPOINT servico')
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
      const daqui = tx()
      return Reflect.get(comEmbrulho(daqui, naFila(daqui)), campo)
    },
  },
)

/** Uma transacao do teste aberta: o cliente dela e como termina-la */
export type TransacaoDoTeste = {
  tx: Transacao
  /** ROLLBACK: nada do que ela fez fica */
  desfazer: () => Promise<void>
  /**
   * COMMIT: o que ela fez fica no banco, visivel para as outras conexoes. So para o teste que
   * precisa disso (a reserva concorrente), que apaga o que gravou
   */
  confirmar: () => Promise<void>
}

/**
 * Abre uma transacao do teste no banco de 'url', numa conexao propria. Ela fica aberta ate
 * 'desfazer' (ROLLBACK) ou 'confirmar' (COMMIT), que fecham a conexao. A primeira aberta e a da
 * suite; as outras so valem dentro de naTransacao
 */
export async function abrirTransacaoDoTeste(url: string): Promise<TransacaoDoTeste> {
  const cliente = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  let termina: (confirma: boolean) => void = () => undefined
  let terminada: Promise<unknown> = Promise.resolve()
  let estaAqui: Transacao | undefined
  let erroAoTerminar: unknown

  await new Promise<void>((pronta, falhou) => {
    terminada = cliente
      .$transaction(
        async (aquela) => {
          estaAqui = aquela
          pronta()
          await new Promise<void>((confirma, desfaz) => {
            termina = (confirmar) => (confirmar ? confirma() : desfaz(new Error('fim do teste: desfaz tudo')))
          })
        },
        { maxWait: 60_000, timeout: 900_000 },
      )
      .catch((erro: unknown) => {
        if (estaAqui === undefined) falhou(erro)
        else erroAoTerminar = erro
      })
  })

  const desta = estaAqui as Transacao
  aberta ??= desta

  const terminar = async (confirmar: boolean) => {
    termina(confirmar)
    await terminada
    if (aberta === desta) aberta = undefined
    await cliente.$disconnect()
    // o COMMIT que falhou nao passa calado
    if (confirmar && erroAoTerminar !== undefined) throw erroAoTerminar
  }

  return { tx: desta, desfazer: () => terminar(false), confirmar: () => terminar(true) }
}

/** Cada caso num SAVEPOINT, desfeito no fim dele: para o beforeEach e o afterEach da suite */
export const abrirCaso = () => tx().$executeRawUnsafe('SAVEPOINT caso')
export const desfazerCaso = () => tx().$executeRawUnsafe('ROLLBACK TO SAVEPOINT caso')
