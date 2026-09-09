DROP TABLE IF EXISTS status_page_components;
DROP TABLE IF EXISTS status_pages;
ALTER TABLE monitors DROP CONSTRAINT IF EXISTS monitors_config_kind;
ALTER TABLE monitors ADD CONSTRAINT monitors_config_http CHECK (config->>'kind' = 'http');
