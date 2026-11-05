-- Enxuga o banco ate o tamanho do sistema do cliente: sai o que sobrou do plano antigo
-- e que nenhum codigo le nem grava.
--
-- Conferido em producao em 05/11/2026, antes de escrever esta migration:
--   - parto.id_caixa_recria: 0 linhas preenchidas;
--   - caixa.finalidade: 35 caixas com 'M' ou 'C', todas da massa de demonstracao de
--     10/09. Ninguem le a coluna desde fa67514 (29/10);
--   - parto.grau_certeza: valores gravados pelo codigo ate 814302a (29/10). Desde la o
--     grau e calculado na hora e a coluna ficou parada, com valor velho;
--   - parametro_biologico (2 linhas) e tolerancia_idade (8 linhas): o codigo usa as
--     constantes de src/shared/parametros.ts;
--   - schemas motor, expedicao e insumo: nenhuma tabela.
--
-- O que NAO sai: compromisso.grau_certeza, que e gravado na alocacao como foto do
-- momento, e tudo que as telas usam.

-- ---------------------------------------------------------------------------
-- 1. RN-09 sem a tabela de parametro
--
-- O trigger lia a expectativa do parto que ainda nao nasceu em parametro_biologico.
-- Passa a usar 4 e 4, o ESPERADOS_POR_CASAL de src/shared/parametros.ts, o mesmo
-- numero que a busca e o estoque ja usam. Antes eram duas fontes para o mesmo numero,
-- e editar a tabela fazia o banco e o codigo discordarem.
--
-- Tem de vir antes do DROP TABLE: o plpgsql so resolve a tabela quando o trigger roda,
-- e o primeiro compromisso depois do drop falharia.
--
-- A regra e a mesma: a soma dos compromissos ativos do parto nao passa da oferta.
-- Sem a tabela, a oferta nunca e nula, e sai o erro de "parametro nao cadastrado".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "demanda"."compromisso_respeita_oferta"()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_oferta_m    integer;
  v_oferta_f    integer;
  v_reservado_m integer;
  v_reservado_f integer;
BEGIN
  -- Serializa quem mira a mesma ninhada. A segunda transacao espera aqui e so
  -- recalcula depois do commit da primeira, ja vendo a reserva dela.
  PERFORM 1 FROM "reproducao"."parto" WHERE "id" = NEW."id_parto" FOR UPDATE;

  -- desmamou -> confirmado | nasceu -> previsto | nem nasceu -> 4 e 4 esperados
  SELECT COALESCE(p."desmamado_m", p."nascido_m" - COALESCE(p."eutanasiado_m", 0), 4),
         COALESCE(p."desmamado_f", p."nascido_f" - COALESCE(p."eutanasiado_f", 0), 4)
    INTO v_oferta_m, v_oferta_f
    FROM "reproducao"."parto" p
   WHERE p."id" = NEW."id_parto";

  SELECT COALESCE(SUM(c."qtd_m"), 0), COALESCE(SUM(c."qtd_f"), 0)
    INTO v_reservado_m, v_reservado_f
    FROM "demanda"."compromisso" c
   WHERE c."id_parto" = NEW."id_parto"
     AND c."dt_cancelamento" IS NULL;

  IF v_reservado_m > v_oferta_m THEN
    RAISE EXCEPTION
      'RN-09: o parto % oferta % machos e ja teria % comprometidos',
      NEW."id_parto", v_oferta_m, v_reservado_m
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_reservado_f > v_oferta_f THEN
    RAISE EXCEPTION
      'RN-09: o parto % oferta % femeas e ja teria % comprometidas',
      NEW."id_parto", v_oferta_f, v_reservado_f
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Colunas e tabelas sem uso
--
-- Saida de `prisma migrate diff` do schema.prisma anterior para o novo. Os CHECKs de
-- dominio de caixa.finalidade e parto.grau_certeza caem junto com a coluna.
-- ---------------------------------------------------------------------------

-- DropForeignKey
ALTER TABLE "catalogo"."parametro_biologico" DROP CONSTRAINT "parametro_biologico_id_especie_fkey";

-- DropForeignKey
ALTER TABLE "catalogo"."parametro_biologico" DROP CONSTRAINT "parametro_biologico_id_linhagem_fkey";

-- DropForeignKey
ALTER TABLE "reproducao"."parto" DROP CONSTRAINT "parto_id_caixa_recria_fkey";

-- DropIndex
DROP INDEX "reproducao"."parto_grau_certeza_dt_desmame_previsto_idx";

-- AlterTable
ALTER TABLE "infra"."caixa" DROP COLUMN "finalidade";

-- AlterTable
ALTER TABLE "catalogo"."especie" DROP COLUMN "nome_cientifico";

-- AlterTable
ALTER TABLE "reproducao"."parto" DROP COLUMN "grau_certeza",
DROP COLUMN "id_caixa_recria";

-- DropTable
DROP TABLE "catalogo"."parametro_biologico";

-- DropTable
DROP TABLE "catalogo"."tolerancia_idade";

-- ---------------------------------------------------------------------------
-- 3. Schemas que o plano antigo criou vazios "para o futuro"
--
-- RESTRICT: se alguem tiver posto uma tabela neles, a migration para aqui em vez de
-- apagar a tabela junto.
-- ---------------------------------------------------------------------------
DROP SCHEMA IF EXISTS "motor" RESTRICT;
DROP SCHEMA IF EXISTS "expedicao" RESTRICT;
DROP SCHEMA IF EXISTS "insumo" RESTRICT;
