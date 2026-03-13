# Help Desk AMEP — Sistema de Chamados

Sistema completo de gerenciamento de chamados técnicos (help desk) com multi-tenancy por operadoras, controle de SLA, painel administrativo, relatórios analíticos e log de auditoria.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![Express](https://img.shields.io/badge/Express-4.x-black?logo=express)
![SQLite](https://img.shields.io/badge/SQLite-3-blue?logo=sqlite)
![Bootstrap](https://img.shields.io/badge/Bootstrap-5-purple?logo=bootstrap)
![Licença](https://img.shields.io/badge/Licença-MIT-yellow)

---

## Sumário

- [Visão Geral](#visão-geral)
- [Funcionalidades](#funcionalidades)
- [Estrutura de Usuários e Multi-tenancy](#estrutura-de-usuários-e-multi-tenancy)
- [Fluxo de Status dos Chamados](#fluxo-de-status-dos-chamados)
- [SLA — Acordo de Nível de Serviço](#sla--acordo-de-nível-de-serviço)
- [Painel Administrativo](#painel-administrativo)
- [Relatórios](#relatórios)
- [Segurança](#segurança)
- [Tecnologias](#tecnologias)
- [Estrutura do Projeto](#estrutura-do-projeto)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Variáveis de Ambiente](#variáveis-de-ambiente)
- [Deploy em Produção (VPS)](#deploy-em-produção-vps)
- [Banco de Dados e Migrações](#banco-de-dados-e-migrações)

---

## Visão Geral

O **Help Desk AMEP** é uma aplicação web desenvolvida em Node.js para gerenciamento centralizado de chamados de suporte técnico. Ele isola por operadora cada empresa/unidade, permitindo que múltiplas operadoras coexistam no mesmo sistema com dados completamente separados, sob supervisão de um administrador master.

---

## Funcionalidades

### Chamados
- Abertura de chamados com **título**, **descrição**, **setor** e **categoria**
- Prioridade automática definida pela categoria ou escolhida manualmente (`baixa`, `média`, `alta`, `crítica`)
- Visualização de histórico completo do chamado com comentários em ordem cronológica
- Comentários por usuários e técnicos diretamente no chamado
- Listagem inteligente: chamados **abertos** aparecem primeiro, ordenados pelo prazo SLA mais próximo

### SLA (Acordo de Nível de Serviço)
- Prazo padrão de **48 horas** por chamado
- **Contador em tempo real** exibido na interface
- **Pausa automática do SLA** ao mudar status para `pausa` ou `aguardando_usuario`
- **Retomada automática** ao voltar para `em_andamento` ou `aberto`
- Cálculo correto do tempo líquido descontando períodos de pausa

### Autenticação e Sessão
- Login por **e-mail e senha** com hash bcrypt (salt rounds = 10)
- Sessão segura com `express-session` (cookie `httpOnly`, `sameSite: lax`, `secure` em produção)
- Sessão expira automaticamente após **8 horas** de inatividade
- Proteção CSRF em todos os formulários via token

### Perfis de Usuário
| Perfil | Descrição |
|---|---|
| `admin` master | Acesso total: gerencia empresas, operadoras, usuários, setores, categorias e todos os chamados |
| `admin` operadora | Gerencia chamados, usuários e configurações da própria operadora |
| `agent` | Atende e atualiza status dos chamados da sua operadora |
| `user` | Abre e acompanha apenas os próprios chamados |

---

## Estrutura de Usuários e Multi-tenancy

O sistema possui três níveis hierárquicos:

```
Empresa (ex: Grupo AMEP)
  └── Operadora (ex: AMEP, Operadora)
        └── Usuários (admin, agent, user)
```

- Cada **operadora** tem seus próprios chamados, setores, categorias e usuários
- Registros com `operadora_id IS NULL` são **globais** e visíveis para todas as operadoras
- O **admin master** (sem `operadora_id`) enxerga e gerencia tudo
- Admins e agentes com `operadora_id` só veem dados da própria operadora (isolamento automático)

---

## Fluxo de Status dos Chamados

```
aberto
  └──► em_andamento
         ├──► aguardando_usuario  (SLA pausado)
         ├──► pausa               (SLA pausado)
         └──► resolvido
                └──► fechado
```

| Status | Descrição |
|---|---|
| `aberto` | Chamado recém-criado, sem técnico atribuído |
| `em_andamento` | Técnico atribuído e trabalhando |
| `aguardando_usuario` | Aguardando resposta/ação do solicitante (SLA **pausado**) |
| `pausa` | Pausa administrativa (SLA **pausado**) |
| `resolvido` | Solução aplicada, aguardando confirmação |
| `fechado` | Chamado encerrado definitivamente |

---

## SLA — Acordo de Nível de Serviço

- Prazo: **48 horas** a partir da abertura
- O SLA é exibido em tempo real com indicador visual (verde → amarelo → vermelho)
- Nos status `pausa` e `aguardando_usuario`, o tempo é **congelado**
- Ao retornar para `em_andamento`, o contador retoma de onde parou
- O campo `sla_paused_seconds` acumula o total de segundos pausados

---

## Painel Administrativo

### Admin Master (`/admin`)
- **Gestão de Usuários**: criar, editar e excluir usuários com papel e operadora
- **Gestão de Empresas**: cadastro de empresas (ex: Grupo AMEP)
- **Gestão de Operadoras**: vincular operadoras às empresas
- **Setores (Departments)**: criar e gerenciar setores globais
- **Categorias**: criar categorias com prioridade padrão automática
- **Todos os chamados**: atribuição de técnicos e atualização de status
- **Log de auditoria**: histórico das últimas 50 ações administrativas
- **Console de banco** (exclusivo para o admin master Marcos Pereira): execução direta de SQL com suporte a leitura e escrita

### Admin de Operadora (`/operadora`)
- Visão restrita à própria operadora
- Gerencia chamados, usuários e configurações da operadora
- Acesso a relatórios da operadora

---

## Relatórios

Disponível para admin master (`/admin/relatorios`) e admin de operadora (`/operadora/relatorios`):

| Indicador | Descrição |
|---|---|
| Total de chamados | Quantidade total no escopo |
| Distribuição por status | Gráfico de chamados por status |
| Distribuição por prioridade | Gráfico de chamados por nível de prioridade |
| Tempo médio de resolução | Média em horas (descontando pausas de SLA) |
| Chamados por mês | Histórico dos últimos 6 meses |
| Top categorias | 5 categorias com mais chamados |
| Top agentes | 8 agentes com mais atendimentos |
| Chamados por setor | Volume por departamento |
| Dia da semana mais movimentado | Dia com maior abertura de chamados |

---

## Segurança

- **CSRF**: todos os formulários POST são protegidos com token CSRF (`csurf`)
- **Senhas**: armazenadas com `bcryptjs` (hash + salt)
- **Controle de acesso**: middleware `requireRole` valida perfil em cada rota
- **Isolamento de dados (IDOR prevention)**: usuários só acessam seus próprios chamados; admins de operadora são impedidos de acessar dados de outras operadoras
- **SESSION_SECRET obrigatório** em produção (erro fatal se ausente)
- **Cookies seguros** em produção: `httpOnly`, `secure`, `sameSite: lax`
- **Validação de entrada**: todos os IDs, status e prioridades são validados antes de queries SQL
- **Log de auditoria** para todas as ações administrativas sensíveis

---

## Tecnologias

| Camada | Tecnologia |
|---|---|
| Backend | Node.js 18+ / Express 4 |
| Banco de dados | SQLite 3 (`sqlite3`) |
| Template engine | EJS |
| Frontend | Bootstrap 5 + CSS customizado |
| Autenticação | `express-session` + `bcryptjs` |
| Segurança | `csurf` (CSRF tokens) |
| Deploy | PM2 + VPS Linux |

---

## Estrutura do Projeto

```
Help-Desk/
├── src/
│   ├── server.js              # Servidor Express — todas as rotas e lógica de negócio
│   ├── db.js                  # Conexão com SQLite, migrações e seed inicial
│   ├── constants/
│   │   └── tickets.js         # Constantes de status e prioridade dos chamados
│   └── middlewares/
│       └── auth.js            # Middlewares de autenticação e controle de acesso
├── views/                     # Templates EJS
│   ├── layout.ejs             # Layout base (navbar, head)
│   ├── login.ejs              # Tela de login
│   ├── tickets-list.ejs       # Listagem de chamados
│   ├── ticket-new.ejs         # Abertura de novo chamado
│   ├── ticket-detail.ejs      # Detalhes e comentários do chamado
│   ├── admin.ejs              # Painel do admin master
│   ├── admin-relatorios.ejs   # Relatórios analíticos
│   └── account.ejs            # Minha conta (alterar senha)
├── public/
│   ├── css/styles.css         # Estilos customizados
│   └── img/                   # Imagens e ícones
├── scripts/
│   ├── deploy-vps.sh          # Script de envio para VPS
│   └── apply-release.sh       # Script de aplicação na VPS (PM2 restart)
├── package.json
└── .gitignore
```

---

## Requisitos

- Node.js >= 18
- npm >= 9

---

## Instalação

```bash
git clone https://github.com/MarcosMattap/Help-Desk_Amep.git
cd Help-Desk_Amep
npm install
npm start
```

Acesse: [http://localhost:3000](http://localhost:3000)

> Na primeira execução, se `ADMIN_PASSWORD` não estiver definido, uma **senha aleatória forte** é gerada e exibida no log do terminal. Anote e altere imediatamente em **Minha Conta**.

---

## Variáveis de Ambiente

Crie um arquivo `.env` (não versionado) ou defina as variáveis no ambiente do servidor:

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor HTTP |
| `SESSION_SECRET` | **(obrigatório em prod)** | Segredo da sessão Express — use uma string longa e aleatória |
| `ADMIN_EMAIL` | `admin@empresa.com` | E-mail do administrador criado no primeiro boot |
| `ADMIN_PASSWORD` | *(gerado aleatório)* | Senha do administrador inicial (mín. 12 caracteres) |
| `NODE_ENV` | `development` | Use `production` em ambiente de produção |

**Exemplo (Linux/bash):**
```bash
export SESSION_SECRET="troque-por-um-segredo-forte-aqui"
export ADMIN_EMAIL="admin@suaempresa.com"
export ADMIN_PASSWORD="SenhaForte123!"
export NODE_ENV=production
npm start
```

**Exemplo (PowerShell):**
```powershell
$env:SESSION_SECRET="troque-por-um-segredo-forte-aqui"
$env:ADMIN_EMAIL="admin@suaempresa.com"
$env:ADMIN_PASSWORD="SenhaForte123!"
npm start
```

---

## Deploy em Produção (VPS)

O projeto inclui dois scripts de deploy em `scripts/`:

### 1. Empacotar e enviar para a VPS

```bash
# Gera o pacote (exclui node_modules, DB e .git)
tar --exclude="./node_modules" --exclude="./helpdesk.db" --exclude="./.git" --exclude="./helpdesk-release.tar.gz" -czf helpdesk-release.tar.gz .

# Envia para a VPS
scp helpdesk-release.tar.gz root@SEU_IP:/tmp/
```

### 2. Aplicar na VPS

```bash
ssh root@SEU_IP "APP_DIR=/var/www/helpdesk PM2_APP_NAME=helpdesk bash /var/www/helpdesk/scripts/apply-release.sh /tmp/helpdesk-release.tar.gz"
```

O script `apply-release.sh` realiza:
1. Extração do pacote no diretório da aplicação
2. Instalação de dependências (`npm install --production`)
3. Reinício do processo via **PM2**

### Requisitos na VPS

- Node.js >= 18
- PM2 instalado globalmente (`npm install -g pm2`)
- Diretório `/var/www/helpdesk` com permissões corretas

---

## Banco de Dados e Migrações

O banco SQLite (`helpdesk.db`) é criado automaticamente na primeira execução. O `db.js` executa migrações incrementais e idempotentes a cada inicialização:

| Migração | Descrição |
|---|---|
| `tickets` constraints | Adiciona CHECK de status e prioridade válidos |
| `resolved_at` | Coluna para registrar data/hora de resolução |
| `sla_paused_at` / `sla_paused_seconds` | Suporte a pausa do SLA |
| `categories.default_priority` | Prioridade padrão por categoria |
| `users.operadora_id` | Vinculação de usuários a operadoras |
| `operadoras.empresa_id` | Vinculação de operadoras a empresas |
| `departments.operadora_id` | Setores por operadora |
| `categories.operadora_id` | Categorias por operadora |

Seed automático cria na primeira execução:
- Empresa **Grupo AMEP**
- Operadoras **AMEP** e **Operadora**
- Usuário **admin** inicial

---

## Licença

MIT
