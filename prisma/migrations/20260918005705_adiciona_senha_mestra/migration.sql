-- CreateTable
CREATE TABLE "login"."senha_mestra" (
    "id" SERIAL NOT NULL,
    "hash_senha" VARCHAR(255) NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "senha_mestra_pkey" PRIMARY KEY ("id")
);
