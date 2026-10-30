# Browserless HTTP + Cloudflare Queue

O Worker executa o scraper pelo Browserless `/function` via HTTPS. A execução é processada por uma Cloudflare Queue para não depender do limite de 30 segundos do `ctx.waitUntil()`.

## Provisionamento inicial

Execute na raiz do projeto, autenticado na conta Cloudflare correta:

```bash
npx wrangler queues create mapscrape-jobs
npx wrangler secret put BROWSERLESS_TOKEN
```

Ao solicitar o secret, informe um token novo emitido no painel Browserless. **Não reutilize o token que foi anteriormente commitado no repositório.**

Depois:

```bash
npm install
npm run lint
npm run build
npx wrangler deploy
```

O `wrangler.jsonc` já declara o binding produtor `SCRAPE_QUEUE` e o consumer da fila `mapscrape-jobs`. O consumer processa um job por invocação, com até 15 minutos de duração de fila conforme os limites do Cloudflare Queues.

## Fluxo

1. `POST /api/v1/jobs` valida o usuário e grava o job no Supabase.
2. O Worker envia uma mensagem pequena para `mapscrape-jobs`.
3. O consumer chama `https://production-sfo.browserless.io/function` via HTTPS.
4. O Browserless executa o Puppeteer e serializa o extrator atual e seus normalizadores.
5. O Worker recebe os registros e os persiste no schema `mapscrape`.
6. O polling consulta os estados e contadores atualizados no Supabase.

A Service Role Key do Supabase nunca é enviada ao Browserless.

## Validação gradual

Comece com uma coleta limitada a 3–5 estabelecimentos. Confirme:

- mensagem recebida pelo consumer;
- resposta HTTP 200 do Browserless;
- fichas extraídas com campos coerentes;
- registros persistidos no Supabase;
- job em estado terminal com contadores e `completed_at`.

Só depois aumente o limite. Em caso de erro, verifique os logs do Worker e o status da mensagem na fila.