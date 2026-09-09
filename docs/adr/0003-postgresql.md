# ADR 0003: PostgreSQL is the source of truth

Status: accepted

PostgreSQL stores tenants, monitor versions, executions, results, incidents, and the transactional outbox. High-volume results will use time-range partitions and rollups. Redis never becomes the authoritative product store.
