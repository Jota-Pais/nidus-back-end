-- O casal deixa de ser preso a rotacao em anel (AB, BC, CD, DE, EA). Nas linhagens isogenicas
-- (SHR, Kyoto, C57BL/6J) o cruzamento e entre a mesma letra (AA, BB...), e so as heterogenicas
-- (Wistar, Swiss) seguem o rodizio. O sistema nao restringe o par: qualquer combinacao de A-E
-- forma casal, e caso diferente nao exige mudanca de codigo.
--
-- Saem a FK composta casal(grupo_macho, grupo_femea) -> grupo_genetico_par e a propria tabela.
-- Ficam os CHECKs casal_grupo_macho_dominio, casal_grupo_femea_dominio (A-E) e
-- casal_identificacao_derivada (identificacao = grupo_macho || grupo_femea).
--
-- A base do DDL e o `prisma migrate diff` do schema.prisma.

-- DropForeignKey
ALTER TABLE "reproducao"."casal" DROP CONSTRAINT "casal_grupo_macho_grupo_femea_fkey";

-- DropTable
DROP TABLE "catalogo"."grupo_genetico_par";
