-- Prevent anon/authenticated clients from resolving or querying the private MapScrape schema.
REVOKE ALL ON SCHEMA mapscrape FROM PUBLIC, anon, authenticated;
GRANT USAGE, CREATE ON SCHEMA mapscrape TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA mapscrape TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mapscrape GRANT ALL ON TABLES TO service_role;
