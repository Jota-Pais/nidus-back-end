# Nidus - back-end

API e regras de negócio do Nidus, um sistema de controle de produção de roedores. O
cliente do projeto é o CPMR/UFSC (Centro de Produção e Manutenção de Roedores da
Universidade Federal de Santa Catarina).

Projeto Integrador: Sistema Web - SATC, Engenharia de Software, fase 4, 2026.2.
Repositório irmão: [nidus-front-end](https://github.com/Jota-Pais/nidus-front-end).

## Escopo

O Nidus é o equivalente, na nossa stack, do sistema que o próprio cliente montou
(`Malcoringa/Sistema-CPMR-UFSC`, branch `master`). A referência de requisitos é
a spec dele, o `instructions.md` v2.7, de 18/09/2026. Se o sistema do cliente não
tem, a gente não faz.

O que mora aqui:

- **Kanban** - um quadro por espécie, cinco colunas (`livres`, `pre_reserva`,
  `estoque`, `reserva`, `enviado`). Mover uma caixa que tem animais comprometidos
  só passa com confirmação
- **Estantes** - a grade das duas faces, com a posição vazia como `caixa: null`.
  O endereço segue a etiqueta do cliente: face, linha e letra (`F1A`, `T2K`)
- **Ficha da caixa** - casal (cruzamento AB, BC, CD, DE, EA), do 1º ao 5º parto,
  com parto, eutanásia de seleção e desmame. As datas previstas saem sozinhas:
  parto = acasalamento + 23 dias, desmame = parto + 22, próximo acasalamento =
  parto real + 6
- **Solicitações** - o pedido do pesquisador, sempre num projeto CEUA vigente
- **Busca de atendimento** - dado um pedido, quais caixas atendem: primeiro o que
  já desmamou, depois o que já nasceu, por último o parto previsto, sempre pela
  idade mais próxima. O que faltar vira casais novos a formar
- **Alocação** - cada caixa aceita vira compromisso, e a soma dos compromissos de
  um parto nunca passa do que ele tem

Os parâmetros biológicos (gestação, aleitamento, intervalo, máximo de 5 partos,
4 machos e 4 fêmeas esperados por casal, tolerância de idade) são constantes em
`src/shared/parametros.ts`, como no `settings.py` do sistema do cliente. O seed
grava os mesmos valores nas tabelas `parametro_biologico` e `tolerancia_idade`:
o trigger que confere a oferta de cada parto ainda lê a expectativa da primeira.
Os pares genéticos ficam no banco.

## Começar

```bash
npm install
cp .env.example .env     # preencha DATABASE_URL e DATABASE_URL_UNPOOLED com as strings da Neon
npm run db:generate      # gera o Prisma Client
npm run dev              # http://localhost:3333/saude
```

O banco é um só, na Neon, o mesmo de produção. Desenvolver precisa de internet,
e o que você grava rodando local aparece para o cliente.

| Script | O que faz |
|---|---|
| `npm run dev` | API com recarga automática (`tsx watch`) |
| `npm test` | Vitest. Nenhum teste abre conexão com o banco |
| `npm run typecheck` | `tsc` sem emitir |
| `npm run build` | Gera o Prisma Client e compila para `dist/` |
| `npm start` | Roda o build, é o comando da Render |
| `npm run db:deploy` | Aplica migrations pendentes. Nunca dropa nada |
| `npm run db:seed` | Carga inicial: espécies, linhagens, parâmetros, pares genéticos e estantes (não duplica nada) |
| `npm run db:usuarios` | Cria os três usuários e o projeto CEUA num banco novo (o que já existe fica como está) |
| `npm run db:senha -- <email> "<senha>"` | Define a senha de um usuário. É a reserva para quando o e-mail do primeiro acesso não chega, ou trava por código errado demais |

## Stack

Node 24 e TypeScript em ESM, Express 5, PostgreSQL na Neon, Prisma 7, Zod 4 na
entrada de cada rota, Vitest + supertest. Deploy na Render.

`prisma` e `@prisma/client` estão pregados na mesma versão exata, sem `^`. Suba os
dois juntos ou nenhum.

## Estrutura

```
prisma/schema.prisma   o banco: models e migrations
src/
  app.ts               monta o Express (é o que o teste usa)
  server.ts            sobe a porta e encerra limpo no SIGTERM
  shared/              prisma, erros, tradução dos códigos do banco, autorização,
                       parâmetros biológicos, envio de e-mail
  modules/
    infra/             estantes, grade, kanban e ficha
    reproducao/        casais e partos
    demanda/           projetos CEUA, solicitações e alocação
    motor/             busca de atendimento
    catalogo/          espécies, linhagens e pares genéticos
    login/             sessão, primeiro acesso e senha esquecida
```

Validação é `parse` do Zod direto na rota: `ZodError` vira `400 VALIDACAO`.
Regra de negócio violada sai como 409 pelo `erroDeRegra` de `shared/erros.ts`, no
envelope `{ "erro": { "codigo", "mensagem" } }`. O `char(1)` do banco nunca cruza
a rede: o banco guarda `R`, a API responde `livres` (`shared/traducao.ts`).

Mudança de schema passa pelo responsável pelo banco. `prisma migrate dev` pode
recriar o schema quando o histórico diverge, e o banco é o de produção.

## Login e primeiro acesso

| Rota | O que faz |
|---|---|
| `POST /api/sessao` | Login com `{ email, senha }`. Abre a sessão no cookie `nidus_sessao`, que dura 12 h |
| `GET /api/sessao` | Quem está logado |
| `DELETE /api/sessao` | Logout. A sessão some da memória |
| `POST /api/acesso/codigo` | `{ email }`: manda um código de 6 números para o e-mail da UFSC. Vale 15 minutos e responde `{ validadeEmMinutos }` |
| `POST /api/acesso/verificacao` | `{ email, codigo }`: confere o código sem gastar e responde `{ novo }`, `true` quando o e-mail ainda não tem conta |
| `POST /api/acesso/senha` | `{ email, codigo, senha, nome? }`: gasta o código, grava a senha e abre a sessão como o login. Sem conta, cria um pesquisador, e o `nome` passa a ser obrigatório |

O ID-UFSC entra depois dos testes práticos. Até lá, quem não tem senha, ou
esqueceu, pede o código pela tela `/definir-senha` do front.

- O login compara o e-mail em minúsculas e sem espaço nas pontas, que é como o
  primeiro acesso grava. Quem tiver e-mail com maiúscula em `login.usuario` deixa
  de entrar.
- As rotas de `/api/acesso` ficam fora do login e nunca respondem 401: o front lê
  qualquer 401 como senha errada. Código errado, vencido, já usado ou de conta
  inativa dá `409 CODIGO_INVALIDO`, e cada código aceita 5 tentativas. Pedido de
  código demais dá `429 MUITAS_TENTATIVAS`: 1 por minuto e 5 por hora por e-mail,
  e um teto total por hora e por dia, abaixo da cota do serviço de e-mail. Os
  números ficam em `LIMITES_DE_PEDIDO`, no `acesso.service.ts`.
- Cada e-mail aguenta 20 códigos errados em 24 h, somando todos os códigos dele
  (`TETO_DE_ERROS_POR_EMAIL`). Passado o teto, o pedido de código dá `429
  MUITAS_TENTATIVAS` sem enviar nem gravar código, e a verificação e a senha dão
  `409 CODIGO_INVALIDO`, mesmo com o código certo, até a janela andar. Vale igual
  com conta, sem conta e com conta inativa. Quem ficar travado recebe a senha pelo
  `db:senha`.
- O pedido de código responde igual com conta, sem conta e com conta inativa, e
  as rotas de `/api/acesso` só dizem se a conta existe depois do código certo.
  Conta inativa nunca recebe código, nunca troca a senha e nunca abre sessão.
- O primeiro acesso só cria pesquisador. Quem já tem conta troca só a senha:
  perfil e nome ficam.
- Quando a senha de uma conta que já existia muda, todas as sessões abertas dela,
  em qualquer aparelho, deixam de valer, e só então abre a sessão nova. O
  `db:senha` roda fora da API e não derruba sessão nenhuma.
- O código fica em `login.codigo_acesso`, só como hash. Linha nenhuma se apaga:
  os limites contam por elas.

**E-mail.** O envio usa a API HTTP de envio transacional da Brevo, pelo `fetch`
do Node, em `src/shared/email.ts`. Em production ele precisa de duas variáveis, e
o boot cai sem elas:

- `BREVO_API_KEY`: a chave de API, criada no painel da Brevo;
- `EMAIL_REMETENTE`: o endereço que aparece como remetente, validado na conta da
  Brevo.

Em development e test, nenhum e-mail sai: o código aparece no console do
servidor (`npm run dev`), e as duas variáveis podem ficar vazias. Nenhum teste
chama a Brevo.

O envio não segura a resposta. Se a Brevo recusar ou não responder em 10 s, o
erro vai para o log do servidor, sem o código e sem a chave, e a tela segue
dizendo que o código foi enviado. O plano grátis da Brevo manda 300 e-mails por
dia.

Antes do merge no `main`, as duas variáveis entram no painel da Render. O
`render.yaml` as declara, mas num serviço que já existe a Render não pede o valor.
Sem elas, o build aplica a migration e o serviço novo não sobe: a Render mantém o
deploy anterior, e todo push seguinte falha.

**Contas de exemplo.** Os três usuários do `db:usuarios` têm e-mails de exemplo
(`gestor@ufsc.br`, `tecnico@ufsc.br` e `pesquisador@ufsc.br`), de caixas que a
equipe não controla. Com o envio ligado, quem tiver uma dessas caixas na UFSC
recebe o código, define a senha da conta e entra com o perfil dela, gestor
inclusive. O primeiro acesso só serve a conta com o e-mail real da pessoa: antes
de ligar o envio, as contas de exemplo que estiverem no banco passam para o
e-mail real ou ficam inativas. Conta de exemplo recebe senha pelo `db:senha`.

## Deploy na Render

Web Service no plano free, a partir do GitHub, descrito no `render.yaml`. Push em
`main` publica sozinho.

| Campo | Valor |
|---|---|
| Serviço | `nidus-cpmr-api` → https://nidus-cpmr-api.onrender.com (é a URL do `vercel.json` do front) |
| Região | Ohio, a mesma da Neon |
| Build | `npm ci --include=dev && npm run build && npm run db:deploy` |
| Start | `npm start` |
| Health check | `/saude` |
| Variáveis | `NODE_ENV=production`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CORS_ORIGEM`, `BREVO_API_KEY`, `EMAIL_REMETENTE` |

- `--include=dev` é obrigatório: sem ele faltam os `@types/*` e o `tsc` para.
- O free tier dorme depois de uns 15 minutos parado e leva até um minuto para
  acordar. Abra o sistema antes de qualquer apresentação.
- A sessão vive em memória: quando a instância reinicia, todo mundo loga de novo.

## Equipe

| Integrante | Papel |
|---|---|
| Arthur Serafim Santin | Líder, Scrum Master e QA |
| João Carlos País | Banco de dados |
| Miguel Guerra | Back-end |
| Gabriel Ugione | Front-end e UX/UI |
