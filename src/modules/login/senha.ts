// Hash de senha - escolha do card, registrada aqui (o comentario de
// `prisma/massa-teste.ts` deixa explicito que ninguem decidiu isto antes).
//
// **bcryptjs**, nao argon2: e puro TypeScript, sem binario nativo para
// compilar no build da Render. Para os tres usuarios do semestre a diferenca
// de custo computacional entre os dois nao importa - o que importa e o
// deploy no free tier nao quebrar por falta de toolchain de compilacao.

import bcrypt from 'bcryptjs'
import { env } from '../../env.ts'

// Fator baixo em teste, de proposito: hash com custo real e lento por
// desenho (e o que protege de forca bruta), e isso tornaria a suite lenta
// sem testar nada que o fator alto ja nao cubra - a suite nao verifica
// resistencia a forca bruta, verifica que o par hash/verificacao concorda.
const CUSTO = env.NODE_ENV === 'production' ? 12 : 4

export async function hashSenha(senha: string): Promise<string> {
  return bcrypt.hash(senha, CUSTO)
}

export async function senhaCorresponde(senha: string, hash: string): Promise<boolean> {
  return bcrypt.compare(senha, hash)
}
