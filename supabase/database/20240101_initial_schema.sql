-- ============================================================================
-- Initial Schema Migration for MapScrape v2 - Supabase Auth
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossl";

-- ============================================================================
-- Row Level Security (RLS) Policy Configuration
-- ============================================================================

-- Enable RLS on all tables (will be configured per-table below)
-- In production, these should be enabled. For development, they can be disabled.

-- ============================================================================
-- Table: users (Supabase Auth profiles)
-- ============================================================================
-- This table stores additional user profile data linked to Supabase Auth users.
-- The primary identity is the Supabase Auth user UUID (auth.id()).

DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- ============================================================================
-- Table: searches (jobs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  segment TEXT NOT NULL,
  project_name TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL,
  limit_requested INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_message TEXT NOT NULL DEFAULT '',
  total_found INTEGER NOT NULL DEFAULT 0,
  total_collected INTEGER NOT NULL DEFAULT 0,
  total_duplicates INTEGER NOT NULL DEFAULT 0,
  total_errors INTEGER NOT NULL DEFAULT 0,
  current_step TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  project_id TEXT,
  category_id TEXT
);

-- ============================================================================
-- Table: places
-- ============================================================================
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  review_count TEXT NOT NULL DEFAULT '',
  rating_range TEXT NOT NULL DEFAULT '',
  review_count TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  review_count TEXT NOT NULL DEFAULT '',
  review_range TEXT NOT NULL DEFAULT '',
  price_range TEXT NOT NULL DEFAULT '',
  business_status TEXT NOT NULL DEFAULT '',
  opening_hours TEXT NOT NULL DEFAULT '',
  latitude TEXT NOT NULL DEFAULT '',
  longitude TEXT NOT NULL DEFAULT '',
  maps_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  services_attributes TEXT NOT NULL DEFAULT '',
  photos TEXT DEFAULT '',
  videos TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  booking_url TEXT DEFAULT '',
  social_links TEXT DEFAULT '',
  reviews TEXT DEFAULT '[]',
  review_topics TEXT DEFAULT '[]',
  additional_attributes TEXT DEFAULT '{}',
  media_items TEXT DEFAULT '[]',
  plus_code TEXT DEFAULT '',
  attributes TEXT DEFAULT '[]',
  accessibility_attributes TEXT DEFAULT '[]',
  next_opening_text TEXT DEFAULT '',
  next_open_day TEXT DEFAULT '',
  next_open_time TEXT DEFAULT '',
  visible_photos_count TEXT DEFAULT '',
  postal_code TEXT DEFAULT '',
  country TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  source_place_id TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  popular_times TEXT DEFAULT '{}',
  rating_distribution TEXT DEFAULT '{}',
  review_highlights TEXT DEFAULT '[]',
  field_status TEXT DEFAULT '{}',
  collected_at TEXT NOT NULL
);

-- ============================================================================
-- Table: api_credentials
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_credentials (
  id TEXT PRIMARY KEY,
  consumer_name TEXT NOT NULL,
  consumer_project TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================================
-- Table: projects
-- ============================================================================
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  consumer_project TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (consumer_project, normalized_name)
);

-- ============================================================================
-- Table: search_categories
-- ============================================================================
CREATE TABLE IF NOT EXISTS search_categories (
  id TEXT PRIMARY KEY,
  consumer_project TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (consumer_project, normalized_name)
);

-- ============================================================================
-- Table: run_reports
-- ============================================================================
CREATE TABLE IF NOT EXISTS run_reports (
  job_id TEXT PRIMARY KEY REFERENCES searches(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_places_job_id ON places (job_id);
CREATE INDEX IF NOT EXISTS idx_api_credentials_status ON api_credentials (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_credentials_active_project ON api_credentials (consumer_project) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_places_maps_url ON places (maps_url);
CREATE INDEX IF NOT EXISTS idx_projects_scope ON projects (consumer_project, normalized_name);
CREATE INDEX IF NOT EXISTS idx_search_categories_scope ON search_categories (consumer_project, normalized_name);
CREATE INDEX IF NOT EXISTS idx_searches_user_id ON searches (user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects (user_id);
CREATE INDEX IF NOT EXISTS idx_search_categories_user_id ON search_categories (user_id);

-- ============================================================================
-- Default data - Admin user creation
-- ============================================================================
-- Admin user is created via Supabase Auth signup. This row is populated when
-- the first admin registers. The role is stored in the users table.
-- Password: admin123 should be hashed on registration in production.

INSERT INTO users (id, email, display_name, role, created_at)
VALUES ('00000000-0000-0000-0000-000000000000', 'admin@mapscrape.local', 'Administrador', 'admin', NOW())
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- Row Level Security (RLS) Policies
-- ============================================================================
-- These policies ensure data isolation per user.
-- In production, uncomment and adjust as needed.

-- Users table: allow authenticated users to read their own profile
-- DROP POLICY IF EXISTS "Users can read own profile" ON users;
-- CREATE POLICY "Users can read own profile" ON users FOR SELECT TO authenticated USING (auth.uid() = id);

-- Searches (jobs): allow users to read/write their own jobs
-- DROP POLICY IF EXISTS "Users can CRUD own searches" ON searches;
-- CREATE POLICY "Users can CRUD own searches" ON searches FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Places: allow users to read/write places in their own jobs
-- DROP POLICY IF EXISTS "Users can CRUD own places" ON places;
-- CREATE POLICY "Users can CRUD own places" ON places FOR ALL TO authenticated USING (
--   EXISTS (SELECT 1 FROM searches s WHERE s.id = places.job_id AND s.user_id = auth.uid())
-- );

-- Projects: allow users to CRUD their own projects
-- DROP POLICY IF EXISTS "Users can CRUD own projects" ON projects;
-- CREATE POLICY "Users can CRUD own projects" ON projects FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Search categories: allow users to CRUD their own categories
-- DROP POLICY IF EXISTS "Users can CRUD own categories" ON search_categories;
-- CREATE POLICY "Users can CRUD own categories" ON search_categories FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- API credentials: allow users to read/write their own credentials
-- DROP POLICY IF EXISTS "Users can CRUD own api_credentials" ON api_credentials;
-- CREATE POLICY "Users can CRUD own api_credentials" ON api_credentials FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Run reports: allow users to read their own reports
-- DROP POLICY IF EXISTS "Users can CRUD own run_reports" ON run_reports;
-- CREATE POLICY "Users can CRUD own run_reports" ON run_reports FOR ALL TO authenticated USING (job_id IN (SELECT id FROM searches WHERE user_id = auth.uid()));

-- ============================================================================
-- Triggers for updated_at
-- ============================================================================
CREATE OR REPLACE FUNCTION handle_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for projects table
DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION handle_updated_at();

-- Trigger for search_categories table
DROP TRIGGER IF EXISTS search_categories_updated_at ON search_categories;
CREATE TRIGGER search_categories_updated_at
  BEFORE UPDATE ON search_categories
  FOR EACH ROW
  EXECUTE FUNCTION handle_updated_at();