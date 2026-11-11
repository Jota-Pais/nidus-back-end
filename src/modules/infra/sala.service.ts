// Salas: lista, cadastro, renomeacao e remocao. Remover e 'ativa = false', e so sai a sala
// sem estante ativa: a estante removida continua apontando para ela

import { agora } from '../../shared/relogio.ts'
import { erroDeRegra, naoEncontrado } from '../../shared/erros.ts'
import { prisma } from '../../shared/prisma.ts'
import { registrarHistorico } from '../historico/historico.service.ts'

const estantesAtivas = { estantes: { where: { ativa: true } } } as const

/** GET /api/salas - as salas ativas, cada uma com quantas estantes ativas tem */
export async function listarSalas() {
  const salas = await prisma.sala.findMany({
    where: { ativa: true },
    orderBy: { nome: 'asc' },
    select: { id: true, nome: true, _count: { select: estantesAtivas } },
  })

  return {
    salas: salas.map((sala) => ({ id: sala.id, nome: sala.nome, estantes: sala._count.estantes })),
  }
}

async function salaAtiva(id: number) {
  const sala = await prisma.sala.findFirst({ where: { id, ativa: true } })

  if (sala === null) {
    throw naoEncontrado('Sala')
  }

  return sala
}

/** O nome e unico entre as salas ativas, sem diferenciar maiuscula: "sala 1" e a Sala 1 */
async function conferirNomeLivre(nome: string, idSala?: number) {
  const mesmoNome = await prisma.sala.findFirst({
    where: {
      ativa: true,
      nome: { equals: nome, mode: 'insensitive' },
      ...(idSala === undefined ? {} : { id: { not: idSala } }),
    },
  })

  if (mesmoNome !== null) {
    throw erroDeRegra('SALA_DUPLICADA', `Já existe uma sala com o nome ${nome}.`)
  }
}

/** POST /api/salas */
export async function criarSala(dados: { nome: string }, idUsuario: number) {
  await conferirNomeLivre(dados.nome)

  const criada = await prisma.$transaction(async (tx) => {
    const sala = await tx.sala.create({ data: { nome: dados.nome } })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'sala',
      idEntidade: sala.id,
      acao: 'cadastro',
      descricao: `${dados.nome} cadastrada`,
      dados: { nome: dados.nome },
    })

    return sala
  })

  return { id: criada.id, nome: criada.nome }
}

/** PATCH /api/salas/:id - renomear. As estantes acompanham, porque apontam para a sala */
export async function renomearSala(id: number, dados: { nome: string }, idUsuario: number) {
  const sala = await salaAtiva(id)

  await conferirNomeLivre(dados.nome, id)

  const salva = await prisma.$transaction(async (tx) => {
    const atualizada = await tx.sala.update({
      where: { id },
      data: { nome: dados.nome, dtManutencao: agora() },
    })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'sala',
      idEntidade: id,
      acao: 'alteracao',
      descricao: `${sala.nome} renomeada para ${dados.nome}`,
      dados: { antes: { nome: sala.nome }, depois: { nome: dados.nome } },
    })

    return atualizada
  })

  return { id: salva.id, nome: salva.nome }
}

/** DELETE /api/salas/:id - so a sala sem estante ativa */
export async function removerSala(id: number, idUsuario: number) {
  const sala = await salaAtiva(id)
  const estantes = await prisma.estante.count({ where: { idSala: id, ativa: true } })

  if (estantes > 0) {
    throw erroDeRegra(
      'SALA_COM_ESTANTE',
      `${sala.nome} ainda tem ${estantes} ${estantes === 1 ? 'estante' : 'estantes'}. Só dá para remover a sala sem estante: remova as estantes ou mude-as de sala antes.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.sala.update({ where: { id }, data: { ativa: false, dtManutencao: agora() } })

    await registrarHistorico(tx, {
      idUsuario,
      entidade: 'sala',
      idEntidade: id,
      acao: 'remocao',
      descricao: `${sala.nome} removida`,
      dados: { nome: sala.nome },
    })
  })
}
