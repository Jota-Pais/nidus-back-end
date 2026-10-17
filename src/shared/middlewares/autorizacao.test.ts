import { describe, expect, it, vi } from 'vitest'
import { ErroDeAplicacao } from '../erros.ts'
import type { Perfil } from '../traducao.ts'
import { OPERA_A_COLONIA, exigirPerfil, usuarioDaRequisicao } from './autorizacao.ts'

// A decisao de autorizacao. Testada aqui, no middleware e nao pela
// rota: nao envolve HTTP, banco nem Express de verdade e e a regra que toda rota reusa

const requisicao = (perfil?: Perfil) => ({
  usuario:
    perfil === undefined
      ? undefined
      : { id: 1, nome: 'Teste', email: 'teste@ufsc.br', perfil },
})

/** roda o middleware e devolve o erro que ele passou ao next, se houve. */
function rodar(middleware: ReturnType<typeof exigirPerfil>, perfil?: Perfil) {
  const next = vi.fn()

  // O middleware so le req.usuario e chama next - o cast mantem o teste sem
  // montar um Request inteiro do Express
  middleware(requisicao(perfil) as never, undefined as never, next)

  const [primeiro] = next.mock.calls[0] ?? []

  return {
    passou: next.mock.calls.length === 1 && primeiro === undefined,
    erro: primeiro instanceof ErroDeAplicacao ? primeiro : undefined,
  }
}

describe('exigirPerfil', () => {
  it('sem sessao recusa com 401, antes de olhar o perfil exigido', () => {
    const { passou, erro } = rodar(exigirPerfil('gestor'))

    expect(passou).toBe(false)
    expect(erro?.status).toBe(401)
    expect(erro?.codigo).toBe('NAO_AUTENTICADO')
  })

  it('com sessao e perfil fora da lista recusa com 403 e cita o requisito', () => {
    const { erro } = rodar(exigirPerfil('gestor'), 'tecnico')

    expect(erro?.status).toBe(403)
    expect(erro?.codigo).toBe('SEM_PERMISSAO')
    expect(erro?.extras.requisito).toBe('RF-ACS-02')
  })

  it('deixa passar o perfil que esta na lista', () => {
    expect(rodar(exigirPerfil('tecnico', 'gestor'), 'gestor').passou).toBe(true)
    expect(rodar(exigirPerfil('tecnico', 'gestor'), 'tecnico').passou).toBe(true)
  })

  it('sem lista de perfis exige apenas sessao - e o caso do catalogo', () => {
    // 'GET /api/catalogo' vale para qualquer perfil: o pesquisador tambem
    // precisa de especie e linhagem para montar o pedido.
    expect(rodar(exigirPerfil(), 'pesquisador').passou).toBe(true)
    expect(rodar(exigirPerfil(), 'tecnico').passou).toBe(true)
    expect(rodar(exigirPerfil()).erro?.status).toBe(401)
  })

  it('OPERA_A_COLONIA deixa o pesquisador fora, por desenho', () => {
    // Ele nao enxerga a colonia - recebe menos dados, nao os mesmos dados filtrados
    // no cliente
    expect(OPERA_A_COLONIA).toEqual(['tecnico', 'gestor'])
    expect(rodar(exigirPerfil(...OPERA_A_COLONIA), 'pesquisador').erro?.status).toBe(403)
  })
})

describe('usuarioDaRequisicao', () => {
  it('devolve o usuario da requisicao ja autorizada', () => {
    expect(usuarioDaRequisicao(requisicao('gestor')).perfil).toBe('gestor')
  })

  it('estoura quando a rota esqueceu o exigirPerfil - e bug, nao regra', () => {
    // Cai como 500 no log do servidor, que e onde bug nosso deve aparecer, e nao
    // como 401 silencioso que pareceria problema do usuario.
    expect(() => usuarioDaRequisicao(requisicao())).toThrow(/sem exigirPerfil/)
  })
})
