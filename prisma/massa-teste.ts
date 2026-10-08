// Massa de demonstracao da colonia.
//
//   npm run db:massa
//
// Separada do seed de proposito: **carga inicial e dado real, massa e ficcao.**
// O `prisma/seed.ts` carrega o Anexo A, que o cliente forneceu e vale em
// producao; nada aqui vale - sao casais, partos e pedidos inventados para a
// grade, o quadro e a ficha terem o que mostrar em 24/09.
//
// O que a massa cobre, item por item do card:
//
//   - uma estante densa (E-02, 42 das 50 posicoes) e uma quase vazia (E-04, 3
//     das 40). E-01 e E-03 ficam vazias - grade vazia tambem precisa ser vista.
//   - casais do 1o ao 5o ciclo, incluindo um no 5o parto (`RN-04`).
//   - partos nos tres graus do `RN-08`: confirmado (desmamou), previsto
//     (nasceu, desmame estimado) e projetado (nem nasceu).
//   - uma caixa em cada um dos 5 estados do quadro.
//   - um parto com previsao VENCIDA sem confirmacao: o alerta do `RF-REP-07`.
//   - compromissos firmados, que fazem a caixa ser parcial ou totalmente
//     comprometida - e que passam pelo trigger do `RN-09` no caminho.
//
// As datas saem de `RN-05`, nunca digitadas soltas: parto previsto =
// acasalamento + gestacao, desmame previsto = parto previsto + aleitamento,
// acasalamento do ciclo n = parto real do ciclo n-1 + intervalo. Sao calculadas
// a partir de HOJE, para "previsto" cair no futuro e "vencido" no passado.
//
// O endereco de cada caixa sai de `codigoDaPosicao`, a mesma funcao que a API
// usa - o `CONF-07` continua num lugar so, e responder o cliente nao exige
// mexer aqui.

import { codigoDaPosicao } from '../src/modules/infra/endereco.ts'
import { somarDias } from '../src/modules/reproducao/cadeiaTemporal.ts'
// A oferta sai da MESMA funcao que a API usa, e nao de uma conta repetida aqui:
// massa que calcule oferta diferente do servico pede compromisso que o trigger
// recusa, e o erro apareceria como "a massa esta quebrada".
import { ofertaBruta } from '../src/modules/reproducao/disponibilidade.ts'
import { prisma } from '../src/shared/prisma.ts'

/** Numero do projeto de etica que serve de marca: se existe, a massa ja rodou. */
const PROJETO_MARCA = '23080.001234/2026-11'

const hoje = new Date().toISOString().slice(0, 10)
const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

/** Parametros do Anexo A. Lidos do banco para nao virarem constante aqui. */
type Parametros = {
  gestacaoDias: number
  aleitamentoDias: number
  intervaloCicloDias: number
  maxPartoCasal: number
}

/**
 * Um ciclo ja resolvido em datas, pronto para gravar.
 *
 * `desmamado`/`nascido`/`eutanasiado` nulos onde o evento nao aconteceu - e a
 * diferenca entre "vai nascer" e "nasceu" que o `RF-REP-02` manda a ficha
 * mostrar, e o que o `RN-08` usa para achar o grau de certeza.
 */
type CicloPlanejado = {
  ordem: number
  dtAcasalamento: string
  dtPartoPrevisto: string
  dtPartoReal: string | null
  nascidoM: number | null
  nascidoF: number | null
  dtSelecao: string | null
  eutanasiadoM: number | null
  eutanasiadoF: number | null
  dtDesmamePrevisto: string
  dtDesmameReal: string | null
  desmamadoM: number | null
  desmamadoF: number | null
  grauCerteza: 'C' | 'P' | 'J'
}

/**
 * Monta a cadeia de ciclos de um casal a partir do primeiro acasalamento.
 *
 * `fechados` e quantos ciclos ja desmamaram; o ciclo seguinte fica no estagio
 * pedido em `estagioDoUltimo`. E a unica maneira honesta de ter um casal "no 3o
 * ciclo": os dois anteriores existem, com data real, porque `RN-05` faz o
 * acasalamento de cada ciclo depender do parto real do anterior.
 */
function planejarCiclos(
  primeiroAcasalamento: string,
  fechados: number,
  estagioDoUltimo: 'projetado' | 'previsto' | 'confirmado' | 'vencido',
  ninhada: { nascidoM: number; nascidoF: number; eutanasiadoM: number; eutanasiadoF: number },
  { gestacaoDias, aleitamentoDias, intervaloCicloDias }: Parametros,
): CicloPlanejado[] {
  const ciclos: CicloPlanejado[] = []
  let acasalamento = primeiroAcasalamento

  const total = fechados + 1

  for (let ordem = 1; ordem <= total; ordem += 1) {
    const partoPrevisto = somarDias(acasalamento, gestacaoDias)
    const desmamePrevisto = somarDias(partoPrevisto, aleitamentoDias)
    const ultimo = ordem === total

    // Ciclo anterior ao ultimo: sempre fechado, com parto e desmame reais no
    // dia previsto (a massa nao simula atraso no passado - o atraso interessa
    // no ciclo corrente, onde o alerta aparece).
    const estagio = ultimo ? estagioDoUltimo : 'confirmado'

    const partoReal = estagio === 'projetado' || estagio === 'vencido' ? null : partoPrevisto
    const desmameReal = estagio === 'confirmado' ? desmamePrevisto : null

    const nasceu = partoReal !== null
    const desmamou = desmameReal !== null

    ciclos.push({
      ordem,
      dtAcasalamento: acasalamento,
      dtPartoPrevisto: partoPrevisto,
      dtPartoReal: partoReal,
      nascidoM: nasceu ? ninhada.nascidoM : null,
      nascidoF: nasceu ? ninhada.nascidoF : null,
      dtSelecao: nasceu ? partoReal : null,
      eutanasiadoM: nasceu ? ninhada.eutanasiadoM : null,
      eutanasiadoF: nasceu ? ninhada.eutanasiadoF : null,
      dtDesmamePrevisto: desmamePrevisto,
      dtDesmameReal: desmameReal,
      desmamadoM: desmamou ? ninhada.nascidoM - ninhada.eutanasiadoM : null,
      desmamadoF: desmamou ? ninhada.nascidoF - ninhada.eutanasiadoF : null,
      grauCerteza: desmamou ? 'C' : nasceu ? 'P' : 'J',
    })

    if (partoReal !== null) {
      acasalamento = somarDias(partoReal, intervaloCicloDias)
    }
  }

  return ciclos
}

/** O elenco: um casal por caixa (`RN-03`), cada um num estagio diferente. */
type CasalPlanejado = {
  apelido: string
  face: number
  linha: number
  coluna: number
  linhagem: string
  grupoMacho: string
  grupoFemea: string
  /** Quantos ciclos ja desmamaram antes do corrente. */
  fechados: number
  estagio: 'projetado' | 'previsto' | 'confirmado' | 'vencido'
  /** Dias atras em que o primeiro acasalamento aconteceu. */
  diasAtras: number
  ninhada: { nascidoM: number; nascidoF: number; eutanasiadoM: number; eutanasiadoF: number }
  /** Quanto do ciclo corrente ja esta prometido. `total` reserva a oferta toda. */
  comprometer: { m: number; f: number } | 'total' | null
  /** Estado do quadro que esta caixa tem de exibir. */
  estado: 'R' | 'P' | 'T' | 'E' | 'X'
}

const elenco: CasalPlanejado[] = [
  {
    // 1o ciclo, nada nasceu: oferta PROJETADA, so expectativa. Estado R.
    apelido: 'projetado no 1o ciclo',
    face: 1,
    linha: 1,
    coluna: 1,
    linhagem: 'Wistar',
    grupoMacho: 'A',
    grupoFemea: 'B',
    fechados: 0,
    estagio: 'projetado',
    diasAtras: 5,
    ninhada: { nascidoM: 5, nascidoF: 6, eutanasiadoM: 1, eutanasiadoF: 2 },
    comprometer: null,
    estado: 'R',
  },
  {
    // 2o ciclo, nasceu e nao desmamou: grau PREVISTO. Parte prometida -> P.
    apelido: 'previsto no 2o ciclo, parcialmente comprometido',
    face: 1,
    linha: 2,
    coluna: 1,
    linhagem: 'Wistar',
    grupoMacho: 'B',
    grupoFemea: 'C',
    fechados: 1,
    estagio: 'previsto',
    diasAtras: 60,
    ninhada: { nascidoM: 5, nascidoF: 6, eutanasiadoM: 1, eutanasiadoF: 2 },
    comprometer: { m: 2, f: 0 },
    estado: 'P',
  },
  {
    // 3o ciclo fechado: grau CONFIRMADO e oferta toda prometida -> T.
    apelido: 'confirmado no 3o ciclo, totalmente comprometido',
    face: 1,
    linha: 3,
    coluna: 1,
    linhagem: 'SHR',
    grupoMacho: 'C',
    grupoFemea: 'D',
    fechados: 2,
    estagio: 'confirmado',
    diasAtras: 130,
    ninhada: { nascidoM: 5, nascidoF: 5, eutanasiadoM: 1, eutanasiadoF: 1 },
    comprometer: 'total',
    estado: 'T',
  },
  {
    // 4o ciclo, animais separados e conferidos: preparada para envio -> E.
    apelido: 'confirmado no 4o ciclo, preparado para envio',
    face: 1,
    linha: 4,
    coluna: 1,
    linhagem: 'Kyoto',
    grupoMacho: 'D',
    grupoFemea: 'E',
    fechados: 3,
    estagio: 'confirmado',
    diasAtras: 190,
    ninhada: { nascidoM: 6, nascidoF: 6, eutanasiadoM: 1, eutanasiadoF: 1 },
    comprometer: 'total',
    estado: 'E',
  },
  {
    // 5o parto: `RN-04` no limite. Ja entregue -> X, e sem proximo evento.
    apelido: 'no 5o parto (RN-04), ja expedido',
    face: 1,
    linha: 5,
    coluna: 1,
    linhagem: 'Wistar',
    grupoMacho: 'E',
    grupoFemea: 'A',
    fechados: 4,
    estagio: 'confirmado',
    diasAtras: 250,
    ninhada: { nascidoM: 5, nascidoF: 5, eutanasiadoM: 1, eutanasiadoF: 1 },
    comprometer: 'total',
    estado: 'X',
  },
  {
    // O ALERTA do `RF-REP-07`: previsao de parto ja passou e ninguem confirmou.
    // Sem este caso nao da para ver se o front faz o aviso gritar.
    apelido: 'previsao de parto VENCIDA sem confirmacao',
    face: 1,
    linha: 1,
    coluna: 2,
    linhagem: 'SHR',
    grupoMacho: 'A',
    grupoFemea: 'B',
    fechados: 0,
    estagio: 'vencido',
    diasAtras: 40,
    ninhada: { nascidoM: 5, nascidoF: 6, eutanasiadoM: 1, eutanasiadoF: 2 },
    comprometer: null,
    estado: 'R',
  },
]

async function main() {
  const jaRodou = await prisma.projeto.findUnique({ where: { numero: PROJETO_MARCA } })

  if (jaRodou !== null) {
    console.log('A massa de teste ja esta no banco - nada a fazer.')
    console.log('Para refazer com datas novas, apague os dados de demonstracao antes.')
    await prisma.$disconnect()
    return
  }

  // ---------------------------------------------------------------- catalogo
  const especieRato = await prisma.especie.findUniqueOrThrow({ where: { nome: 'Rato' } })
  const especieCamundongo = await prisma.especie.findUniqueOrThrow({
    where: { nome: 'Camundongo' },
  })

  const linhagens = new Map(
    (
      await prisma.linhagem.findMany({ select: { id: true, nome: true, idEspecie: true } })
    ).map((linhagem) => [linhagem.nome, linhagem]),
  )

  const parametroRato = await prisma.parametroBiologico.findFirstOrThrow({
    where: { idEspecie: especieRato.id, dtVigenciaFim: null },
  })

  const parametros: Parametros = {
    gestacaoDias: parametroRato.gestacaoDias,
    aleitamentoDias: parametroRato.aleitamentoDias,
    intervaloCicloDias: parametroRato.intervaloCicloDias,
    maxPartoCasal: parametroRato.maxPartoCasal,
  }

  const expectativa = { m: parametroRato.expectativaM, f: parametroRato.expectativaF }

  const estanteDensa = await prisma.estante.findFirstOrThrow({ where: { numeroVisivel: 'E-02' } })
  const estanteVazia = await prisma.estante.findFirstOrThrow({ where: { numeroVisivel: 'E-04' } })

  // ---------------------------------------------------------------- usuarios
  //
  // `hashSenha` fica NULO: a coluna e anulavel de proposito (`RF-ACS-01` -
  // quem entra so pelo SSO nao tem senha local), e escolher entre argon2 e
  // bcrypt e do card "Login local com os tres perfis". Quem implementar aquele
  // card grava o hash nestes tres usuarios - senha nunca em claro, nem aqui.
  const usuarios = await Promise.all(
    [
      { nome: 'Beatriz Lima', email: 'pesquisador@ufsc.br', perfil: 'P' },
      { nome: 'Ana Souza', email: 'tecnico@ufsc.br', perfil: 'T' },
      { nome: 'Carlos Mendes', email: 'gestor@ufsc.br', perfil: 'G' },
    ].map((usuario) =>
      prisma.usuario.upsert({
        where: { email: usuario.email },
        update: {},
        create: { ...usuario, hashSenha: null },
      }),
    ),
  )

  const [pesquisador, tecnico, gestor] = usuarios

  if (pesquisador === undefined || tecnico === undefined || gestor === undefined) {
    throw new Error('Os tres usuarios da massa nao foram criados.')
  }

  // ------------------------------------------------------------------- etica
  const projeto = await prisma.projeto.create({
    data: {
      numero: PROJETO_MARCA,
      titulo: 'Avaliacao de modelo experimental de hipertensao',
      idUsuarioResponsavel: pesquisador.id,
      dtVigenciaInicio: dia('2026-01-01'),
      dtVigenciaFim: dia('2026-12-31'),
      cotaAutorizada: 200,
      situacao: 'V',
    },
  })

  const solicitacao = await prisma.solicitacao.create({
    data: {
      idProjeto: projeto.id,
      idUsuarioSolicitante: pesquisador.id,
      idEspecie: especieRato.id,
      idLinhagem: linhagens.get('Wistar')?.id ?? 0,
      qtdM: 12,
      qtdF: 12,
      idadeAlvoDias: 28,
      dtDesejada: dia(somarDias(hoje, 30)),
      regime: 'U',
      status: 'AT',
    },
  })

  const remessa = await prisma.remessa.create({
    data: {
      idSolicitacao: solicitacao.id,
      sequencia: 1,
      dtPrevista: dia(somarDias(hoje, 30)),
      qtdMPrevista: 12,
      qtdFPrevista: 12,
    },
  })

  // ------------------------------------------------------- caixas e reproducao
  let partosCriados = 0
  let compromissosCriados = 0
  const resumo: string[] = []

  for (const papel of elenco) {
    const linhagem = linhagens.get(papel.linhagem)

    if (linhagem === undefined) {
      throw new Error(`Linhagem ${papel.linhagem} nao esta na carga inicial.`)
    }

    const codigo = codigoDaPosicao(papel.face, papel.linha, papel.coluna, estanteDensa.colunas)

    const caixa = await prisma.caixa.create({
      data: {
        idEstante: estanteDensa.id,
        face: papel.face,
        linha: papel.linha,
        coluna: papel.coluna,
        codigo,
        idEspecie: especieRato.id,
        finalidade: 'R',
        // O estado entra depois dos compromissos: e consequencia deles, nao
        // dado solto. Comeca em reproducao.
        estado: 'R',
      },
    })

    const ciclos = planejarCiclos(
      somarDias(hoje, -papel.diasAtras),
      papel.fechados,
      papel.estagio,
      papel.ninhada,
      parametros,
    )

    const casal = await prisma.casal.create({
      data: {
        idCaixa: caixa.id,
        idLinhagem: linhagem.id,
        grupoMacho: papel.grupoMacho,
        grupoFemea: papel.grupoFemea,
        identificacao: `${papel.grupoMacho}${papel.grupoFemea}`,
        dtFormacao: dia(ciclos[0]?.dtAcasalamento ?? hoje),
        // `RN-04`: no 5o parto confirmado o casal encerra.
        ativo: !(papel.fechados + 1 >= parametros.maxPartoCasal && papel.estagio === 'confirmado'),
        ...(papel.fechados + 1 >= parametros.maxPartoCasal && papel.estagio === 'confirmado'
          ? {
              dtEncerramento: dia(ciclos.at(-1)?.dtDesmameReal ?? hoje),
              motivoEncerramento: 'Limite de 5 partos atingido (RN-04)',
            }
          : {}),
      },
    })

    const partos = []

    for (const ciclo of ciclos) {
      partos.push(
        await prisma.parto.create({
          data: {
            idCasal: casal.id,
            ordem: ciclo.ordem,
            dtAcasalamento: dia(ciclo.dtAcasalamento),
            dtPartoPrevisto: dia(ciclo.dtPartoPrevisto),
            dtPartoReal: ciclo.dtPartoReal === null ? null : dia(ciclo.dtPartoReal),
            nascidoM: ciclo.nascidoM,
            nascidoF: ciclo.nascidoF,
            dtSelecao: ciclo.dtSelecao === null ? null : dia(ciclo.dtSelecao),
            eutanasiadoM: ciclo.eutanasiadoM,
            eutanasiadoF: ciclo.eutanasiadoF,
            dtDesmamePrevisto: dia(ciclo.dtDesmamePrevisto),
            dtDesmameReal: ciclo.dtDesmameReal === null ? null : dia(ciclo.dtDesmameReal),
            desmamadoM: ciclo.desmamadoM,
            desmamadoF: ciclo.desmamadoF,
            grauCerteza: ciclo.grauCerteza,
          },
        }),
      )
      partosCriados += 1
    }

    const cicloCorrente = ciclos.at(-1)
    const partoCorrente = partos.at(-1)

    if (papel.comprometer !== null && cicloCorrente !== undefined && partoCorrente !== undefined) {
      const oferta = ofertaBruta(cicloCorrente, expectativa)
      const pedido = papel.comprometer === 'total' ? oferta : papel.comprometer

      // Passa pelo trigger `compromisso_respeita_oferta` do `RN-09`. Se algum
      // dia esta linha estourar, e a massa pedindo mais do que a ninhada tem -
      // e o banco esta certo em recusar.
      await prisma.compromisso.create({
        data: {
          idRemessa: remessa.id,
          idParto: partoCorrente.id,
          idUsuarioCriacao: tecnico.id,
          qtdM: pedido.m,
          qtdF: pedido.f,
          grauCerteza: cicloCorrente.grauCerteza,
        },
      })
      compromissosCriados += 1
    }

    await prisma.caixa.update({ where: { id: caixa.id }, data: { estado: papel.estado } })

    resumo.push(
      `${codigo}\t${papel.estado}\tciclo ${ciclos.length}/${parametros.maxPartoCasal}\t${cicloCorrente?.grauCerteza ?? '-'}\t${papel.apelido}`,
    )
  }

  // ------------------------------------------------- densidade para a grade
  //
  // O resto das posicoes de E-02 leva caixa sem casal, para a grade aparecer
  // povoada e ainda com buracos. Ficam com finalidade de maternidade e recria:
  // gaiola instalada nao esta necessariamente em reproducao.
  const ocupadas = new Set(elenco.map((p) => `${p.face}:${p.linha}:${p.coluna}`))
  let densidade = 0

  for (let face = 1; face <= estanteDensa.faces; face += 1) {
    for (let linha = 1; linha <= estanteDensa.linhas; linha += 1) {
      for (let coluna = 1; coluna <= estanteDensa.colunas; coluna += 1) {
        // Deixa 8 buracos de proposito, espalhados.
        const buraco = (face * 7 + linha * 3 + coluna) % 6 === 0

        if (buraco || ocupadas.has(`${face}:${linha}:${coluna}`)) {
          continue
        }

        await prisma.caixa.create({
          data: {
            idEstante: estanteDensa.id,
            face,
            linha,
            coluna,
            codigo: codigoDaPosicao(face, linha, coluna, estanteDensa.colunas),
            idEspecie: especieRato.id,
            finalidade: coluna % 2 === 0 ? 'M' : 'C',
            estado: 'R',
          },
        })
        densidade += 1
      }
    }
  }

  // A quase vazia: tres caixas de camundongo em 40 posicoes, para a grade
  // esparsa tambem ter caso - e para o filtro por especie ter o que separar.
  for (const [linha, coluna] of [
    [1, 1],
    [2, 3],
    [4, 2],
  ] as const) {
    await prisma.caixa.create({
      data: {
        idEstante: estanteVazia.id,
        face: 1,
        linha,
        coluna,
        codigo: codigoDaPosicao(1, linha, coluna, estanteVazia.colunas),
        idEspecie: especieCamundongo.id,
        finalidade: 'R',
        estado: 'R',
      },
    })
  }

  console.log('Massa de teste aplicada.\n')
  console.log('CODIGO\tESTADO\tCICLO\tGRAU\tCASO')
  for (const linha of resumo) {
    console.log(linha)
  }

  const [qtdCaixa, qtdCasal, qtdParto, qtdCompromisso] = await Promise.all([
    prisma.caixa.count(),
    prisma.casal.count(),
    prisma.parto.count(),
    prisma.compromisso.count(),
  ])

  console.log(
    `\ncaixas=${qtdCaixa} (${densidade + elenco.length} na E-02, 3 na E-04) casais=${qtdCasal} partos=${qtdParto} compromissos=${qtdCompromisso}`,
  )
  console.log(`partos criados nesta rodada=${partosCriados} compromissos=${compromissosCriados}`)

  await prisma.$disconnect()
}

main().catch(async (erro: unknown) => {
  console.error('Massa de teste falhou:', erro)
  await prisma.$disconnect()
  process.exit(1)
})
