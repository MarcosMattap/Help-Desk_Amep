# Help Desk - Sistema de Chamados (Node.js)

Sistema de chamados interno com foco em operação multiunidade, controle por perfil e visão gerencial em tempo real.

## Visão Geral

O **Help Desk** é uma aplicação web para abertura, acompanhamento e gestão de chamados técnicos.  
Foi desenvolvido para cenários com múltiplas unidades (ex.: AMEP e Operadora), com separação de escopo por operadora, relatórios administrativos e controle de SLA.

## Principais Funcionalidades

- Abertura e acompanhamento de chamados.
- Comentários por chamado.
- Gestão de status com fluxo operacional:
  - `aberto`
  - `em_andamento`
  - `pausa`
  - `aguardando_usuario`
  - `resolvido`
  - `fechado`
- Controle de SLA com pausa:
  - ao entrar em `pausa`, o SLA para de contar
  - ao sair de `pausa`, o tempo volta a contar
- Painel administrativo completo:
  - gestão de usuários
  - gestão de setores
  - gestão de categorias
  - atribuição rápida de responsável e status
- Modo multioperadora:
  - separação de dados por operadora
  - visão específica para admin de operadora
- Relatórios:
  - chamados por status
  - chamados por prioridade
  - tendência mensal
  - tempo médio de resolução
  - chamados por setor
  - dias de atendimento por setor
- Console SQL administrativo (restrito), com escopo AMEP/Operadora.

## Tecnologias

- Node.js
- Express
- SQLite (`sqlite3`)
- EJS
- Bootstrap 5
- `express-session`
- `csurf`
- `bcryptjs`

## Estrutura do Projeto

```txt
src/
  server.js
  db.js
  constants/
  middlewares/
views/
public/
scripts/
package.json
README.md

