# 🚀 Deploy do MapScrape Pro no Cloudflare

Este documento descreve como publicar o MapScrape Pro na plataforma Cloudflare (Workers + Assets estáticos).

## Arquivos criados/modificados

| Arquivo | Propósito |
|---------|-----------|
| `wrangler.jsonc` | Configuração do Worker (nome, entrypoint, variáveis, assets) |
| `src/worker-entry.ts` | Entrypoint do Worker — adapta o Express para a API Fetch do Cloudflare |
| `worker-configuration.d.ts` | Tipos de runtime gerados pelo `wrangler types` |
| `.dev.vars.example` | Exemplo de variáveis de ambiente locais (não commitar com segredos) |
| `CLOUDFLARE_DEPLOY.md` | Este guia |

## Pré-requisitos

1. Conta na Cloudflare
2. Wrangler instalado: `npm install -g wrangler` (ou use o já disponível)
3. Autenticação: `wrangler login` (fluxo OAuth, não compartilhe tokens)
4. Frontend já buildado: `dist/` (gerado com `bun run build`)

## Passo a passo

### 1. Autenticar no Wrangler

```bash
wrangler login
```

Isso abre o navegador para autorizar o Wrangler na sua conta Cloudflare.

### 2. Configurar variáveis de ambiente

Copie o exemplo e preencha os valores:

```bash
cp .dev.vars.example .dev.vars
```

Edite `.dev.vars` com seus valores reais (NÃO commite este arquivo — está no `.gitignore`).

Variáveis obrigatórias para o Worker:

| Variável | Descrição |
|----------|-----------|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role Key do Supabase (persistência no Worker) |
| `BROWSER_WS_ENDPOINT` | **OBRIGATÓRIO no Workers** — endpoint WebSocket do Cloudflare Browser Rendering (Puppeteer local não roda em Workers) |
| `PAYMENT_WEBHOOK_SECRET` | Secret HMAC para webhooks de pagamento |
| `GEMINI_API_KEY` | Chave da API Gemini (opcional, enriquecimento via IA) |
| `ADMIN_SEED_PASSWORD` | Senha inicial do admin seed (opcional; se omitir, exige reset de senha) |

Definir segredos sensíveis no Worker remoto:

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put BROWSER_WS_ENDPOINT
wrangler secret put PAYMENT_WEBHOOK_SECRET
wrangler secret put GEMINI_API_KEY
wrangler secret put ADMIN_SEED_PASSWORD
```

### 3. Build do frontend

```bash
bun run build
```

Isso gera a pasta `dist/` que será servida como assets estáticos pelo Worker.

### 4. Testar localmente com Wrangler

```bash
bun run cf-dev
```

Isso inicia o Worker localmente (Miniflare) na porta 8787. Acesse `http://localhost:8787` para testar.

### 5. Deploy para produção

```bash
bun run cf-deploy
```

Ou fazer um dry-run primeiro (valida build e packaging):

```bash
bun run cf-deploy-dry
```

## ⚠️ Limitações e adaptações para o Cloudflare

### Scraping (Puppeteer)

O Puppeteer com Chromium local **não roda** em Cloudflare Workers. O código já tem suporte a Cloudflare Browser Rendering via `BROWSER_WS_ENDPOINT`. Você deve:

1. Criar um Worker proxy com `@cloudflare/puppeteer` que exponha um endpoint WebSocket (veja `src/utils/api.ts` para o guia completo)
2. Ou usar a API direta: `wss://browser.cloudflare.com/v1/SEU_ACCOUNT_ID?token=SEU_TOKEN`
3. Definir `BROWSER_WS_ENDPOINT` como secret no Wrangler

### Armazenamento

O servidor local usa um arquivo JSON (`.data/mapscrape_store.json`). No Cloudflare Workers, o sistema de arquivos não é persistente da mesma forma. O projeto já tem camada Supabase em `src/server/db.ts` — o Worker usa as variáveis `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` para persistência.

Recomendado: aplicar a migração RLS em `supabase/migrations/001_enable_rls.sql` no seu projeto Supabase para isolar dados por usuário.

### Variáveis de ambiente do Vite

O frontend usa `import.meta.env.VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. Estas devem ser definidas no build do Vite (via `.env` ou wrangler). Verifique `vite.config.ts` e `src/main.tsx`.

## Comandos úteis

```bash
bun run build            # Build do frontend (Vite)
bun run cf-dev           # Worker local para desenvolvimento
bun run cf-deploy        # Deploy para produção
bun run cf-deploy-dry    # Dry-run (validação sem deploy)
bun run cf-secret-put    # Definir um segredo no Worker
npx wrangler types       # Regenerar tipos de runtime
npx wrangler whoami      # Verificar conta autenticada
```

## Verificação pós-deploy

Após o deploy, o Wrangler exibirá a URL do Worker. Teste:

- `GET /api/auth/me` sem token → deve retornar 401
- `POST /api/auth/login` → deve retornar token (com `ADMIN_SEED_PASSWORD` configurado)
- `POST /api/auth/logout` → deve invalidar o token
- `GET /api/v1/jobs` → deve listar jobs
- Frontend carrega em `/` (servido pelos assets estáticos)

---

## ✅ Status do Deploy (produção)

| Item | Valor |
|------|-------|
| Worker URL | `https://mapscrape-pro.olfnetto.workers.dev` |
| Version ID | `681035d1-aa4f-41a2-906e-f7ef9036250a` |
| Status | Online e funcionando |
| Secrets configuradas | `ADMIN_SEED_PASSWORD`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| Build frontend | `dist/` gerado com sucesso |
| TypeScript | 0 erros (`tsc --noEmit` verde) |

### Endpoints validados em produção

| Endpoint | Método | Resultado |
|----------|--------|-----------|
| `/` | GET | 200 (health check) |
| `/api/auth/me` (sem token) | GET | 401 |
| `/api/auth/login` | POST | 200 + token (scrypt) |
| `/api/auth/me` (com token) | GET | 200 |
| `/api/auth/logout` | POST | 200 |
| `/api/auth/login` (senha errada) | POST | 401 |
| `/api/v1/jobs` | GET | 200 |
| `/api/v1/leads` | GET | 200 |
| `/api/v1/billing/checkout` | POST | 201 |
| `/api/v1/webhooks/pagamento` (sem assinatura) | POST | 503 |
