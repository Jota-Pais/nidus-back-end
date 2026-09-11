-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "catalogo";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "demanda";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "etica";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "infra";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "login";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "reproducao";

-- CreateTable
CREATE TABLE "infra"."estante" (
    "id" SERIAL NOT NULL,
    "sala" VARCHAR(60) NOT NULL,
    "fabricante" VARCHAR(60) NOT NULL,
    "modelo" VARCHAR(60) NOT NULL,
    "numero_visivel" VARCHAR(30) NOT NULL,
    "faces" SMALLINT NOT NULL,
    "linhas" SMALLINT NOT NULL,
    "colunas" SMALLINT NOT NULL,
    "capacidade" SMALLINT NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "estante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infra"."caixa" (
    "id" SERIAL NOT NULL,
    "id_estante" INTEGER NOT NULL,
    "face" SMALLINT NOT NULL,
    "linha" SMALLINT NOT NULL,
    "coluna" SMALLINT NOT NULL,
    "codigo" VARCHAR(20) NOT NULL,
    "id_especie" INTEGER NOT NULL,
    "finalidade" CHAR(1) NOT NULL DEFAULT 'R',
    "estado" CHAR(1) NOT NULL DEFAULT 'R',
    "ativa" BOOLEAN NOT NULL DEFAULT true,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "caixa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogo"."especie" (
    "id" SERIAL NOT NULL,
    "nome" VARCHAR(40) NOT NULL,
    "nome_cientifico" VARCHAR(80) NOT NULL,

    CONSTRAINT "especie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogo"."linhagem" (
    "id" SERIAL NOT NULL,
    "id_especie" INTEGER NOT NULL,
    "nome" VARCHAR(60) NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "linhagem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogo"."parametro_biologico" (
    "id" SERIAL NOT NULL,
    "id_especie" INTEGER NOT NULL,
    "id_linhagem" INTEGER,
    "gestacao_dias" SMALLINT NOT NULL DEFAULT 23,
    "aleitamento_dias" SMALLINT NOT NULL DEFAULT 22,
    "intervalo_ciclo_dias" SMALLINT NOT NULL DEFAULT 6,
    "max_parto_casal" SMALLINT NOT NULL DEFAULT 5,
    "expectativa_m" SMALLINT NOT NULL DEFAULT 4,
    "expectativa_f" SMALLINT NOT NULL DEFAULT 4,
    "dt_vigencia_inicio" DATE NOT NULL,
    "dt_vigencia_fim" DATE,

    CONSTRAINT "parametro_biologico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogo"."tolerancia_idade" (
    "id" SERIAL NOT NULL,
    "idade_min_dias" SMALLINT NOT NULL,
    "idade_max_dias" SMALLINT,
    "variacao_dias" SMALLINT NOT NULL,
    "dt_vigencia_inicio" DATE NOT NULL,
    "dt_vigencia_fim" DATE,

    CONSTRAINT "tolerancia_idade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogo"."grupo_genetico_par" (
    "id" SERIAL NOT NULL,
    "grupo_macho" CHAR(1) NOT NULL,
    "grupo_femea" CHAR(1) NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "grupo_genetico_par_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reproducao"."casal" (
    "id" SERIAL NOT NULL,
    "id_caixa" INTEGER NOT NULL,
    "id_linhagem" INTEGER NOT NULL,
    "grupo_macho" CHAR(1) NOT NULL,
    "grupo_femea" CHAR(1) NOT NULL,
    "identificacao" CHAR(2) NOT NULL,
    "dt_formacao" DATE NOT NULL,
    "dt_encerramento" DATE,
    "motivo_encerramento" VARCHAR(200),
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "casal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reproducao"."parto" (
    "id" SERIAL NOT NULL,
    "id_casal" INTEGER NOT NULL,
    "ordem" SMALLINT NOT NULL,
    "dt_acasalamento" DATE NOT NULL,
    "dt_parto_previsto" DATE NOT NULL,
    "dt_parto_real" DATE,
    "nascido_m" SMALLINT,
    "nascido_f" SMALLINT,
    "eutanasiado_m" SMALLINT,
    "eutanasiado_f" SMALLINT,
    "dt_selecao" DATE,
    "dt_desmame_previsto" DATE NOT NULL,
    "dt_desmame_real" DATE,
    "desmamado_m" SMALLINT,
    "desmamado_f" SMALLINT,
    "id_caixa_recria" INTEGER,
    "grau_certeza" CHAR(1) NOT NULL DEFAULT 'J',
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "parto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login"."usuario" (
    "id" SERIAL NOT NULL,
    "id_institucional" VARCHAR(60),
    "nome" VARCHAR(120) NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "perfil" CHAR(1) NOT NULL,
    "hash_senha" VARCHAR(255),
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "etica"."projeto" (
    "id" SERIAL NOT NULL,
    "numero" VARCHAR(30) NOT NULL,
    "titulo" VARCHAR(255) NOT NULL,
    "id_usuario_responsavel" INTEGER NOT NULL,
    "dt_vigencia_inicio" DATE NOT NULL,
    "dt_vigencia_fim" DATE NOT NULL,
    "cota_autorizada" INTEGER NOT NULL,
    "situacao" CHAR(1) NOT NULL DEFAULT 'V',
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "projeto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demanda"."solicitacao" (
    "id" SERIAL NOT NULL,
    "id_projeto" INTEGER NOT NULL,
    "id_usuario_solicitante" INTEGER NOT NULL,
    "id_especie" INTEGER NOT NULL,
    "id_linhagem" INTEGER NOT NULL,
    "qtd_m" SMALLINT NOT NULL,
    "qtd_f" SMALLINT NOT NULL,
    "idade_alvo_dias" SMALLINT NOT NULL,
    "dt_desejada" DATE NOT NULL,
    "regime" CHAR(1) NOT NULL DEFAULT 'U',
    "status" CHAR(2) NOT NULL DEFAULT 'RA',
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_manutencao" TIMESTAMPTZ(6),

    CONSTRAINT "solicitacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demanda"."remessa" (
    "id" SERIAL NOT NULL,
    "id_solicitacao" INTEGER NOT NULL,
    "sequencia" SMALLINT NOT NULL,
    "dt_prevista" DATE NOT NULL,
    "dt_realizada" DATE,
    "qtd_m_prevista" SMALLINT NOT NULL,
    "qtd_f_prevista" SMALLINT NOT NULL,
    "status" CHAR(1) NOT NULL DEFAULT 'P',

    CONSTRAINT "remessa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demanda"."compromisso" (
    "id" SERIAL NOT NULL,
    "id_remessa" INTEGER NOT NULL,
    "id_parto" INTEGER NOT NULL,
    "id_usuario_criacao" INTEGER NOT NULL,
    "qtd_m" SMALLINT NOT NULL,
    "qtd_f" SMALLINT NOT NULL,
    "grau_certeza" CHAR(1) NOT NULL,
    "dt_criacao" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dt_cancelamento" TIMESTAMPTZ(6),
    "motivo_cancelamento" VARCHAR(200),

    CONSTRAINT "compromisso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "caixa_id_estante_face_idx" ON "infra"."caixa"("id_estante", "face");

-- CreateIndex
CREATE INDEX "caixa_estado_id_especie_idx" ON "infra"."caixa"("estado", "id_especie");

-- CreateIndex
CREATE UNIQUE INDEX "especie_nome_key" ON "catalogo"."especie"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "linhagem_id_especie_id_key" ON "catalogo"."linhagem"("id_especie", "id");

-- CreateIndex
CREATE UNIQUE INDEX "linhagem_id_especie_nome_key" ON "catalogo"."linhagem"("id_especie", "nome");

-- CreateIndex
CREATE INDEX "parametro_biologico_id_especie_dt_vigencia_fim_idx" ON "catalogo"."parametro_biologico"("id_especie", "dt_vigencia_fim");

-- CreateIndex
CREATE UNIQUE INDEX "grupo_genetico_par_grupo_macho_grupo_femea_key" ON "catalogo"."grupo_genetico_par"("grupo_macho", "grupo_femea");

-- CreateIndex
CREATE INDEX "casal_id_caixa_ativo_idx" ON "reproducao"."casal"("id_caixa", "ativo");

-- CreateIndex
CREATE INDEX "parto_grau_certeza_dt_desmame_previsto_idx" ON "reproducao"."parto"("grau_certeza", "dt_desmame_previsto");

-- CreateIndex
CREATE UNIQUE INDEX "parto_id_casal_ordem_key" ON "reproducao"."parto"("id_casal", "ordem");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_id_institucional_key" ON "login"."usuario"("id_institucional");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_email_key" ON "login"."usuario"("email");

-- CreateIndex
CREATE UNIQUE INDEX "projeto_numero_key" ON "etica"."projeto"("numero");

-- CreateIndex
CREATE INDEX "solicitacao_status_dt_desejada_idx" ON "demanda"."solicitacao"("status", "dt_desejada");

-- CreateIndex
CREATE UNIQUE INDEX "remessa_id_solicitacao_sequencia_key" ON "demanda"."remessa"("id_solicitacao", "sequencia");

-- CreateIndex
CREATE INDEX "compromisso_id_parto_dt_cancelamento_idx" ON "demanda"."compromisso"("id_parto", "dt_cancelamento");

-- AddForeignKey
ALTER TABLE "infra"."caixa" ADD CONSTRAINT "caixa_id_estante_fkey" FOREIGN KEY ("id_estante") REFERENCES "infra"."estante"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "infra"."caixa" ADD CONSTRAINT "caixa_id_especie_fkey" FOREIGN KEY ("id_especie") REFERENCES "catalogo"."especie"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "catalogo"."linhagem" ADD CONSTRAINT "linhagem_id_especie_fkey" FOREIGN KEY ("id_especie") REFERENCES "catalogo"."especie"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "catalogo"."parametro_biologico" ADD CONSTRAINT "parametro_biologico_id_especie_fkey" FOREIGN KEY ("id_especie") REFERENCES "catalogo"."especie"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "catalogo"."parametro_biologico" ADD CONSTRAINT "parametro_biologico_id_linhagem_fkey" FOREIGN KEY ("id_linhagem") REFERENCES "catalogo"."linhagem"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reproducao"."casal" ADD CONSTRAINT "casal_id_caixa_fkey" FOREIGN KEY ("id_caixa") REFERENCES "infra"."caixa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reproducao"."casal" ADD CONSTRAINT "casal_id_linhagem_fkey" FOREIGN KEY ("id_linhagem") REFERENCES "catalogo"."linhagem"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reproducao"."parto" ADD CONSTRAINT "parto_id_casal_fkey" FOREIGN KEY ("id_casal") REFERENCES "reproducao"."casal"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reproducao"."parto" ADD CONSTRAINT "parto_id_caixa_recria_fkey" FOREIGN KEY ("id_caixa_recria") REFERENCES "infra"."caixa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "etica"."projeto" ADD CONSTRAINT "projeto_id_usuario_responsavel_fkey" FOREIGN KEY ("id_usuario_responsavel") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."solicitacao" ADD CONSTRAINT "solicitacao_id_projeto_fkey" FOREIGN KEY ("id_projeto") REFERENCES "etica"."projeto"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."solicitacao" ADD CONSTRAINT "solicitacao_id_usuario_solicitante_fkey" FOREIGN KEY ("id_usuario_solicitante") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."solicitacao" ADD CONSTRAINT "solicitacao_id_especie_fkey" FOREIGN KEY ("id_especie") REFERENCES "catalogo"."especie"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."solicitacao" ADD CONSTRAINT "solicitacao_id_linhagem_fkey" FOREIGN KEY ("id_linhagem") REFERENCES "catalogo"."linhagem"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."remessa" ADD CONSTRAINT "remessa_id_solicitacao_fkey" FOREIGN KEY ("id_solicitacao") REFERENCES "demanda"."solicitacao"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."compromisso" ADD CONSTRAINT "compromisso_id_remessa_fkey" FOREIGN KEY ("id_remessa") REFERENCES "demanda"."remessa"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."compromisso" ADD CONSTRAINT "compromisso_id_parto_fkey" FOREIGN KEY ("id_parto") REFERENCES "reproducao"."parto"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "demanda"."compromisso" ADD CONSTRAINT "compromisso_id_usuario_criacao_fkey" FOREIGN KEY ("id_usuario_criacao") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
