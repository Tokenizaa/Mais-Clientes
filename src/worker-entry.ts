/**
 * MapScrape Pro — Cloudflare Worker entrypoint (NATIVO, sem Express)
 *
 * Implementa as rotas principais da API usando a API Fetch do Cloudflare
 * Workers. Não importa de server.ts (que usa Express + body-parser,
 * incompatíveis com Workers).
 *
 * O Worker usa o Supabase para persistência quando as secrets
 * SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY estão configuradas.
 * Faz fallback para estado em memória apenas para desenvolvimento/local.
 *
 * Variáveis de ambiente obrigatórias (definir via wrangler secret put ou wrangler.jsonc):
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (para persistência real no Supabase)
 *   - BROWSER_WS_ENDPOINT (obrigatório para scraper real no Workers)
 *   - PAYMENT_WEBHOOK_SECRET (webhooks de pagamento)
 *   - GEMINI_API_KEY (enriquecimento via Gemini)
 *   - ADMIN_SEED_PASSWORD (senha inicial do admin seed)
 */

import { hashPassword, verifyPassword } from './server/auth-crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import puppeteer, { Browser, Page } from 'puppeteer';
import { PlaceRecord, ScrapeJob } from './shared/types';
import { extractPlaceDetails } from './server/scraper/extractor';

// Tipos locais do Cloudflare Workers (evita conflitos com o build do frontend)
interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

interface ExportedHandler<Env = any> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

interface Fetcher {
  (request: Request | string, init?: RequestInit): Promise<Response>;
}

interface Env {
  ADMIN_SEED_PASSWORD?: string;
  BROWSER_WS_ENDPOINT?: string;
  PAYMENT_WEBHOOK_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  GEMINI_API_KEY?: string;
  APP_URL?: string;
  NODE_ENV?: string;
  ASSETS?: Fetcher;
}

// ============================================================================
// Cliente Supabase (criado apenas se as secrets estiverem disponíveis)
// ============================================================================

let supabaseClient: SupabaseClient | null = null;

function getSupabase(env: Env): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  const url = env.SUPABASE_URL;
  // Preferir Service Role Key (server-side, sem RLS); fallback para Anon Key
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    supabaseClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    return supabaseClient;
  } catch {
    return null;
  }
}

// ============================================================================
// Tipos de domínio
// ============================================================================

interface UserProfile {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'admin' | 'user';
  createdAt: string;
  requiresPasswordReset?: boolean;
}

interface ScrapeJob {
  id: string;
  user_id: string;
  segment: string;
  project_name?: string;
  category_id?: string;
  location: string;
  limit_requested: number;
  status: string;
  status_message: string;
  total_found: number;
  total_collected: number;
  total_duplicates: number;
  total_errors: number;
  current_step?: string;
  created_at: string;
  completed_at?: string;
}

interface PlaceRecord {
  id: string;
  job_id: string;
  name: string;
  category: string;
  address: string;
  phone: string;
  website: string;
  rating: string;
  review_count: string;
  price_range: string;
  opening_hours: string;
  business_status: string;
  latitude: string;
  longitude: string;
  maps_url: string;
  description: string;
  services_attributes: string;
  collected_at: string;
  [key: string]: any;
}

interface BillingOrder {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'confirmed' | 'expired' | 'refunded' | 'failed';
  idempotency_key?: string;
  gateway_transaction_id?: string;
  created_at: string;
  confirmed_at?: string;
}

// ============================================================================
// Estado em memória (fallback quando Supabase não está configurado)
// ============================================================================

const memoryState: {
  users: UserProfile[];
  jobs: ScrapeJob[];
  places: PlaceRecord[];
  billing: BillingOrder[];
  revokedTokens: Set<string>;
  seeded: boolean;
} = {
  users: [],
  jobs: [],
  places: [],
  billing: [],
  revokedTokens: new Set(),
  seeded: false,
};

// Lazy seed: roda na primeira requisição, quando env.ADMIN_SEED_PASSWORD já está disponível
function ensureMemorySeed(adminPassword: string): void {
  if (memoryState.seeded) return;
  const adminHash = adminPassword ? hashPassword(adminPassword) : '';
  memoryState.users.push({
    id: 'usr_admin_default',
    email: 'olfnetto@gmail.com',
    name: 'Administrador Geral',
    passwordHash: adminHash,
    role: 'admin',
    createdAt: new Date().toISOString(),
    requiresPasswordReset: !adminHash,
  });
  memoryState.jobs.push({
    id: 'job_seed_worker',
    user_id: 'usr_admin_default',
    segment: 'Clínica Médica',
    project_name: 'Prospecção Médica Sudeste',
    location: 'São Paulo - SP',
    limit_requested: 10,
    status: 'completed',
    status_message: 'Seed inicial do Worker.',
    total_found: 0,
    total_collected: 0,
    total_duplicates: 0,
    total_errors: 0,
    current_step: 'Concluído',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  });
  memoryState.seeded = true;
}

// Garante que o admin tenha senha a cada requisição (env só está disponível no fetch)
function ensureAdminPassword(adminPassword: string): void {
  if (!adminPassword) return;
  const admin = memoryState.users.find((u) => u.email === 'olfnetto@gmail.com');
  if (admin && !admin.passwordHash) {
    admin.passwordHash = hashPassword(adminPassword);
    admin.requiresPasswordReset = false;
  }
}

// ============================================================================
// Helpers de auth
// ============================================================================

function extractBearerToken(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1].trim();
  }
  return null;
}

function revokeToken(token: string): void {
  memoryState.revokedTokens.add(token);
}

async function parseBody(request: Request): Promise<any> {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return request.json().catch(() => null);
  }
  return request.text().then((t) => t || null);
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Supabase REST via fetch (substitui @supabase/supabase-js nas operações de DB,
// que são instáveis no ambiente Cloudflare Workers)
// ============================================================================

async function supabaseFetch(
  env: Env,
  method: string,
  path: string,
  body?: any,
  opts?: { single?: boolean; profile?: string }
): Promise<{ data: any; error: any }> {
  // O objeto env é capturado explicitamente pelo waitUntil; não use globalThis
  // para transportar credenciais entre requisições.
  const url = env.SUPABASE_URL ?? '';
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY ?? '';
  if (!url || !key) {
    return { data: null, error: new Error('Supabase não configurado') };
  }
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': 'application/json',
      'Accept-Profile': opts?.profile ?? 'mapscrape',
      'Content-Profile': opts?.profile ?? 'mapscrape',
    };
    if (opts?.single) headers['Prefer'] = 'return=representation';
    const resp = await fetch(`${url}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { data: null, error: new Error(`HTTP ${resp.status}: ${text}`) };
    }
    const data = await resp.json();
    if (opts?.single && Array.isArray(data)) {
      return { data: data.length > 0 ? data[0] : null, error: null };
    }
    return { data, error: null };
  } catch (err: any) {
    return { data: null, error: err };
  }
}

// ============================================================================
// Resolução de usuário (Supabase ou memória)
// ============================================================================

async function resolveUser(
  token: string | null,
  env: Env
): Promise<UserProfile | null> {
  if (!token) return null;
  if (memoryState.revokedTokens.has(token)) return null;

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    // Sem Supabase configurado: fallback para tokens de memória
    return memoryState.users.find((u) => {
      const t1 = `sess_${u.id}`;
      const t2 = `sess_${u.id}_`;
      return token === t1 || token.startsWith(t2);
    }) ?? null;
  }

  let supabaseUser: any = null;
  try {
    // Valida o token JWT via Supabase Auth API usando fetch direto.
    // sb.auth.getUser(token) pode falhar no ambiente Cloudflare Workers.
    const userResp = await fetch(`${url}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: key,
      },
    });
    if (!userResp.ok) {
      // Token inválido/expirado: tentar fallback de memória
      return memoryState.users.find((u) => {
        const t1 = `sess_${u.id}`;
        const t2 = `sess_${u.id}_`;
        return token === t1 || token.startsWith(t2);
      }) ?? null;
    }
    supabaseUser = await userResp.json();
  } catch {
    return null;
  }

  if (!supabaseUser) return null;

  // Tenta buscar/criar perfil em mapscrape.users (não-fatal:
  // se falhar, ainda retornamos um perfil mínimo a partir do token válido)
  try {
    const sb = getSupabase(env);
    if (sb) {
      let user: UserProfile | null = null;
      try {
        const { data: existing } = await sb
          .schema('mapscrape')
          .from('users')
          .select('*')
          .eq('id', supabaseUser.id)
          .single();
        if (existing) user = existing as unknown as UserProfile;
      } catch {}
      if (!user) {
        try {
          const { data: inserted } = await sb
            .schema('mapscrape')
            .from('users')
            .insert({
              id: supabaseUser.id,
              email: supabaseUser.email ?? '',
              display_name:
                supabaseUser.user_metadata?.name ??
                supabaseUser.email?.split('@')[0] ??
                'Usuário',
              role: 'user',
              created_at: new Date().toISOString(),
            })
            .select()
            .single();
          if (inserted) user = inserted as unknown as UserProfile;
        } catch {}
      }
      if (user) return user;
    }
  } catch {}

  // Perfil mínimo a partir do token validado (suficiente para autorização)
  return {
    id: supabaseUser.id,
    email: supabaseUser.email ?? '',
    name:
      supabaseUser.user_metadata?.name ??
      supabaseUser.email?.split('@')[0] ??
      'Usuário',
    passwordHash: '',
    role: supabaseUser.role ?? 'user',
    createdAt: supabaseUser.created_at ?? new Date().toISOString(),
  };
}

// ============================================================================
// Scraping real (adaptado do server.ts para Cloudflare Workers)
// ============================================================================

const activeScrapeJobs = new Map<string, { cancel: () => void }>();

async function connectScrapeBrowser(wsEndpoint: string): Promise<Browser> {
  if (wsEndpoint) {
    try {
      console.log(`[Scraper] Conectando ao Chromium remoto: ${wsEndpoint.replace(/:[^:]*@/, ':***@')}`);
      return await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        protocolTimeout: 45000,
      });
    } catch (err: any) {
      console.warn(`[Scraper] Falha ao conectar ao Chromium remoto (${err?.message}).`);
    }
  }
  throw new Error('BROWSER_WS_ENDPOINT não configurado. O scraping real requer Cloudflare Browser Rendering.');
}

async function updateJobSupabase(env: Env, userId: string, jobId: string, updates: any): Promise<void> {
  const { error } = await supabaseFetch(env, 'PATCH', `searches?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(userId)}`, updates);
  if (error) throw new Error(`Falha ao atualizar job ${jobId}: ${error.message}`);
}

async function insertPlaceSupabase(env: Env, place: any): Promise<void> {
  const { error } = await supabaseFetch(env, 'POST', 'places', place);
  if (error) throw new Error(`Falha ao persistir estabelecimento: ${error.message}`);
}

async function executeScrapeJob(
  jobId: string,
  segment: string,
  location: string,
  limit: number,
  userId: string,
  wsEndpoint: string,
  env: Env
) {
  let activeBrowser: Browser | null = null;

  activeScrapeJobs.set(jobId, {
    cancel: () => {
      if (activeBrowser) {
        activeBrowser.close().catch(() => {});
      }
    },
  });

  const setJobStatus = async (updates: any) => {
    await updateJobSupabase(env, userId, jobId, updates);
  };

  try {
    const searchQuery = `${segment} ${location}`.trim();
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

    await setJobStatus({ status: 'running', current_step: 'Conectando ao navegador...' });

    activeBrowser = await connectScrapeBrowser(wsEndpoint);
    const searchPage = await activeBrowser.newPage();
    await searchPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await searchPage.setViewport({ width: 1280, height: 900 });
    await searchPage.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    await setJobStatus({ current_step: `Navegando no Google Maps para: "${searchQuery}"...` });

    await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));

    // Handle Google consent banner
    await searchPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const consentBtn = btns.find((b) =>
        /aceitar|concordo|accept all|i agree/i.test(b.innerText || '')
      );
      if (consentBtn) consentBtn.click();
    }).catch(() => {});

    const placeUrls = new Set<string>();
    let previousCount = 0;
    let stagnantRounds = 0;

    if (searchPage.url().includes('/maps/place/')) {
      placeUrls.add(searchPage.url());
    }

    await setJobStatus({ current_step: 'Buscando fichas comerciais na página de resultados...' });

    while (placeUrls.size < limit && stagnantRounds < 6) {
      const links: string[] = await searchPage
        .$$eval('a[href*="/maps/place/"]', (anchors) =>
          anchors
            .map((a) => (a as HTMLAnchorElement)?.href)
            .filter((href): href is string => Boolean(href) && href.includes('/maps/place/'))
        )
        .catch(() => []);

      for (const url of links) {
        if (placeUrls.size >= limit) break;
        placeUrls.add(url);
      }

      await setJobStatus({ total_found: placeUrls.size, current_step: `Identificados ${placeUrls.size} estabelecimentos...` });

      if (placeUrls.size >= limit) break;

      await searchPage.evaluate(() => {
        const feed =
          document.querySelector('div[role="feed"]') ||
          document.querySelector('div.m6QErb[aria-label]') ||
          document.querySelector('div.TFQHme');
        if (feed) {
          (feed as HTMLElement).scrollTop = feed.scrollHeight;
        } else {
          window.scrollTo(0, document.body.scrollHeight);
        }
      }).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 1500));

      if (placeUrls.size === previousCount) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
        previousCount = placeUrls.size;
      }
    }

    await searchPage.close().catch(() => {});

    if (placeUrls.size === 0) {
      await setJobStatus({
        status: 'failed',
        status_message: 'Nenhum estabelecimento encontrado no Google Maps para esta busca.',
        current_step: 'Sem resultados',
        total_errors: 1,
      });
      return;
    }

    let collectedCount = 0;

    for (const placeUrl of placeUrls) {
      if (collectedCount >= limit) break;

      let detailPage: Page | null = null;
      try {
        detailPage = await activeBrowser!.newPage();
        await detailPage.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        await detailPage.setViewport({ width: 1280, height: 900 });
        await detailPage.setExtraHTTPHeaders({
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        });

        await detailPage.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const place = await extractPlaceDetails(detailPage, jobId, placeUrl);

        if (!place.city && location.includes(',')) {
          const parts = location.split(',');
          place.city = parts[0].trim();
          if (parts[1]) place.state = parts[1].trim();
        } else if (!place.city) {
          place.city = location;
        }

        await insertPlaceSupabase(env, place);
        collectedCount += 1;

        await setJobStatus({
          total_collected: collectedCount,
          current_step: `Coletado (${collectedCount}/${Math.min(limit, placeUrls.size)}): ${place.name || 'Estabelecimento'}`,
        });
      } catch (extractErr: any) {
        console.error(`Erro ao coletar ficha ${placeUrl}:`, extractErr.message);
      } finally {
        if (detailPage) await detailPage.close().catch(() => {});
      }
    }

    await setJobStatus({
      status: collectedCount > 0 ? 'completed' : 'failed',
      status_message:
        collectedCount > 0
          ? `Coleta concluída com sucesso! ${collectedCount} estabelecimentos extraídos.`
          : 'Nenhum estabelecimento pôde ser extraído.',
      current_step: collectedCount > 0 ? 'Concluído' : 'Falha',
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    await setJobStatus({
      status: 'failed',
      status_message: `Erro durante a execução da coleta: ${error?.message || 'Falha desconhecida'}`,
      current_step: 'Falha',
      total_errors: 1,
    });
  } finally {
    if (activeBrowser) {
      await activeBrowser.close().catch(() => {});
    }
    activeScrapeJobs.delete(jobId);
  }
}

// ============================================================================
// Rotas da API
// ============================================================================

async function handleAuth(req: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // POST /api/auth/login
  if (path === '/api/auth/login' && method === 'POST') {
    const body = await parseBody(req);
    const email = body?.email;
    const password = body?.password;
    if (!email || !password) return errorResponse('Informe e-mail e senha.', 400);

    const sb = getSupabase(env);
    if (sb) {
      try {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (!error && data?.user) {
          const token = data.session?.access_token ?? `sess_${data.user.id}_${Date.now()}`;
          // Registra login
          await sb.schema('mapscrape').from('users').update({ last_login_at: new Date().toISOString() }).eq('id', data.user.id);
          return jsonResponse({
            token,
            user: {
              id: data.user.id,
              email: data.user.email,
              name: data.user.user_metadata?.name ?? data.user.email?.split('@')[0] ?? 'Usuário',
              role: data.user.user_metadata?.role ?? 'user',
            },
          });
        }
        // Supabase Auth falhou (usuário não existe no Supabase): tentar fallback memória
      } catch {
        // Supabase Auth indisponível: tentar fallback memória
      }
    }

    // Fallback: estado em memória
    const user = memoryState.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
    if (!user) return errorResponse('E-mail ou senha inválidos.', 401);
    if (!user.passwordHash) return errorResponse('Senha não definida. Solicite redefinição.', 401);
    if (!verifyPassword(password, user.passwordHash)) return errorResponse('E-mail ou senha inválidos.', 401);

    const token = `sess_${user.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    return jsonResponse({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }

  // POST /api/auth/logout
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = extractBearerToken(req.headers);
    if (token) revokeToken(token);
    const sb = getSupabase(env);
    if (sb && token) {
      try { await sb.auth.signOut(); } catch {}
    }
    return jsonResponse({ success: true, message: 'Sessão encerrada com sucesso.' });
  }

  // GET /api/auth/me
  if (path === '/api/auth/me' && method === 'GET') {
    const token = extractBearerToken(req.headers);
    const user = await resolveUser(token, env);
    if (!user) return errorResponse('Sessão inválida ou expirada.', 401);
    return jsonResponse({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  }

  // POST /api/auth/register
  if (path === '/api/auth/register' && method === 'POST') {
    const body = await parseBody(req);
    const { name, email, password } = body;
    if (!email || !password) return errorResponse('E-mail e senha são obrigatórios.', 400);

    const sb = getSupabase(env);
    if (sb) {
      try {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (!error && data?.user) {
          const token = data.session?.access_token ?? `sess_${data.user.id}_${Date.now()}`;
          await sb.schema('mapscrape').from('users').insert({
            id: data.user.id,
            email,
            display_name: name ?? email.split('@')[0],
            role: 'user',
            created_at: new Date().toISOString(),
          });
          return jsonResponse({
            token,
            user: { id: data.user.id, email, name, role: 'user' },
          }, 201);
        }
        return errorResponse(error?.message ?? 'Erro ao criar conta.', 400);
      } catch {
        return errorResponse('Erro ao criar conta.', 500);
      }
    }

    // Fallback memória
    const existing = memoryState.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
    if (existing) return errorResponse('Já existe uma conta cadastrada com este e-mail.', 409);
    const newUser: UserProfile = {
      id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      email: String(email).trim().toLowerCase(),
      name: String(name || '').trim() || 'Usuário',
      passwordHash: hashPassword(password),
      role: memoryState.users.length === 0 ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
    };
    memoryState.users.push(newUser);
    const token = `sess_${newUser.id}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    return jsonResponse({
      token,
      user: { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role },
    }, 201);
  }

  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}

async function handleJobs(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const token = extractBearerToken(req.headers);
  const user = await resolveUser(token, env);

  // GET /api/v1/jobs
  if (path === '/api/v1/jobs' && method === 'GET') {
    const sb = getSupabase(env);
    if (sb && user) {
      try {
        const { data, error } = await supabaseFetch(env, 'GET', `searches?user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc`);
        if (!error) {
          return jsonResponse({ data, total: data.length });
        }
      } catch {}
    }
    const sorted = [...memoryState.jobs].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    return jsonResponse({ data: sorted, total: sorted.length });
  }

  // POST /api/v1/jobs
  if (path === '/api/v1/jobs' && method === 'POST') {
    if (!user) return errorResponse('Autenticação obrigatória.', 401);
    const body = await parseBody(req);
    const { segment, location, limit, projectName, categoryName } = body;
    if (!segment || !location) return errorResponse('Segmento e Localização são campos obrigatórios.', 400);

    const numLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const sb = getSupabase(env);
    if (sb && user) {
      try {
        const { data, error } = await supabaseFetch(env, 'POST', 'searches', {
          id: jobId,
          user_id: user.id,
          segment: String(segment).trim(),
          project_name: projectName ? String(projectName).trim() : undefined,
          category_id: categoryName ? String(categoryName).trim() : undefined,
          location: String(location).trim(),
          limit_requested: numLimit,
          status: 'running',
          status_message: `Iniciando coleta para "${segment}" em "${location}"...`,
          total_found: 0,
          total_collected: 0,
          total_duplicates: 0,
          total_errors: 0,
          current_step: 'Conectando ao mecanismo de busca...',
          created_at: new Date().toISOString(),
        }, { single: true });
        if (!error && data) {
          const wsEndpoint = env.BROWSER_WS_ENDPOINT ?? '';
          ctx.waitUntil(executeScrapeJob(jobId, String(segment).trim(), String(location).trim(), numLimit, user.id, wsEndpoint, env));
          return jsonResponse({ data: { jobId, job: Array.isArray(data) ? data[0] : data }, jobId, message: 'Coleta agendada com sucesso.' }, 201);
        }
      } catch {}
    }

    const newJob: ScrapeJob = {
      id: jobId,
      user_id: user.id,
      segment: String(segment).trim(),
      project_name: projectName ? String(projectName).trim() : undefined,
      category_id: categoryName ? String(categoryName).trim() : undefined,
      location: String(location).trim(),
      limit_requested: numLimit,
      status: 'running',
      status_message: `Iniciando coleta para "${segment}" em "${location}"...`,
      total_found: 0,
      total_collected: 0,
      total_duplicates: 0,
      total_errors: 0,
      current_step: 'Conectando ao mecanismo de busca...',
      created_at: new Date().toISOString(),
    };
    memoryState.jobs.unshift(newJob);
    const wsEndpoint = env.BROWSER_WS_ENDPOINT ?? '';
    ctx.waitUntil(executeScrapeJob(jobId, String(segment).trim(), String(location).trim(), numLimit, user.id, wsEndpoint, env));
    return jsonResponse({ data: { jobId, job: newJob }, jobId, message: 'Coleta agendada com sucesso.' }, 201);
  }

  // GET /api/v1/jobs/:id
  const m = path.match(/^\/api\/v1\/jobs\/(.+)$/);
  if (m && method === 'GET') {
    const sb = getSupabase(env);
    if (sb && user) {
      try {
        const { data, error } = await supabaseFetch(env, 'GET', `searches?id=eq.${encodeURIComponent(m[1])}&user_id=eq.${encodeURIComponent(user.id)}`, undefined, { single: true });
        if (!error && data) return jsonResponse({ data: data, ...data });
      } catch {}
    }
    const job = memoryState.jobs.find((j) => j.id === m[1]);
    if (!job) return errorResponse('Coleta não encontrada.', 404);
    return jsonResponse({ data: job, ...job });
  }

  // POST /api/v1/jobs/:id/stop
  if (method === 'POST' && path.match(/^\/api\/v1\/jobs\/.+\/stop$/)) {
    const jobId = path.split('/')[5];
    const sb = getSupabase(env);
    if (sb && user) {
      try {
        await supabaseFetch(env, 'PATCH', `searches?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(user.id)}`, {
          status: 'stopped',
          status_message: 'Coleta interrompida pelo usuário.',
          current_step: 'Parado',
        });
        return jsonResponse({ success: true, message: 'Coleta parada com sucesso.' });
      } catch {}
    }
    const job = memoryState.jobs.find((j) => j.id === jobId);
    if (!job) return errorResponse('Coleta não encontrada.', 404);
    job.status = 'stopped';
    job.status_message = 'Coleta interrompida pelo usuário.';
    job.current_step = 'Parado';
    return jsonResponse({ success: true, message: 'Coleta parada com sucesso.', job });
  }

  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}

async function handleLeads(req: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === '/api/v1/leads' && req.method === 'GET') {
    const sb = getSupabase(env);
    const token = extractBearerToken(req.headers);
    const user = await resolveUser(token, env);

    if (sb && user) {
      try {
        const { data, error } = await sb
          .schema('mapscrape')
          .from('places')
          .select('*')
          .order('collected_at', { ascending: false })
          .limit(25);
        if (!error) {
          return jsonResponse({
            data,
            places: data,
            pagination: { total: data.length, offset: 0, limit: 25, hasMore: false },
            total: data.length,
          });
        }
      } catch {}
    }
    return jsonResponse({
      data: memoryState.places,
      places: memoryState.places,
      pagination: { total: memoryState.places.length, offset: 0, limit: 25, hasMore: false },
      total: memoryState.places.length,
    });
  }
  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}

async function handleScraperSettings(req: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === '/api/v1/scraper/settings' && method === 'GET') {
    const hasRemoteEndpoint = Boolean(env.BROWSER_WS_ENDPOINT);
    return jsonResponse({
      engine: hasRemoteEndpoint ? 'cloudflare_remote' : 'unconfigured',
      hasRemoteEndpoint,
      status: hasRemoteEndpoint ? 'configured' : 'unconfigured',
      description: hasRemoteEndpoint ? 'Endpoint remoto configurado' : 'Mecanismo de navegador não configurado',
    });
  }

  if (path === '/api/v1/scraper/settings' && method === 'POST') {
    return jsonResponse({ success: true, message: 'Configurações atualizadas.' });
  }

  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}

async function handleBilling(req: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const token = extractBearerToken(req.headers);
  const user = await resolveUser(token, env);

  // POST /api/v1/billing/checkout
  if (path === '/api/v1/billing/checkout' && method === 'POST') {
    if (!user) return errorResponse('Autenticação obrigatória.', 401);
    const body = await parseBody(req);
    const { amount, idempotency_key } = body;
    if (!amount || Number(amount) <= 0) return errorResponse('Valor inválido.', 400);

    const sb = getSupabase(env);
    if (sb && user) {
      try {
        const { data, error } = await sb
          .schema('mapscrape')
          .from('billing_orders')
          .insert({
            user_id: user.id,
            amount: Number(amount),
            currency: 'BRL',
            status: 'pending',
            idempotency_key,
            created_at: new Date().toISOString(),
          })
          .select()
          .single();
        if (!error && data) {
          return jsonResponse({
            order: { id: data.id, status: data.status, amount: data.amount, currency: data.currency },
            message: 'Cobrança criada. Aguarde confirmação do gateway via webhook.',
          }, 201);
        }
      } catch {}
    }

    if (idempotency_key) {
      const existing = memoryState.billing.find((o) => o.user_id === user.id && o.idempotency_key === idempotency_key);
      if (existing) return jsonResponse({ order: existing });
    }

    const order: BillingOrder = {
      id: `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      user_id: user.id,
      amount: Number(amount),
      currency: 'BRL',
      status: 'pending',
      idempotency_key,
      created_at: new Date().toISOString(),
    };
    memoryState.billing.push(order);
    return jsonResponse({
      order: { id: order.id, status: order.status, amount: order.amount, currency: order.currency },
      message: 'Cobrança criada. Aguarde confirmação do gateway via webhook.',
    }, 201);
  }

  // POST /api/v1/webhooks/pagamento
  if (path === '/api/v1/webhooks/pagamento' && method === 'POST') {
    const secret = (globalThis as any).PAYMENT_WEBHOOK_SECRET || '';
    if (!secret) return errorResponse('Webhook não configurado.', 503);

    const signature = req.headers.get('x-payment-signature');
    if (!signature) return errorResponse('Assinatura do webhook ausente.', 401);

    const body = await parseBody(req);
    const expected = await hmacSha256(secret, JSON.stringify(body));
    if (signature !== expected) return errorResponse('Assinatura inválida.', 401);

    const { transaction_id, order_id, status } = body;

    const sb = getSupabase(env);
    if (sb && user) {
      try {
        const { data: order, error } = await sb
          .schema('mapscrape')
          .from('billing_orders')
          .select('*')
          .eq('id', order_id)
          .eq('user_id', user.id)
          .single();
        if (!error && order) {
          if (order.status === 'confirmed' && order.gateway_transaction_id === transaction_id) {
            return jsonResponse({ success: true, message: 'Já processado.' });
          }
          const updates: any = {};
          if (status === 'confirmed') {
            updates.status = 'confirmed';
            updates.gateway_transaction_id = transaction_id ?? order.id;
            updates.confirmed_at = new Date().toISOString();
          } else if (status === 'failed' || status === 'expired') {
            updates.status = status;
          }
          await sb.schema('mapscrape').from('billing_orders').update(updates).eq('id', order_id);
          return jsonResponse({ success: true, order: { id: order_id, status: updates.status || order.status } });
        }
      } catch {}
    }

    // Fallback memória
    const mOrder = memoryState.billing.find((o) => o.id === order_id);
    if (!mOrder) return errorResponse('Cobrança não encontrada.', 404);
    if (mOrder.user_id !== user!.id) return errorResponse('Acesso negado.', 403);
    if (mOrder.gateway_transaction_id === transaction_id && mOrder.status === 'confirmed') {
      return jsonResponse({ success: true, message: 'Já processado.' });
    }
    if (status === 'confirmed') {
      mOrder.status = 'confirmed';
      mOrder.gateway_transaction_id = transaction_id ?? mOrder.id;
      mOrder.confirmed_at = new Date().toISOString();
    } else if (status === 'failed' || status === 'expired') {
      mOrder.status = status;
    }
    return jsonResponse({ success: true, order: { id: mOrder.id, status: mOrder.status } });
  }

  // GET /api/v1/billing/order/:id
  const m = path.match(/^\/api\/v1\/billing\/order\/(.+)$/);
  if (m && method === 'GET') {
    if (!user) return errorResponse('Autenticação obrigatória.', 401);
    const sb = getSupabase(env);
    if (sb && user) {
      try {
        const { data, error } = await sb
          .schema('mapscrape')
          .from('billing_orders')
          .select('*')
          .eq('id', m[1])
          .eq('user_id', user.id)
          .single();
        if (!error && data) return jsonResponse({ order: data });
        return errorResponse('Cobrança não encontrada.', 404);
      } catch {}
    }
    const order = memoryState.billing.find((o) => o.id === m[1]);
    if (!order) return errorResponse('Cobrança não encontrada.', 404);
    if (order.user_id !== user.id) return errorResponse('Acesso negado.', 403);
    return jsonResponse({ order });
  }

  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}

// ============================================================================
// Handler principal do Worker
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Expor variáveis de ambiente como globais (para acesso nos helpers)
    const adminPassword = env.ADMIN_SEED_PASSWORD ?? '';
    (globalThis as any).ADMIN_SEED_PASSWORD = adminPassword;
    (globalThis as any).BROWSER_WS_ENDPOINT = env.BROWSER_WS_ENDPOINT ?? '';
    (globalThis as any).PAYMENT_WEBHOOK_SECRET = env.PAYMENT_WEBHOOK_SECRET ?? '';
    (globalThis as any).SUPABASE_URL = env.SUPABASE_URL ?? '';
    (globalThis as any).SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    (globalThis as any).SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY ?? '';

    // Garante seed e senha do admin a cada requisição (env só está disponível no fetch)
    ensureMemorySeed(adminPassword);
    ensureAdminPassword(adminPassword);

    const url = new URL(request.url);
    const path = url.pathname;

    // Rotas da API
    if (path.startsWith('/api/auth/')) return handleAuth(request, url, env);
    if (path.startsWith('/api/v1/jobs')) return handleJobs(request, url, env, ctx);
    if (path.startsWith('/api/v1/leads')) return handleLeads(request, url, env);
    if (path.startsWith('/api/v1/scraper/settings')) return handleScraperSettings(request, url, env);
    if (path.startsWith('/api/v1/billing')) return handleBilling(request, url, env);
    if (path.startsWith('/api/v1/webhooks/pagamento')) return handleBilling(request, url, env);

    // SPA: servir index.html para rotas não-API
    return new Response(
      '<html><body><h1>MapScrape Pro — Worker Ativo</h1><p>API disponível em /api/*</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  },
} satisfies ExportedHandler<Env>;
