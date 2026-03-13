# Help Desk AMEP — Sistema de Chamados

Sistema interno de gerenciamento de chamados técnicos com controle de SLA, múltiplos perfis de usuário e painel administrativo.

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![Express](https://img.shields.io/badge/Express-4.x-black?logo=express)
![SQLite](https://img.shields.io/badge/SQLite-3-blue?logo=sqlite)
![Bootstrap](https://img.shields.io/badge/Bootstrap-5-purple?logo=bootstrap)

---

## Funcionalidades

- Abertura de chamados com título, descrição, categoria e prioridade
- Acompanhamento de status: **Aberto → Em andamento → Aguardando usuário → Pausa → Resolvido → Fechado**
- **SLA de 48 horas** com contador automático, pausa e retomada ao mudar status
- Ordenação inteligente: chamados abertos aparecem primeiro, ordenados pelo prazo SLA mais próximo
- Comentários em chamados por usuários e técnicos
- Painel do técnico: listagem, atribuição e atualização de chamados
- Painel do usuário: acompanhamento dos próprios chamados
- Relatórios: tempo médio de resolução, distribuição por status, prioridade e categoria
- Autenticação por sessão com perfis: **admin**, **operadora** e **usuário comum**
- Layout totalmente responsivo (mobile/tablet)
- Todos os timestamps em `America/Sao_Paulo`

---

## Tecnologias

| Camada          | Tecnologia                    |
|-----------------|-------------------------------|
| Backend         | Node.js 18+ / Express 4       |
| Banco de dados  | SQLite 3 (`sqlite3`)          |
| Template engine | EJS                           |
| Frontend        | Bootstrap 5 + CSS customizado |
| Autenticação    | express-session + bcryptjs    |
| Deploy          | PM2 + VPS Linux               |

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

Acesse: http://localhost:3000

Na primeira execução, se ADMIN_PASSWORD não estiver definido, uma senha aleatória é gerada e exibida no log do terminal.

Variáveis de Ambiente
Variável	                    Padrão	                 Descrição
PORT	                        3000	                   Porta do servidor HTTP
SESSION_SECRET	              (obrigatório em prod)	   Segredo da sessão Express
ADMIN_EMAIL	                  dmin@empresa.com	       E-mail do administrador inicial
ADMIN_PASSWORD	              (gerado aleatório)	     Senha do administrador (mínimo 12 caracteres)
NODE_ENV	                    development	             Use production em ambiente de produção

Exemplo (PowerShell):
$env:SESSION_SECRET="troque-por-um-segredo-forte"
$env:ADMIN_EMAIL="admin@suaempresa.com"
$env:ADMIN_PASSWORD="SenhaForte123!"
npm start

Status dos Chamados e SLA

Status	                      Descrição	                                                 SLA
aberto	                      Chamado recém-criado, aguardando atribuição	               ▶ Contando
em_andamento	                Técnico trabalhando no chamado	                           ▶ Contando
aguardando_usuario	          Aguardando retorno do solicitante	                         ▶ Contando
pausa	SLA pausado             (aguardando recurso externo)	                             ⏸ Pausado
resolvido	                    Solução aplicada, aguardando confirmação	                 ⏹ Parado
fechado	                      Chamado encerrado	                                         ⏹ Parado

Estrutura do Projeto

├── src/
│   ├── server.js           # Rotas e lógica de negócio
│   ├── db.js               # Banco de dados e migrações automáticas
│   ├── constants/
│   │   └── tickets.js      # Status e prioridades válidos
│   └── middlewares/
│       └── auth.js         # Autenticação e autorização
├── views/                  # Templates EJS
├── public/css/styles.css   # Estilos customizados
├── scripts/
│   ├── deploy-vps.sh       # Empacota e envia para a VPS
│   └── apply-release.sh    # Aplica release e reinicia via PM2
└── package.json

Deploy
# Empacotar o código
tar --exclude="./node_modules" --exclude="./helpdesk.db" --exclude="./.git" -czf helpdesk-release.tar.gz .

# Enviar para a VPS
scp helpdesk-release.tar.gz root@SEU_IP:/tmp/

# Aplicar na VPS
ssh root@SEU_IP "APP_DIR=/var/www/helpdesk PM2_APP_NAME=helpdesk /var/www/helpdesk/scripts/apply-release.sh /tmp/helpdesk-release.tar.gz"

Licença
MIT



