ALTER TABLE monitors
  ADD CONSTRAINT monitors_id_organization_unique UNIQUE (id, organization_id);

ALTER TABLE monitor_versions
  ADD CONSTRAINT monitor_versions_monitor_tenant_fk
  FOREIGN KEY (monitor_id, organization_id)
  REFERENCES monitors(id, organization_id)
  ON DELETE CASCADE;
