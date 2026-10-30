-- Seed file for Supabase with Supabase Auth
-- This runs during db reset to populate initial data

-- Ensure UUID extension if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossl";

-- Update triggers for updated_at columns
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

-- ============================================================================
-- Default data - Admin user via Supabase Auth
-- ============================================================================
-- Note: The first admin user must be created via Supabase Auth signup (email/password).
-- This SQL row serves as a profile entry once the Auth user exists.
-- The admin role is stored in the users table, linked to the Auth user by ID.

-- The admin profile will be created when the first admin registers through the app.
-- If you have the Supabase dashboard, you can create the admin user there first,
-- then this insert will match by ID.

-- ============================================================================
-- Development-only: Disable RLS (remove in production)
-- In production, enable RLS and configure policies as defined in the migration.
-- ALTER DATABASE current SET DEFAULT_ROLE = 'anon';

-- Note: In production, RLS should be enabled and policies configured per the migration.
-- For development only, you can disable RLS:
ALTER DATABASE current SET DEFAULT_ROLE = 'anon';