-- MapScrape v2 persistence. All objects are explicitly scoped to mapscrape.
CREATE TABLE IF NOT EXISTS mapscrape.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mapscrape.searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  project_id TEXT,
  category_id TEXT
);

CREATE TABLE IF NOT EXISTS mapscrape.places (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES mapscrape.searches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  review_count TEXT NOT NULL DEFAULT '',
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
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mapscrape.api_credentials (
  id TEXT PRIMARY KEY,
  consumer_name TEXT NOT NULL,
  consumer_project TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mapscrape.projects (
  id TEXT PRIMARY KEY,
  consumer_project TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (consumer_project, normalized_name)
);

CREATE TABLE IF NOT EXISTS mapscrape.search_categories (
  id TEXT PRIMARY KEY,
  consumer_project TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (consumer_project, normalized_name)
);

CREATE TABLE IF NOT EXISTS mapscrape.run_reports (
  job_id TEXT PRIMARY KEY REFERENCES mapscrape.searches(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mapscrape.audit_logs (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  job_id TEXT DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mapscrape_searches_user_id ON mapscrape.searches(user_id);
CREATE INDEX IF NOT EXISTS idx_mapscrape_places_job_id ON mapscrape.places(job_id);
CREATE INDEX IF NOT EXISTS idx_mapscrape_places_maps_url ON mapscrape.places(maps_url);
CREATE INDEX IF NOT EXISTS idx_mapscrape_api_credentials_status ON mapscrape.api_credentials(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mapscrape_api_credentials_active_project
  ON mapscrape.api_credentials(consumer_project) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_mapscrape_projects_scope ON mapscrape.projects(consumer_project, normalized_name);
CREATE INDEX IF NOT EXISTS idx_mapscrape_projects_user_id ON mapscrape.projects(user_id);
CREATE INDEX IF NOT EXISTS idx_mapscrape_search_categories_scope ON mapscrape.search_categories(consumer_project, normalized_name);
CREATE INDEX IF NOT EXISTS idx_mapscrape_search_categories_user_id ON mapscrape.search_categories(user_id);
CREATE INDEX IF NOT EXISTS idx_mapscrape_run_reports_job_id ON mapscrape.run_reports(job_id);
CREATE INDEX IF NOT EXISTS idx_mapscrape_audit_logs_created_at ON mapscrape.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mapscrape_audit_logs_job_id ON mapscrape.audit_logs(job_id);

CREATE OR REPLACE FUNCTION mapscrape.handle_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_updated_at ON mapscrape.projects;
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON mapscrape.projects
FOR EACH ROW EXECUTE FUNCTION mapscrape.handle_updated_at();

DROP TRIGGER IF EXISTS search_categories_updated_at ON mapscrape.search_categories;
CREATE TRIGGER search_categories_updated_at BEFORE UPDATE ON mapscrape.search_categories
FOR EACH ROW EXECUTE FUNCTION mapscrape.handle_updated_at();
