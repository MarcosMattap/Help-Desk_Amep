# Help Desk - Sistema de Chamados (Node.js)

Sistema simples de abertura e acompanhamento de chamados para uso interno.

## Tecnologias

- Node.js + Express
- SQLite (arquivo local `helpdesk.db`)
- EJS para views
- Bootstrap 5 para layout

## Como rodar

1. Instalar dependências (na pasta do projeto `Help-Desk`):

```bash
npm install
```

1. Iniciar o servidor:

```bash
npm start
```

1. Acessar no navegador:

- `http://localhost:3000`

## Variaveis de ambiente

- `PORT` (opcional): porta do servidor (padrao: `3000`)
- `NODE_ENV` (opcional): use `production` em ambiente de producao
- `SESSION_SECRET` (obrigatoria em producao): segredo da sessao
- `ADMIN_EMAIL` (opcional): e-mail do admin inicial quando banco estiver vazio (padrao: `admin@empresa.com`)
- `ADMIN_PASSWORD` (opcional, recomendado): senha do admin inicial (minimo de 12 caracteres)

Exemplo no PowerShell:

```powershell
$env:NODE_ENV="production"
$env:SESSION_SECRET="troque-por-um-segredo-forte"
npm start
```

## Login inicial

- Se o banco estiver vazio no primeiro start, o sistema cria um admin inicial.
- E-mail padrao: `admin@empresa.com` (ou `ADMIN_EMAIL`, se informado).
- Senha:
  - se `ADMIN_PASSWORD` for informada (>= 12 caracteres), ela sera usada;
  - caso contrario, o sistema gera uma senha aleatoria forte e exibe no log do servidor.
- Recomendacao: definir `ADMIN_PASSWORD` e alterar a senha apos o primeiro login.

Com esse usuário você pode:

- Abrir chamados
- Ver todos os chamados
- Cadastrar **setores** e **categorias** em `/admin`

