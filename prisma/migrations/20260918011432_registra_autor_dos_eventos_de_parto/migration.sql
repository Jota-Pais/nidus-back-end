-- AlterTable
ALTER TABLE "reproducao"."parto" ADD COLUMN     "dt_registro_desmame" TIMESTAMPTZ(6),
ADD COLUMN     "dt_registro_parto" TIMESTAMPTZ(6),
ADD COLUMN     "dt_registro_selecao" TIMESTAMPTZ(6),
ADD COLUMN     "id_usuario_desmame" INTEGER,
ADD COLUMN     "id_usuario_parto" INTEGER,
ADD COLUMN     "id_usuario_selecao" INTEGER;

-- AddForeignKey
ALTER TABLE "reproducao"."parto" ADD CONSTRAINT "parto_id_usuario_parto_fkey" FOREIGN KEY ("id_usuario_parto") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reproducao"."parto" ADD CONSTRAINT "parto_id_usuario_selecao_fkey" FOREIGN KEY ("id_usuario_selecao") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reproducao"."parto" ADD CONSTRAINT "parto_id_usuario_desmame_fkey" FOREIGN KEY ("id_usuario_desmame") REFERENCES "login"."usuario"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
