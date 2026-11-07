-- A caixa de estoque. Depois do desmame, os filhotes saem da caixa do casal para caixas de
-- estoque, cada uma com um sexo e uma linhagem, sem limite de animais. Qualquer posicao vazia
-- vira caixa de casal ou de estoque, e a caixa do casal encerrado pode virar de estoque no lugar.
--
-- infra.lote guarda quantos desmamados de cada parto estao em cada caixa de estoque. A reserva
-- continua no parto (demanda.compromisso): o lote so diz onde os animais estao.
--
-- A caixa de casal passa a alternar so Livres e Pre-reserva. A que estava em Estoque, Reserva ou
-- Enviado volta para Pre-reserva se ainda tem reserva a entregar, senao para Livres.

-- Saida de `prisma migrate diff` do schema.prisma anterior para o novo

-- AlterTable
ALTER TABLE "infra"."caixa" ADD COLUMN     "sexo" CHAR(1),
ADD COLUMN     "tipo" CHAR(1) NOT NULL DEFAULT 'C';

-- CreateTable
CREATE TABLE "infra"."lote" (
    "id" SERIAL NOT NULL,
    "id_caixa" INTEGER NOT NULL,
    "id_parto" INTEGER NOT NULL,
    "qtd" SMALLINT NOT NULL,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "lote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lote_id_parto_idx" ON "infra"."lote"("id_parto");

-- CreateIndex
CREATE UNIQUE INDEX "lote_id_caixa_id_parto_key" ON "infra"."lote"("id_caixa", "id_parto");

-- AddForeignKey
ALTER TABLE "infra"."lote" ADD CONSTRAINT "lote_id_caixa_fkey" FOREIGN KEY ("id_caixa") REFERENCES "infra"."caixa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "infra"."lote" ADD CONSTRAINT "lote_id_parto_fkey" FOREIGN KEY ("id_parto") REFERENCES "reproducao"."parto"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Escrito a mao: o Prisma nao gera CHECK

ALTER TABLE "infra"."caixa"
  ADD CONSTRAINT "caixa_tipo_dominio" CHECK ("tipo" IN ('C', 'E')),
  -- so a caixa de estoque tem sexo, e ela sempre tem
  ADD CONSTRAINT "caixa_sexo_do_estoque" CHECK (
    ("tipo" = 'C' AND "sexo" IS NULL) OR ("tipo" = 'E' AND "sexo" IN ('M', 'F'))
  );

ALTER TABLE "infra"."lote"
  ADD CONSTRAINT "lote_qtd_nao_negativa" CHECK ("qtd" >= 0);

-- A caixa de casal que estava em Estoque, Reserva ou Enviado
UPDATE "infra"."caixa" AS c
SET "estado" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "demanda"."compromisso" AS m
    JOIN "demanda"."remessa" AS r ON r."id" = m."id_remessa"
    JOIN "reproducao"."parto" AS p ON p."id" = m."id_parto"
    JOIN "reproducao"."casal" AS k ON k."id" = p."id_casal"
    WHERE k."id_caixa" = c."id"
      AND m."dt_cancelamento" IS NULL
      AND r."dt_realizada" IS NULL
  ) THEN 'P'
  ELSE 'R'
END
WHERE c."tipo" = 'C' AND c."estado" IN ('E', 'T', 'X');
