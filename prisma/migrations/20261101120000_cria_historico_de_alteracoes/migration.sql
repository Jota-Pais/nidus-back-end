-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auditoria";

-- CreateTable
CREATE TABLE "auditoria"."historico" (
    "id" SERIAL NOT NULL,
    "id_usuario" INTEGER NOT NULL,
    "dt_hora" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entidade" VARCHAR(20) NOT NULL,
    "id_entidade" INTEGER NOT NULL,
    "acao" VARCHAR(40) NOT NULL,
    "descricao" VARCHAR(300) NOT NULL,
    "dados" JSONB,

    CONSTRAINT "historico_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historico_entidade_id_entidade_idx" ON "auditoria"."historico"("entidade", "id_entidade");

-- CreateIndex
CREATE INDEX "historico_dt_hora_idx" ON "auditoria"."historico"("dt_hora");

-- AddForeignKey
ALTER TABLE "auditoria"."historico" ADD CONSTRAINT "historico_id_usuario_fkey" FOREIGN KEY ("id_usuario") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

