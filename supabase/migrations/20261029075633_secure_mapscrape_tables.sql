-- No client-side policies are intentionally granted. Server-side operations use service_role.
ALTER TABLE mapscrape.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.places ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.api_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.search_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.run_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapscrape.audit_logs ENABLE ROW LEVEL SECURITY;
