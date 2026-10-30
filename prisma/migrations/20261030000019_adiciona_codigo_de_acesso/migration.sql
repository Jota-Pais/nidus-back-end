-- CreateTable
CREATE TABLE "login"."codigo_acesso" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "hash_codigo" VARCHAR(255) NOT NULL,
    "expira_em" TIMESTAMPTZ(6) NOT NULL,
    "tentativas" SMALLINT NOT NULL DEFAULT 0,
    "usado_em" TIMESTAMPTZ(6),
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codigo_acesso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "codigo_acesso_email_dt_criacao_idx" ON "login"."codigo_acesso"("email", "dt_criacao");

-- CreateIndex
CREATE INDEX "codigo_acesso_dt_criacao_idx" ON "login"."codigo_acesso"("dt_criacao");
