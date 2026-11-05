import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsuarioDaSessao } from '../../shared/middlewares/autorizacao.ts'
import { avisarPedidoDecidido } from '../../shared/email.ts'
import { alocarSolicitacao, criarSolicitacao } from './demanda.service.ts'

vi.mock('../../shared/email.ts', () => ({ avisarPedidoDecidido: vi.fn().mockResolvedValue(undefined) }))

const banco = vi.hoisted(() => ({
  linhagem: null as Record<string, unknown> | null,
  partos: [] as Record<string, unknown>[],
  aprovadas: 1,
}))

vi.mock('../../shared/prisma.ts', () => ({
  prisma: {
    projeto: {
      findUnique: async () => ({
        id: 1,
        numero: 'CEUA-1',
        situacao: 'V',
        idUsuarioResponsavel: 2,
        dtVigenciaFim: new Date('2027-12-31T00:00:00.000Z'),
      }),
    },
    linhagem: { findUnique: async () => banco.linhagem },
    solicitacao: {
      findUnique: async () => ({
        id: 7,
        status: 'EN',
        idEspecie: 1,
        idLinhagem: 3,
        qtdM: 2,
        qtdF: 2,
        qtdQualquer: 0,
        idadeMinDias: 28,
        idadeMaxDias: 28,
        dtDesejada: new Date('2026-12-01T00:00:00.000Z'),
        projeto: { numero: '23080.000001/2026-54' },
        linhagem: { nome: 'Wistar' },
        usuarioSolicitante: { email: 'paula@ufsc.br' },
        remessas: [{ id: 1 }],
      }),
    },
    parto: { findMany: async () => banco.partos },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        solicitacao: { updateMany: async () => ({ count: banco.aprovadas }) },
        compromisso: { create: async () => ({}) },
        caixa: { updateMany: async () => ({ count: 0 }) },
        historico: { create: async () => ({}) },
      }),
  },
}))

const tecnica: UsuarioDaSessao = { id: 2, nome: 'Ana', email: 'tecnico@ufsc.br', perfil: 'tecnico' }
const agora = new Date('2026-10-30T15:00:00.000Z')
const pedido = {
  nomePesquisador: 'Ana',
  protocoloCeua: 'CEUA-1',
  idLinhagem: 3,
  machos: 2,
  femeas: 2,
  qualquer: 0,
  idadeMin: 28,
  idadeMax: 28,
  dataEntrega: '2026-11-20',
  cronograma: 'unica',
  observacoes: null,
}

const parto = (idLinhagem: number, caixa = { ativa: true, estado: 'R' }) => ({
  id: 10,
  ordem: 2,
  nascidoM: 5,
  nascidoF: 5,
  eutanasiadoM: 1,
  eutanasiadoF: 1,
  desmamadoM: null,
  desmamadoF: null,
  dtPartoReal: new Date('2026-10-01T00:00:00.000Z'),
  dtDesmameReal: null,
  compromissos: [],
  casal: { idCaixa: 4, idLinhagem, ativo: true, caixa, linhagem: { idEspecie: 1 } },
})

const recusa = (status: number, codigo: string) => expect.objectContaining({ status, codigo })

beforeEach(() => {
  vi.clearAllMocks()
  banco.linhagem = { id: 3, idEspecie: 1, ativa: true }
  banco.partos = [parto(3)]
  banco.aprovadas = 1
})

describe('nova solicitacao', () => {
  it('data de entrega no passado e recusada', async () => {
    await expect(
      criarSolicitacao({ ...pedido, dataEntrega: '2026-10-29' }, tecnica, agora),
    ).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('linhagem inativa e recusada', async () => {
    banco.linhagem = { id: 3, idEspecie: 1, ativa: false }

    await expect(criarSolicitacao(pedido, tecnica, agora)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })
})

describe('alocacao', () => {
  it('nao passa da quantidade pedida, nem somando itens repetidos', async () => {
    const itens = [
      { idParto: 10, machos: 2, femeas: 0 },
      { idParto: 10, machos: 1, femeas: 0 },
    ]

    await expect(alocarSolicitacao(7, itens, tecnica)).rejects.toEqual(recusa(400, 'VALIDACAO'))
  })

  it('parto de outra linhagem e recusado', async () => {
    banco.partos = [parto(9)]

    await expect(
      alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica),
    ).rejects.toEqual(recusa(409, 'DISPONIBILIDADE_EXCEDIDA'))
  })

  it('caixa ja enviada e recusada', async () => {
    banco.partos = [parto(3, { ativa: true, estado: 'X' })]

    await expect(
      alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica),
    ).rejects.toEqual(recusa(409, 'DISPONIBILIDADE_EXCEDIDA'))
  })

  it('parto que nao nasceu de casal encerrado e recusado', async () => {
    const naoNasceu = { ...parto(3), nascidoM: null, nascidoF: null, dtPartoReal: null }
    banco.partos = [{ ...naoNasceu, casal: { ...naoNasceu.casal, ativo: false } }]

    await expect(
      alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica),
    ).rejects.toEqual(recusa(409, 'DISPONIBILIDADE_EXCEDIDA'))
  })

  it('dois cliques ao mesmo tempo: o segundo nao grava', async () => {
    banco.aprovadas = 0

    await expect(
      alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica),
    ).rejects.toEqual(recusa(409, 'SOLICITACAO_JA_ALOCADA'))
  })

  it('pedido certo e alocado', async () => {
    await expect(
      alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica),
    ).resolves.toEqual({ idSolicitacao: 7, status: 'aprovada' })
  })

  it('avisa quem pediu, sem motivo, depois de gravar', async () => {
    await alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica)

    expect(avisarPedidoDecidido).toHaveBeenCalledWith(
      'paula@ufsc.br',
      {
        protocoloCeua: '23080.000001/2026-54',
        linhagem: 'Wistar',
        machos: 2,
        femeas: 2,
        qualquer: 0,
        idadeMin: 28,
        idadeMax: 28,
        dataEntrega: '2026-12-01',
      },
      undefined,
    )
  })

  it('nao avisa quando a alocacao nao grava', async () => {
    banco.aprovadas = 0

    await expect(
      alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica),
    ).rejects.toBeDefined()
    expect(avisarPedidoDecidido).not.toHaveBeenCalled()
  })

  it('o envio que falha nao derruba a alocacao', async () => {
    vi.mocked(avisarPedidoDecidido).mockRejectedValueOnce(new Error('Brevo fora do ar'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      alocarSolicitacao(7, [{ idParto: 10, machos: 1, femeas: 1 }], tecnica),
    ).resolves.toEqual({ idSolicitacao: 7, status: 'aprovada' })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    log.mockRestore()
  })
})
