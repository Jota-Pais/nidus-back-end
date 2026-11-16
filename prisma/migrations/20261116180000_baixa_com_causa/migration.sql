-- A causa da baixa vira dado: a ocorrencia de baixa grava se foi morte ou eutanasia numa coluna
-- propria, e a ficha e a visao geral separam a eutanasia de ajuste de ninhada da morte durante o
-- aleitamento sem ler texto. Ate aqui a causa so estava no texto do motivo.
--
-- O motivo continua: e o texto que a trilha mostra, e quem acha a selecao e a baixa do desmame de um
-- parto le por ele ('eutanasia de selecao', 'nao chegou ao desmame'). A coluna nova nao o substitui.
--
-- As baixas que ja existem tiram a causa do motivo: 'eutanasia de selecao' e 'eutanásia' (e todo
-- motivo escrito que fala em eutanasia) sao eutanasia; 'morte', 'nao chegou ao desmame' e o resto
-- sao morte.
--
-- Uma migration so, sem BEGIN/COMMIT: o Prisma manda o arquivo inteiro de uma vez e o Postgres roda
-- tudo numa transacao implicita. A base do DDL e o `prisma migrate diff` do schema.prisma.

-- AlterTable
ALTER TABLE "colonia"."ocorrencia" ADD COLUMN "causa" VARCHAR(10);

UPDATE "colonia"."ocorrencia"
   SET "causa" = CASE WHEN "motivo" ILIKE '%eutan%' THEN 'eutanasia' ELSE 'morte' END
 WHERE "tipo" = 'baixa';

-- So a baixa tem causa, e toda baixa tem
ALTER TABLE "colonia"."ocorrencia"
  ADD CONSTRAINT "ocorrencia_causa_dominio" CHECK ("causa" IN ('morte', 'eutanasia')),
  ADD CONSTRAINT "ocorrencia_baixa_tem_causa" CHECK (("tipo" = 'baixa') = ("causa" IS NOT NULL));
