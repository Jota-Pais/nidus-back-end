import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { criarApp } from '../../app.ts'
import { enviarCodigoDeAcesso } from '../../shared/email.ts'
import { LIMITES_DE_PEDIDO, TENTATIVAS_POR_CODIGO, novoCodigo } from './acesso.service.ts'
import { hashSenha, senhaCorresponde } from './senha.ts'

// O banco aqui e de mentira, em memoria: so login.usuario, login.codigo_acesso e a senha mestra
// (sempre vazia), com o filtro do Prisma reduzido ao que o servico usa (igualdade, null, gt e
// lt). Cada consulta devolve copia, como o banco, e o update condicional confere e grava sem
// pausa no meio, como o UPDATE do Postgres. A trava do pedido de codigo vira uma fila. A
// transacao que lanca erro desfaz o que ela mesma gravou, como o ROLLBACK: a senha da conta
// desativada no meio grava o gasto do codigo antes de recusar.
// O e-mail tambem e de mentira e guarda o codigo enviado, que o teste usa como a pessoa usaria

type Linha = Record<string, unknown>

const falso = vi.hoisted(() => {
  const tabelas = { usuario: [] as Linha[], codigoAcesso: [] as Linha[] }
  const enviados: { email: string; codigo: string }[] = []
  let proximoId = 100
  let fila = Promise.resolve()

  const atende = (linha: Linha, onde: Linha) =>
    Object.entries(onde).every(([campo, condicao]) => {
      const valor = linha[campo]

      if (condicao !== null && typeof condicao === 'object' && !(condicao instanceof Date)) {
        const { gt, lt } = condicao as { gt?: unknown; lt?: unknown }
        return (
          (gt === undefined || Number(valor) > Number(gt)) &&
          (lt === undefined || Number(valor) < Number(lt))
        )
      }

      return valor === condicao
    })

  const aplicar = (linha: Linha, dados: Linha) => {
    for (const [campo, valor] of Object.entries(dados)) {
      if (valor !== null && typeof valor === 'object' && !(valor instanceof Date)) {
        const { increment = 0, decrement = 0 } = valor as { increment?: number; decrement?: number }
        linha[campo] = Number(linha[campo]) + increment - decrement
      } else {
        linha[campo] = valor
      }
    }
  }

  const padrao = {
    usuario: () => ({ idInstitucional: null, ativo: true, dtCriacao: new Date() }),
    codigoAcesso: () => ({ tentativas: 0, usadoEm: null, dtCriacao: new Date() }),
  }

  const copia = (linha: Linha | undefined) => (linha === undefined ? null : { ...linha })

  // Toda consulta espera uma volta do event loop, como a ida ao banco pela rede: e o que deixa
  // duas requisicoes em paralelo se intercalarem entre uma leitura e uma gravacao
  const rede = () => new Promise((resolve) => setImmediate(resolve))

  // 'desfazer' so existe dentro da transacao: cada gravacao deixa ali como volta atras
  const tabela = (nome: keyof typeof tabelas, desfazer?: (() => void)[]) => ({
    findUnique: async ({ where }: { where: Linha }) => {
      await rede()
      return copia(tabelas[nome].find((linha) => atende(linha, where)))
    },
    findFirst: async ({ where, orderBy }: { where: Linha; orderBy?: unknown }) => {
      if (JSON.stringify(orderBy) !== '{"id":"desc"}') {
        throw new Error('o banco de mentira so sabe buscar o mais novo, por id decrescente')
      }
      await rede()
      return copia(tabelas[nome].filter((linha) => atende(linha, where)).at(-1))
    },
    count: async ({ where }: { where: Linha }) => {
      await rede()
      return tabelas[nome].filter((linha) => atende(linha, where)).length
    },
    create: async ({ data }: { data: Linha }) => {
      await rede()
      const linha = { id: proximoId++, ...padrao[nome](), ...data }
      tabelas[nome].push(linha)
      desfazer?.push(() => tabelas[nome].splice(tabelas[nome].indexOf(linha), 1))
      return copia(linha)
    },
    updateMany: async ({ where, data }: { where: Linha; data: Linha }) => {
      await rede()
      const alvo = tabelas[nome].filter((linha) => atende(linha, where))
      for (const linha of alvo) {
        // so os campos gravados voltam: o que outra transacao mudou na mesma linha fica
        const antes = Object.fromEntries(Object.keys(data).map((campo) => [campo, linha[campo]]))
        aplicar(linha, data)
        desfazer?.push(() => Object.assign(linha, antes))
      }
      return { count: alvo.length }
    },
  })

  const prisma = {
    usuario: tabela('usuario'),
    codigoAcesso: tabela('codigoAcesso'),
    senhaMestra: { findFirst: async () => null },
    $transaction: async (corpo: (tx: unknown) => Promise<unknown>) => {
      let soltar = () => {}
      const desfazer: (() => void)[] = []
      const tx = {
        ...prisma,
        usuario: tabela('usuario', desfazer),
        codigoAcesso: tabela('codigoAcesso', desfazer),
        // a trava consultiva: a proxima transacao que pedir espera esta terminar
        $executeRaw: async (sql: TemplateStringsArray) => {
          if (!sql.join('').includes('pg_advisory_xact_lock')) {
            throw new Error(`SQL que o banco de mentira nao conhece: ${sql.join('?')}`)
          }
          const anterior = fila
          fila = new Promise((resolve) => {
            soltar = resolve
          })
          await anterior
          return 1
        },
      }

      try {
        return await corpo(tx)
      } catch (erro) {
        for (const volta of desfazer.reverse()) volta()
        throw erro
      } finally {
        soltar()
      }
    },
  }

  return {
    tabelas,
    enviados,
    prisma,
    /** Os usuarios do teste e nenhum codigo */
    reiniciar(usuarios: Linha[]) {
      tabelas.usuario.splice(0, Infinity, ...usuarios.map((usuario) => ({ ...usuario })))
      tabelas.codigoAcesso.splice(0)
      enviados.splice(0)
      proximoId = 100
    },
    /** Pedidos de outros e-mails, feitos ha tantos minutos, para chegar perto dos tetos */
    encher(quantos: number, minutosAtras: number) {
      for (let i = 0; i < quantos; i++) {
        tabelas.codigoAcesso.push({
          id: proximoId++,
          email: `outro${i}@ufsc.br`,
          hashCodigo: 'x',
          expiraEm: new Date(),
          tentativas: 0,
          usadoEm: null,
          dtCriacao: new Date(Date.now() - minutosAtras * 60_000),
        })
      }
    },
  }
})

vi.mock('../../shared/prisma.ts', () => ({ prisma: falso.prisma }))

vi.mock('../../shared/email.ts', () => ({
  enviarCodigoDeAcesso: vi.fn(async (email: string, codigo: string) => {
    falso.enviados.push({ email, codigo })
  }),
}))

// O hash e a conferencia de verdade, so espiados: para contar e para agir no meio do caminho
vi.mock('./senha.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./senha.ts')>()
  return { hashSenha: vi.fn(real.hashSenha), senhaCorresponde: vi.fn(real.senhaCorresponde) }
})

const SENHA_ANTIGA = 'antiga123'
const SENHA_NOVA = 'nova-senha-1'
const INVALIDO = 'Codigo invalido ou expirado.'
const ESGOTADAS = 'Tentativas esgotadas. Peca um codigo novo.'

let hashAntigo = ''

beforeAll(async () => {
  hashAntigo = await hashSenha(SENHA_ANTIGA)
})

beforeEach(() => {
  falso.reiniciar([
    { id: 1, nome: 'Ana Souza', email: 'tecnico@ufsc.br', perfil: 'T', ativo: true, hashSenha: hashAntigo },
    { id: 2, nome: 'Carlos Mendes', email: 'gestor@ufsc.br', perfil: 'G', ativo: true, hashSenha: hashAntigo },
    { id: 3, nome: 'Davi Lopes', email: 'inativo@ufsc.br', perfil: 'P', ativo: false, hashSenha: hashAntigo },
  ])
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Um servidor so para o arquivo, numa porta livre. Com o app, o supertest abre e fecha um
// servidor a cada requisicao, e no Windows essa troca derrubava o processo do teste de vez em
// quando, sem mensagem (saida 0xC0000409)
const servidor = criarApp().listen(0)

afterAll(() => new Promise<void>((pronto) => servidor.close(() => pronto())))

const pedir = (email: string) => request(servidor).post('/api/acesso/codigo').send({ email })
const conferir = (email: string, codigo: string) =>
  request(servidor).post('/api/acesso/verificacao').send({ email, codigo })
const definir = (corpo: object) => request(servidor).post('/api/acesso/senha').send(corpo)
const entrar = (email: string, senha: string) =>
  request(servidor).post('/api/sessao').send({ email, senha })

/** O ultimo codigo que chegou ao e-mail */
function codigoDe(email: string): string {
  const enviado = falso.enviados.findLast((e) => e.email === email)
  if (enviado === undefined) throw new Error(`nenhum codigo enviado para ${email}`)
  return enviado.codigo
}

/** Um codigo de 6 digitos que nao e o certo */
const outro = (codigo: string) => (codigo === '000000' ? '111111' : '000000')

/** A linha mais nova de login.codigo_acesso do e-mail - a propria, nao copia */
function linhaDe(email: string): Linha {
  const linha = falso.tabelas.codigoAcesso.filter((l) => l.email === email).at(-1)
  if (linha === undefined) throw new Error(`nenhum codigo pedido para ${email}`)
  return linha
}

/** O usuario do banco de mentira - o proprio, nao copia */
function usuarioDe(email: string): Linha {
  const usuario = falso.tabelas.usuario.find((u) => u.email === email)
  if (usuario === undefined) throw new Error(`nenhum usuario ${email}`)
  return usuario
}

/** O minuto entre dois pedidos passa: cada linha fica dois minutos mais velha */
function passaUmMinuto() {
  for (const linha of falso.tabelas.codigoAcesso) {
    linha.dtCriacao = new Date(Number(linha.dtCriacao) - 2 * 60_000)
  }
}

const statusEmOrdem = (respostas: { status: number }[]) =>
  respostas.map((r) => r.status).sort((a, b) => a - b)

describe('POST /api/acesso/codigo', () => {
  it('responde igual com conta, sem conta e com conta inativa, no 429 inclusive', async () => {
    const emails = ['tecnico@ufsc.br', 'novo@ufsc.br', 'inativo@ufsc.br']
    const primeiros = []
    const segundos = []

    for (const email of emails) primeiros.push(await pedir(email))
    for (const email of emails) segundos.push(await pedir(email))

    for (const resposta of primeiros) {
      expect(resposta.status).toBe(200)
      expect(resposta.body).toEqual({ validadeEmMinutos: 15 })
    }

    for (const resposta of segundos) {
      expect(resposta.status).toBe(429)
      expect(resposta.body).toEqual({
        erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Aguarde um minuto para pedir outro codigo.' },
      })
    }

    // a inativa nao recebe e-mail, mas ganha a linha dela, que e o que a leva ao mesmo 429
    expect(falso.enviados.map((e) => e.email)).toEqual(['tecnico@ufsc.br', 'novo@ufsc.br'])
    expect(falso.tabelas.codigoAcesso.map((l) => l.email)).toEqual(emails)
  })

  it.each([
    'eu@gmail.com,voce@ufsc.br',
    'eu,voce@ufsc.br',
    'eu@ufsc.br;voce@ufsc.br',
    'eu@ufsc.br voce@ufsc.br',
    'eu@gmail.com',
    'eu@ufsc.br.exemplo.com',
    `${'a'.repeat(160)}@ufsc.br`,
  ])('recusa %s com 400 no campo email, sem gravar nem enviar', async (email) => {
    const resposta = await pedir(email)

    expect(resposta.status).toBe(400)
    expect(resposta.body.erro.codigo).toBe('VALIDACAO')
    expect(Object.keys(resposta.body.erro.campos)).toEqual(['email'])
    expect(falso.tabelas.codigoAcesso).toHaveLength(0)
    expect(enviarCodigoDeAcesso).not.toHaveBeenCalled()
  })

  it('aceita subdominio da UFSC, maiuscula e espaco, e grava e envia em minusculas', async () => {
    expect((await pedir('  Novo@UFSC.br ')).status).toBe(200)
    expect((await pedir('aluno@grad.ufsc.br')).status).toBe(200)

    expect(falso.tabelas.codigoAcesso.map((l) => l.email)).toEqual(['novo@ufsc.br', 'aluno@grad.ufsc.br'])
    // um destinatario por envio, o endereco sozinho
    expect(vi.mocked(enviarCodigoDeAcesso).mock.calls.map(([email]) => email)).toEqual([
      'novo@ufsc.br',
      'aluno@grad.ufsc.br',
    ])
  })

  it('o codigo sorteado tem 6 digitos, com zero a esquerda abaixo de 100000', () => {
    const codigos = Array.from({ length: 500 }, novoCodigo)

    expect(codigos.every((codigo) => /^\d{6}$/.test(codigo))).toBe(true)
    // um em cada dez fica abaixo de 100000: em 500, nenhum seria 1 chance em 10^22
    expect(codigos.some((codigo) => codigo.startsWith('0'))).toBe(true)
  })

  it('o banco guarda so o hash do codigo enviado', async () => {
    await pedir('novo@ufsc.br')
    const codigo = codigoDe('novo@ufsc.br')
    const { hashCodigo } = linhaDe('novo@ufsc.br')

    expect(hashCodigo).not.toContain(codigo)
    expect(await senhaCorresponde(codigo, String(hashCodigo))).toBe(true)
  })

  it('pedir de novo invalida o codigo anterior marcando a linha, sem apagar', async () => {
    await pedir('tecnico@ufsc.br')
    const primeiro = codigoDe('tecnico@ufsc.br')
    passaUmMinuto()
    expect((await pedir('tecnico@ufsc.br')).status).toBe(200)
    const segundo = codigoDe('tecnico@ufsc.br')

    const [anterior, atual] = falso.tabelas.codigoAcesso
    expect(anterior?.usadoEm).toBeInstanceOf(Date)
    expect(atual?.usadoEm).toBeNull()
    expect((await conferir('tecnico@ufsc.br', segundo)).status).toBe(200)
    // so o sorteio repetir o codigo (1 em 1 milhao) faria o anterior passar
    expect((await conferir('tecnico@ufsc.br', primeiro)).status).toBe(primeiro === segundo ? 200 : 409)
  })

  it('o mesmo e-mail pede 5 codigos por hora', async () => {
    for (let i = 0; i < LIMITES_DE_PEDIDO.porEmailPorHora; i++) {
      expect((await pedir('tecnico@ufsc.br')).status).toBe(200)
      passaUmMinuto()
    }

    const resposta = await pedir('tecnico@ufsc.br')

    expect(resposta.status).toBe(429)
    expect(resposta.body.erro.mensagem).toBe(
      'Voce ja pediu 5 codigos na ultima hora. Tente de novo mais tarde.',
    )
    expect(enviarCodigoDeAcesso).toHaveBeenCalledTimes(LIMITES_DE_PEDIDO.porEmailPorHora)
  })

  it.each([
    ['por hora', LIMITES_DE_PEDIDO.totalPorHora, 30],
    ['por dia', LIMITES_DE_PEDIDO.totalPorDia, 120],
  ])('o teto total %s devolve 429 sem chamar o servico de e-mail', async (_teto, teto, minutosAtras) => {
    falso.encher(teto - 1, minutosAtras)

    const ultimo = await pedir('novo@ufsc.br')
    const alemDoTeto = await pedir('outro-novo@ufsc.br')

    expect(ultimo.status).toBe(200)
    expect(alemDoTeto.status).toBe(429)
    expect(alemDoTeto.body.erro).toEqual({
      codigo: 'MUITAS_TENTATIVAS',
      mensagem: 'Muitos codigos pedidos agora. Tente de novo mais tarde.',
    })
    expect(vi.mocked(enviarCodigoDeAcesso).mock.calls.map(([email]) => email)).toEqual(['novo@ufsc.br'])
    expect(falso.tabelas.codigoAcesso).toHaveLength(teto)
  })

  it('o 429 sai antes do hash do codigo, que e a parte cara do pedido', async () => {
    await pedir('tecnico@ufsc.br')
    falso.encher(LIMITES_DE_PEDIDO.totalPorDia, 120)
    vi.mocked(hashSenha).mockClear()

    const doEmail = await pedir('tecnico@ufsc.br')
    const doTotal = await pedir('novo@ufsc.br')

    expect([doEmail.status, doTotal.status]).toEqual([429, 429])
    expect(hashSenha).not.toHaveBeenCalled()
  })

  it('dois pedidos em paralelo nao passam juntos do limite do e-mail nem do teto total', async () => {
    const mesmoEmail = await Promise.all([pedir('novo@ufsc.br'), pedir('novo@ufsc.br')])

    expect(statusEmOrdem(mesmoEmail)).toEqual([200, 429])

    falso.reiniciar([])
    falso.encher(LIMITES_DE_PEDIDO.totalPorHora - 1, 30)
    vi.mocked(enviarCodigoDeAcesso).mockClear()

    const emailsDiferentes = await Promise.all([pedir('a@ufsc.br'), pedir('b@ufsc.br')])

    expect(statusEmOrdem(emailsDiferentes)).toEqual([200, 429])
    expect(enviarCodigoDeAcesso).toHaveBeenCalledTimes(1)
  })

  it('o envio nao segura a resposta, e a falha dele fica no log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(enviarCodigoDeAcesso)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(async () => {
        throw new Error('servico fora do ar')
      })

    const parado = await pedir('tecnico@ufsc.br')
    const falhou = await pedir('gestor@ufsc.br')

    expect(parado.status).toBe(200)
    expect(falhou.status).toBe(200)
    expect(falhou.body).toEqual(parado.body)
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining('gestor@ufsc.br'), expect.any(Error)),
    )
  })
})

describe('POST /api/acesso/verificacao', () => {
  const invalido = { codigo: 'CODIGO_INVALIDO', mensagem: INVALIDO, campos: { codigo: INVALIDO } }

  it('409 com codigo errado, vencido ou nunca pedido', async () => {
    const nuncaPedido = await conferir('tecnico@ufsc.br', '123456')

    await pedir('tecnico@ufsc.br')
    const certo = codigoDe('tecnico@ufsc.br')
    const errado = await conferir('tecnico@ufsc.br', outro(certo))

    linhaDe('tecnico@ufsc.br').expiraEm = new Date(Date.now() - 1000)
    const vencido = await conferir('tecnico@ufsc.br', certo)

    for (const resposta of [nuncaPedido, errado, vencido]) {
      expect(resposta.status).toBe(409)
      expect(resposta.body.erro).toEqual(invalido)
    }
  })

  it('acertar nao gasta tentativa nem o codigo, e diz se a conta e nova', async () => {
    await pedir('tecnico@ufsc.br')
    await pedir('novo@ufsc.br')

    for (let i = 0; i < TENTATIVAS_POR_CODIGO + 2; i++) {
      const resposta = await conferir('tecnico@ufsc.br', codigoDe('tecnico@ufsc.br'))
      expect(resposta.body).toEqual({ novo: false })
    }

    expect(linhaDe('tecnico@ufsc.br')).toMatchObject({ tentativas: 0, usadoEm: null })
    expect((await conferir('novo@ufsc.br', codigoDe('novo@ufsc.br'))).body).toEqual({ novo: true })

    // e a senha nova ainda passa com o mesmo codigo
    const senha = await definir({
      email: 'tecnico@ufsc.br',
      codigo: codigoDe('tecnico@ufsc.br'),
      senha: SENHA_NOVA,
    })
    expect(senha.status).toBe(200)
  })

  it('a 5a tentativa errada mata o codigo, e a mensagem avisa', async () => {
    await pedir('tecnico@ufsc.br')
    const certo = codigoDe('tecnico@ufsc.br')
    const mensagens = []

    for (let i = 0; i < TENTATIVAS_POR_CODIGO; i++) {
      const resposta = await conferir('tecnico@ufsc.br', outro(certo))
      expect(resposta.status).toBe(409)
      mensagens.push(resposta.body.erro.mensagem)
    }

    expect(mensagens).toEqual([INVALIDO, INVALIDO, INVALIDO, INVALIDO, ESGOTADAS])

    const depois = await conferir('tecnico@ufsc.br', certo)
    expect(depois.status).toBe(409)
    expect(depois.body.erro.campos).toEqual({ codigo: ESGOTADAS })
    expect(linhaDe('tecnico@ufsc.br').tentativas).toBe(TENTATIVAS_POR_CODIGO)
  })

  it('a ultima de varias erradas em paralelo tambem avisa que as tentativas acabaram', async () => {
    await pedir('tecnico@ufsc.br')
    const certo = codigoDe('tecnico@ufsc.br')

    const respostas = await Promise.all(
      Array.from({ length: TENTATIVAS_POR_CODIGO }, () => conferir('tecnico@ufsc.br', outro(certo))),
    )

    // todas leem 'tentativas' 0 antes da primeira reserva: o aviso vem da linha relida
    expect(respostas.map((r) => r.body.erro.mensagem)).toContain(ESGOTADAS)
    expect(linhaDe('tecnico@ufsc.br').tentativas).toBe(TENTATIVAS_POR_CODIGO)
  })

  it('o codigo trocado no meio da conferencia da invalido, nao tentativas esgotadas', async () => {
    await pedir('tecnico@ufsc.br')
    const antigo = codigoDe('tecnico@ufsc.br')
    const buscar = falso.prisma.codigoAcesso.findFirst

    // entre ler o codigo vigente e reservar a tentativa, outra aba pede um codigo novo
    vi.spyOn(falso.prisma.codigoAcesso, 'findFirst').mockImplementationOnce(async (consulta) => {
      const lida = await buscar(consulta)
      passaUmMinuto()
      expect((await pedir('tecnico@ufsc.br')).status).toBe(200)
      return lida
    })

    const resposta = await conferir('tecnico@ufsc.br', antigo)

    expect(resposta.status).toBe(409)
    expect(resposta.body.erro.campos).toEqual({ codigo: INVALIDO })
  })

  it('20 tentativas erradas em paralelo nao passam de 5 conferencias', async () => {
    await pedir('tecnico@ufsc.br')
    const certo = codigoDe('tecnico@ufsc.br')
    vi.mocked(senhaCorresponde).mockClear()

    const respostas = await Promise.all(
      Array.from({ length: 20 }, () => conferir('tecnico@ufsc.br', outro(certo))),
    )

    expect(respostas.every((r) => r.status === 409)).toBe(true)
    expect(senhaCorresponde).toHaveBeenCalledTimes(TENTATIVAS_POR_CODIGO)
    expect(linhaDe('tecnico@ufsc.br').tentativas).toBe(TENTATIVAS_POR_CODIGO)
    expect((await conferir('tecnico@ufsc.br', certo)).status).toBe(409)
  })

  it('conta desativada depois do envio da o mesmo 409, mesmo com o codigo certo', async () => {
    await pedir('tecnico@ufsc.br')
    const certo = codigoDe('tecnico@ufsc.br')
    const errado = await conferir('tecnico@ufsc.br', outro(certo))

    usuarioDe('tecnico@ufsc.br').ativo = false
    const desativada = await conferir('tecnico@ufsc.br', certo)

    expect(desativada.status).toBe(409)
    expect(desativada.body).toEqual(errado.body)
  })
})

describe('POST /api/acesso/senha', () => {
  it('sem codigo valido, o 409 e igual com conta, sem conta, com nome e sem nome', async () => {
    await pedir('tecnico@ufsc.br')
    await pedir('novo@ufsc.br')
    const respostas = []

    for (const email of ['tecnico@ufsc.br', 'novo@ufsc.br', 'nunca-pediu@ufsc.br']) {
      const codigo = email === 'nunca-pediu@ufsc.br' ? '123456' : outro(codigoDe(email))

      for (const nome of [undefined, 'Fulano de Tal']) {
        const comNome = nome === undefined ? {} : { nome }
        respostas.push(await definir({ email, codigo, senha: SENHA_NOVA, ...comNome }))
      }
    }

    for (const resposta of respostas) {
      expect(resposta.status).toBe(409)
      expect(resposta.body).toEqual({
        erro: { codigo: 'CODIGO_INVALIDO', mensagem: INVALIDO, campos: { codigo: INVALIDO } },
      })
      expect(resposta.headers['set-cookie']).toBeUndefined()
    }

    expect(usuarioDe('tecnico@ufsc.br').hashSenha).toBe(hashAntigo)
    expect(falso.tabelas.usuario).toHaveLength(3)
  })

  it('conta nova sem nome da 400 no campo nome, sem gastar o codigo', async () => {
    await pedir('novo@ufsc.br')
    const codigo = codigoDe('novo@ufsc.br')

    const semNome = await definir({ email: 'novo@ufsc.br', codigo, senha: SENHA_NOVA })

    expect(semNome.status).toBe(400)
    expect(semNome.body.erro).toEqual({
      codigo: 'VALIDACAO',
      mensagem: 'Confira os campos destacados.',
      campos: { nome: 'Informe o seu nome.' },
    })
    expect(linhaDe('novo@ufsc.br')).toMatchObject({ tentativas: 0, usadoEm: null })
    expect(falso.tabelas.usuario).toHaveLength(3)

    const comNome = await definir({ email: 'novo@ufsc.br', codigo, senha: SENHA_NOVA, nome: 'Fulano' })
    expect(comNome.status).toBe(200)
  })

  it('conta nova sai pesquisador, mesmo pedindo outro perfil, e o codigo fica gasto', async () => {
    await pedir('novo@ufsc.br')
    const codigo = codigoDe('novo@ufsc.br')

    const resposta = await definir({
      email: 'novo@ufsc.br',
      codigo,
      senha: SENHA_NOVA,
      nome: '  Fulano de Tal ',
      perfil: 'gestor',
    })

    expect(resposta.status).toBe(200)
    expect(resposta.body.usuario).toEqual({
      id: expect.any(Number),
      nome: 'Fulano de Tal',
      email: 'novo@ufsc.br',
      perfil: 'pesquisador',
    })
    expect(usuarioDe('novo@ufsc.br')).toMatchObject({ perfil: 'P', ativo: true })
    expect((await entrar('novo@ufsc.br', SENHA_NOVA)).status).toBe(200)

    expect(linhaDe('novo@ufsc.br').usadoEm).toBeInstanceOf(Date)
    expect((await conferir('novo@ufsc.br', codigo)).status).toBe(409)
  })

  it('o login acha a conta criada aqui com o e-mail em maiuscula e com espaco', async () => {
    await pedir('novo@ufsc.br')
    await definir({ email: 'novo@ufsc.br', codigo: codigoDe('novo@ufsc.br'), senha: SENHA_NOVA, nome: 'Fulano' })

    const login = await entrar('  NOVO@UFSC.br ', SENHA_NOVA)

    expect(login.status).toBe(200)
    expect(login.body.usuario.email).toBe('novo@ufsc.br')
  })

  it.each([
    ['senha de 7 caracteres', { senha: '1234567' }, 'senha'],
    ['nome de 121 caracteres', { nome: 'a'.repeat(121) }, 'nome'],
  ])('%s da 400 no campo, sem tocar no codigo', async (_caso, fora, campo) => {
    await pedir('novo@ufsc.br')
    // no limite: 8 caracteres de senha e 120 de nome, o tamanho de usuario.nome
    const noLimite = { email: 'novo@ufsc.br', codigo: codigoDe('novo@ufsc.br'), senha: '12345678', nome: 'a'.repeat(120) }

    const recusada = await definir({ ...noLimite, ...fora })

    expect(recusada.status).toBe(400)
    expect(Object.keys(recusada.body.erro.campos)).toEqual([campo])
    expect(linhaDe('novo@ufsc.br')).toMatchObject({ tentativas: 0, usadoEm: null })
    expect(falso.tabelas.usuario).toHaveLength(3)

    expect((await definir(noLimite)).status).toBe(200)
  })

  it('conta que ja existe troca so a senha: perfil e nome ficam, e o codigo fica gasto', async () => {
    await pedir('gestor@ufsc.br')
    const codigo = codigoDe('gestor@ufsc.br')

    const resposta = await definir({
      email: 'gestor@ufsc.br',
      codigo,
      senha: SENHA_NOVA,
      nome: 'Outro Nome',
    })

    expect(resposta.status).toBe(200)
    expect(resposta.body.usuario).toEqual({
      id: 2,
      nome: 'Carlos Mendes',
      email: 'gestor@ufsc.br',
      perfil: 'gestor',
    })
    expect(usuarioDe('gestor@ufsc.br')).toMatchObject({ nome: 'Carlos Mendes', perfil: 'G' })
    expect((await entrar('gestor@ufsc.br', SENHA_NOVA)).status).toBe(200)
    expect((await entrar('gestor@ufsc.br', SENHA_ANTIGA)).status).toBe(401)

    // a senha esquecida e o caminho que chega ao tecnico e ao gestor: o mesmo codigo nao troca
    // a senha de novo nem abre outra sessao nos 15 minutos que ainda faltam
    expect(linhaDe('gestor@ufsc.br').usadoEm).toBeInstanceOf(Date)
    const deNovo = await definir({ email: 'gestor@ufsc.br', codigo, senha: 'outra-senha-2' })

    expect(deNovo.status).toBe(409)
    expect(deNovo.body.erro.codigo).toBe('CODIGO_INVALIDO')
    expect(deNovo.headers['set-cookie']).toBeUndefined()
    expect((await entrar('gestor@ufsc.br', SENHA_NOVA)).status).toBe(200)
  })

  it('conta inativa nao troca a senha nem ganha sessao', async () => {
    // a inativa nunca recebe o codigo
    await pedir('inativo@ufsc.br')
    const inativa = await definir({ email: 'inativo@ufsc.br', codigo: '123456', senha: SENHA_NOVA })

    // e o codigo certo de uma conta desativada depois do envio tambem nao serve
    await pedir('tecnico@ufsc.br')
    const certo = codigoDe('tecnico@ufsc.br')
    usuarioDe('tecnico@ufsc.br').ativo = false
    const desativada = await definir({ email: 'tecnico@ufsc.br', codigo: certo, senha: SENHA_NOVA })

    for (const resposta of [inativa, desativada]) {
      expect(resposta.status).toBe(409)
      expect(resposta.body.erro.codigo).toBe('CODIGO_INVALIDO')
      expect(resposta.headers['set-cookie']).toBeUndefined()
    }

    expect(usuarioDe('inativo@ufsc.br').hashSenha).toBe(hashAntigo)
    expect(usuarioDe('tecnico@ufsc.br').hashSenha).toBe(hashAntigo)
  })

  it('conta desativada entre a conferencia do codigo e a gravacao nao troca a senha', async () => {
    await pedir('tecnico@ufsc.br')
    const real = await vi.importActual<typeof import('./senha.ts')>('./senha.ts')

    // o hash da senha nova roda depois da conferencia e antes da transacao: e quando o gestor
    // desativa a conta
    vi.mocked(hashSenha).mockImplementationOnce(async (senha) => {
      usuarioDe('tecnico@ufsc.br').ativo = false
      return real.hashSenha(senha)
    })

    const resposta = await definir({
      email: 'tecnico@ufsc.br',
      codigo: codigoDe('tecnico@ufsc.br'),
      senha: SENHA_NOVA,
    })

    expect(resposta.status).toBe(409)
    expect(resposta.body.erro.codigo).toBe('CODIGO_INVALIDO')
    expect(resposta.headers['set-cookie']).toBeUndefined()
    expect(usuarioDe('tecnico@ufsc.br').hashSenha).toBe(hashAntigo)
    // o gasto do codigo e a senha estao na mesma transacao: a recusa desfaz o gasto tambem
    expect(linhaDe('tecnico@ufsc.br')).toMatchObject({ usadoEm: null, tentativas: 0 })
  })

  it('o cookie da sessao sai igual ao do login', async () => {
    const login = await entrar('tecnico@ufsc.br', SENHA_ANTIGA)
    await pedir('tecnico@ufsc.br')
    const acesso = await definir({
      email: 'tecnico@ufsc.br',
      codigo: codigoDe('tecnico@ufsc.br'),
      senha: SENHA_NOVA,
    })

    // so o valor e a data de expiracao mudam de uma sessao para outra
    const cookie = (resposta: { headers: Record<string, unknown> }) => String(resposta.headers['set-cookie'])
    const atributos = (resposta: { headers: Record<string, unknown> }) =>
      cookie(resposta).replace(/^nidus_sessao=[^;]+/, '').replace(/Expires=[^;]+/, '')

    expect(login.status).toBe(200)
    expect(acesso.status).toBe(200)
    expect(atributos(acesso)).toBe(atributos(login))
    expect(atributos(login)).toContain('Max-Age=43200')
    expect(atributos(login)).toContain('HttpOnly')

    // e e uma sessao de verdade: o GET /api/sessao reconhece quem entrou
    const quemSou = await request(servidor)
      .get('/api/sessao')
      .set('Cookie', cookie(acesso).split(';')[0] ?? '')
    expect(quemSou.body.usuario).toEqual(acesso.body.usuario)
  })

  it.each([
    ['conta nova', 'novo@ufsc.br'],
    ['conta que ja existe', 'gestor@ufsc.br'],
  ])('%s: duas senhas em paralelo com o mesmo codigo, so uma passa', async (_conta, email) => {
    await pedir(email)
    const corpo = { email, codigo: codigoDe(email), nome: 'Fulano' }
    const senhas = ['primeira-senha-1', 'segunda-senha-2']

    const respostas = await Promise.all(senhas.map((senha) => definir({ ...corpo, senha })))

    expect(statusEmOrdem(respostas)).toEqual([200, 409])
    expect(respostas.filter((r) => r.headers['set-cookie'] !== undefined)).toHaveLength(1)
    expect(falso.tabelas.usuario.filter((u) => u.email === email)).toHaveLength(1)

    // a senha que vale e a da resposta que passou
    const valeu = respostas[0]?.status === 200 ? 0 : 1
    expect((await entrar(email, senhas[valeu] ?? '')).status).toBe(200)
    expect((await entrar(email, senhas[1 - valeu] ?? '')).status).toBe(401)
  })
})

it('nenhuma resposta das rotas de acesso e 401', async () => {
  const respostas = [
    await pedir(''),
    await pedir('tecnico@ufsc.br'),
    await pedir('tecnico@ufsc.br'),
    await conferir('tecnico@ufsc.br', '12'),
    await conferir('gestor@ufsc.br', '123456'),
    await definir({}),
    await definir({ email: 'gestor@ufsc.br', codigo: '123456', senha: SENHA_NOVA }),
  ]

  expect(respostas.map((r) => r.status)).toEqual([400, 200, 429, 400, 409, 400, 409])
})
