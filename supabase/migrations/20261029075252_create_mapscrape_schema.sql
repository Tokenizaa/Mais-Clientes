-- Isolate MapScrape tables from the shared public schema.
CREATE SCHEMA IF NOT EXISTS mapscrape;
GRANT USAGE ON SCHEMA mapscrape TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA mapscrape TO service_role;
