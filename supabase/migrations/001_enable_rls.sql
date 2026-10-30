-- ============================================================================
-- MapScrape Pro — Migração P0-4.3: Habilitar RLS e isolamento de dados
-- ============================================================================
-- Aplicar no Supabase Dashboard (SQL Editor) ou via CLI (supabase db push).
-- Objetivo: impedir vazamento de dados entre usuários (domínio 4, P0-4.3).
-- ============================================================================

-- 1) Habilitar RLS em todas as tabelas expostas do schema mapscrape
ALTER TABLE mapscrape.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.places ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.search_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.run_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.audit_logs ENABLE ROW LEVEL SECURITY;

-- 2) Políticas de isolamento: usuário só enxerga/edita seus próprios registros.
--    Coluna de isolamento: user_id (ou consumer_project que mapeia para o usuário).

-- users: cada usuário vê apenas seu próprio perfil
CREATE POLICY users_own_profile ON mapscrape.users
  FOR ALL USING (auth.uid()::text = id);

-- api_credentials: escopo por consumer_project (usuário dono)
CREATE POLICY api_credentials_own ON mapscrape.api_credentials
  FOR ALL USING (consumer_project = auth.uid()::text);

-- searches (jobs): isolamento por user_id
CREATE POLICY searches_own ON mapscrape.searches
  FOR ALL USING (user_id = auth.uid()::text);

-- places: isolamento indireto via searches.user_id
CREATE POLICY places_own ON mapscrape.places
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM mapscrape.searches s
      WHERE s.id = places.job_id
        AND s.user_id = auth.uid()::text
    )
  );

-- projects: isolamento por user_id
CREATE POLICY projects_own ON mapscrape.projects
  FOR ALL USING (user_id = auth.uid()::text);

-- search_categories: isolamento por user_id
CREATE POLICY search_categories_own ON mapscrape.search_categories
  FOR ALL USING (user_id = auth.uid()::text);

-- run_reports: isolamento por user_id
CREATE POLICY run_reports_own ON mapscrape.run_reports
  FOR ALL USING (user_id = auth.uid()::text);

-- audit_logs: isolamento por user_id (quando preenchido)
CREATE POLICY audit_logs_own ON mapscrape.audit_logs
  FOR ALL USING (user_id = auth.uid()::text OR user_id IS NULL);

-- 3) Privilégios mínimos: serviço usa service_role (server), cliente usa anon (RLS ativa).
--    Conceder apenas o necessário ao papel authenticated e anon.
GRANT USAGE ON SCHEMA mapscrape TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mapscrape TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA mapscrape TO anon;

-- ============================================================================
-- NOTA DE IMPLEMENTAÇÃO (código):
--   src/server/db.ts usa SUPABASE_SERVICE_ROLE_KEY para TODAS as operações,
--   o que contorna a RLS. Após aplicar esta migração, o backend deve:
--     a) Usar SUPABASE_ANON_KEY + JWT do usuário para operações do cliente (RLS aplica).
--     b) Usar SERVICE_ROLE_KEY apenas em rotas administrativas auditadas.
-- ============================================================================
