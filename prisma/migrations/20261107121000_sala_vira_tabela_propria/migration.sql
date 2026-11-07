-- Sala vira tabela propria. Ate aqui era so o texto infra.estante.sala: sala sem estante
-- nao existia, e renomear era trocar o texto em cada estante. O gestor passa a cadastrar,
-- renomear e remover sala nos Cadastros, e a estante aponta para a sala pela chave.
--
-- Nao apaga nada: cada nome distinto de estante.sala vira uma sala, e cada estante, ativa
-- ou nao, passa a apontar para a sua. A sala nasce ativa quando tem ao menos uma estante
-- ativa, que e quando a grade a mostrava. So depois disso sai a coluna de texto.
--
-- Em producao, em 07/11/2026: 4 estantes ativas, nas salas "Sala 1", "Sala 2" e "Sala 3",
-- e nenhuma caixa. Num banco vazio nada e copiado, e as salas vem da carga inicial
-- (prisma/seed.ts).

-- CreateTable
CREATE TABLE "infra"."sala" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(60) NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "sala_pkey" PRIMARY KEY ("id")
);

INSERT INTO "infra"."sala" ("nome", "ativa")
SELECT "sala", bool_or("ativa")
FROM "infra"."estante"
GROUP BY "sala"
ORDER BY "sala";

ALTER TABLE "infra"."estante" ADD COLUMN "id_sala" INTEGER;

UPDATE "infra"."estante" AS e
SET "id_sala" = s."id"
FROM "infra"."sala" AS s
WHERE s."nome" = e."sala";

ALTER TABLE "infra"."estante" ALTER COLUMN "id_sala" SET NOT NULL;

ALTER TABLE "infra"."estante" DROP COLUMN "sala";

-- AddForeignKey
ALTER TABLE "infra"."estante" ADD CONSTRAINT "estante_id_sala_fkey" FOREIGN KEY ("id_sala") REFERENCES "infra"."sala"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
