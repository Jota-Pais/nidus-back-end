# Nidus — back-end

API e regras de negócio do **Nidus**, sistema de gestão de produção e manutenção
de roedores do **CPMR/UFSC** (Centro de Produção e Manutenção de Roedores da
Universidade Federal de Santa Catarina).

Projeto Integrador: Sistema Web — SATC, Engenharia de Software, fase 4, 2026.2.

## O que este repositório abriga

Toda a regra de negócio e a persistência. O front-end não decide nada disso.

- **Timeline reversa** — uma solicitação de animais com idade *X* dias para
  entrega em *T* só é aceita se `T ≥ hoje + 23 (gestação) + 22 (aleitamento) + X`
- **Motor de varredura** — encontra as caixas elegíveis por faixa etária, com a
  tolerância definida por faixa, e ordena do mais velho para o mais novo
- **Cruzamento rotacional** — grupos genéticos A–E, apenas os pares AB, BC, CD,
  DE e EA
- **Vida útil do casal** — aposentadoria no 5º parto
- **Kanban de reprodução** — máquina de estados LIVRES → PRÉ-RESERVA → RESERVA →
  AGRUPADAS PARA ENVIO → ENVIADO
- **RBAC** — perfis gestor, técnico e pesquisador

Login ID-UFSC e integração com a CEUA entram como **mock**: dependem do
SETIC/UFSC.

## Stack

A definir pela equipe — é a entrega de 27/08/2026.

## Repositório irmão

Front-end: https://github.com/Jota-Pais/nidus-front-end

## Equipe

| Integrante | Papel |
|---|---|
| Arthur Serafim Santin | Líder, Scrum Master e QA |
| João Carlos País | Banco de dados |
| Miguel Guerra | Back-end |
| Gabriel Ugione | Front-end e UX/UI |
