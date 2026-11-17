// Formas de entrada que mais de um modulo valida igual

import { z } from 'zod'
import { hojeISO } from './traducao.ts'

/** O id numerico de ':id' na URL. Texto ou numero fora do int4 viram 400, nunca 500 */
export const idNaRota = z.object({ id: z.coerce.number().int().positive().max(2147483647) })

/** Um id que vem no corpo */
export const idNoCorpo = z.number().int().positive().max(2147483647)

/**
 * A data de algo que ja aconteceu na colonia (acasalamento, parto, desmame, baixa,
 * encerramento): 'aaaa-mm-dd', nunca timestamp, e no maximo hoje em Brasilia. Previsao nao
 * entra por aqui, sai da cadeia temporal
 */
export const dataDoFato = z.iso
  .date('Data inválida. Use aaaa-mm-dd.')
  .refine((data) => data >= '2000-01-01', 'Use um ano a partir de 2000.')
  .refine((data) => data <= hojeISO(), 'A data não pode ser depois de hoje.')

/**
 * O motivo de uma correcao ou anulacao, que fica na trilha quando escrito. Corrigir nao pede motivo:
 * o historico ja guarda o antes, o depois e quem fez. Em branco e o mesmo que sem
 */
export const motivoDaCorrecao = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((motivo) => (motivo === '' ? undefined : motivo))
