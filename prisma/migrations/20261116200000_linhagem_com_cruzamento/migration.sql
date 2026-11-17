-- Cada linhagem diz como se cruzam as familias A-E: rodizio (heterogenica) ou mesma letra
-- (isogenica). Serve so para o aviso no casal; nulo e sem regra, sem aviso.
ALTER TABLE "catalogo"."linhagem" ADD COLUMN "cruzamento" VARCHAR(12);

ALTER TABLE "catalogo"."linhagem"
  ADD CONSTRAINT "linhagem_cruzamento_dominio" CHECK ("cruzamento" IN ('rodizio', 'mesma_letra'));

-- As cinco linhagens de hoje, como o CPMR descreveu em 16/11/2026: Wistar e Swiss heterogenicas,
-- as demais isogenicas. Daqui em diante o gestor muda nos Cadastros.
UPDATE "catalogo"."linhagem" SET "cruzamento" = 'rodizio' WHERE "nome" IN ('Wistar', 'Swiss');
UPDATE "catalogo"."linhagem" SET "cruzamento" = 'mesma_letra' WHERE "nome" IN ('SHR', 'Kyoto', 'C57BL/6J');
