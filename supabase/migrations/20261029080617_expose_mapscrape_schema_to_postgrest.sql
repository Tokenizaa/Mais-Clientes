-- Add the private MapScrape schema to PostgREST's exposed schemas while preserving
-- the standard Supabase schemas. Table access remains restricted by schema grants and RLS.
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, storage, graphql_public, mapscrape';
NOTIFY pgrst, 'reload config';
