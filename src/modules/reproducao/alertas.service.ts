// Secao 8 do contrato: `GET /api/alertas` - `RF-REP-07`.
//
// "E a tela em que o tecnico comeca o dia": o que vence hoje e nos proximos
// dias, mais tudo que ja venceu sem confirmacao - por isso a janela filtra so
// o teto de cima (`data <= hoje + dias`), nunca o de baixo. Um atraso de 30
// dias tem que continuar aparecendo, nao sumir por estar "fora da janela".
//
// Reaproveita `calcularProximoEvento` (`infra/proximoEvento.ts`), a mesma
// funcao que a grade e o quadro chamam - e o que garante que "atrasado" aqui
// e o mesmo "atrasado" das outras duas telas (`RF-CIC-02`).

import { calcularProximoEvento } from '../infra/proximoEvento.ts'
import { idDaEspecie } from '../infra/infra.service.ts'
import { prisma } from '../../shared/prisma.ts'
import { dataISO, hojeISO } from '../../shared/traducao.ts'
import { parametroNaData } from './disponibilidade.ts'
import type { ParametroVigente } from './disponibilidade.ts'

type ParametroCompleto = ParametroVigente & {
  intervaloCicloDias: number
  maxPartoCasal: number
}

async function parametrosDeAmbasEspecies(): Promise<Map<number, ParametroCompleto[]>> {
  const parametros = await prisma.parametroBiologico.findMany()
  const porEspecie = new Map<number, ParametroCompleto[]>()

  for (const parametro of parametros) {
    const lista = porEspecie.get(parametro.idEspecie) ?? []

    lista.push({
      ...parametro,
      dtVigenciaInicio: dataISO(parametro.dtVigenciaInicio),
      dtVigenciaFim: parametro.dtVigenciaFim === null ? null : dataISO(parametro.dtVigenciaFim),
    })
    porEspecie.set(parametro.idEspecie, lista)
  }

  return porEspecie
}

interface ItemDoAlerta {
  idCaixa: number
  codigo: string
  numeroVisivel: string
  sala: string
  linhagem: string
  casal: { identificacao: string; cicloAtual: number; maxCiclos: number }
}

export type Filtro = { codigoEspecie?: string; dias?: number }

export async function montarAlertas({ codigoEspecie, dias = 7 }: Filtro = {}) {
  const idEspecie = codigoEspecie === undefined ? undefined : await idDaEspecie(codigoEspecie)
  const hoje = hojeISO()
  const ateQuando = new Date(`${hoje}T00:00:00.000Z`)
  ateQuando.setUTCDate(ateQuando.getUTCDate() + dias)
  const limite = ateQuando.toISOString().slice(0, 10)

  const [casais, parametrosPorEspecie] = await Promise.all([
    prisma.casal.findMany({
      where: {
        ativo: true,
        ...(idEspecie === undefined ? {} : { caixa: { idEspecie } }),
      },
      select: {
        identificacao: true,
        idLinhagem: true,
        linhagem: { select: { nome: true, idEspecie: true } },
        caixa: {
          select: { id: true, codigo: true, estante: { select: { numeroVisivel: true, sala: true } } },
        },
        partos: {
          orderBy: { ordem: 'desc' },
          take: 1,
          select: {
            ordem: true,
            dtPartoPrevisto: true,
            dtPartoReal: true,
            dtDesmamePrevisto: true,
            dtDesmameReal: true,
          },
        },
      },
    }),
    parametrosDeAmbasEspecies(),
  ])

  const partosPrevistos: (ItemDoAlerta & { data: string; atrasado: boolean })[] = []
  const desmamesPrevistos: (ItemDoAlerta & { data: string; atrasado: boolean })[] = []
  const reacasalamentosLiberados: (ItemDoAlerta & { data: string; atrasado: boolean })[] = []
  const casaisNoUltimoCiclo: ItemDoAlerta[] = []

  for (const casal of casais) {
    const ciclo = casal.partos[0]

    if (ciclo === undefined) {
      continue
    }

    const parametro = parametroNaData(parametrosPorEspecie.get(casal.linhagem.idEspecie) ?? [], {
      idLinhagem: casal.idLinhagem,
      em: hoje,
    })

    const item: ItemDoAlerta = {
      idCaixa: casal.caixa.id,
      codigo: casal.caixa.codigo,
      numeroVisivel: casal.caixa.estante.numeroVisivel,
      sala: casal.caixa.estante.sala,
      linhagem: casal.linhagem.nome,
      casal: {
        identificacao: casal.identificacao.trim(),
        cicloAtual: ciclo.ordem,
        maxCiclos: parametro?.maxPartoCasal ?? 5,
      },
    }

    if (ciclo.ordem >= (parametro?.maxPartoCasal ?? 5)) {
      casaisNoUltimoCiclo.push(item)
    }

    const proximoEvento = calcularProximoEvento(
      {
        ordem: ciclo.ordem,
        dtPartoPrevisto: dataISO(ciclo.dtPartoPrevisto),
        dtPartoReal: ciclo.dtPartoReal === null ? null : dataISO(ciclo.dtPartoReal),
        dtDesmamePrevisto: dataISO(ciclo.dtDesmamePrevisto),
        dtDesmameReal: ciclo.dtDesmameReal === null ? null : dataISO(ciclo.dtDesmameReal),
      },
      {
        maxCiclos: parametro?.maxPartoCasal ?? 5,
        intervaloCicloDias: parametro?.intervaloCicloDias ?? 6,
        hoje,
      },
    )

    if (proximoEvento === null || proximoEvento.data > limite) {
      continue
    }

    const comData = { ...item, data: proximoEvento.data, atrasado: proximoEvento.atrasado }

    if (proximoEvento.tipo === 'parto_previsto') {
      partosPrevistos.push(comData)
    } else if (proximoEvento.tipo === 'desmame_previsto') {
      desmamesPrevistos.push(comData)
    } else {
      reacasalamentosLiberados.push(comData)
    }
  }

  const porData = <T extends { data: string }>(a: T, b: T) => a.data.localeCompare(b.data)

  return {
    partosPrevistos: partosPrevistos.sort(porData),
    desmamesPrevistos: desmamesPrevistos.sort(porData),
    reacasalamentosLiberados: reacasalamentosLiberados.sort(porData),
    casaisNoUltimoCiclo: casaisNoUltimoCiclo.sort((a, b) => a.codigo.localeCompare(b.codigo)),
  }
}
