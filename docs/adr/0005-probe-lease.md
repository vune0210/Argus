# ADR 0005: Probes lease jobs over HTTPS

Status: accepted

Managed probes never receive Redis credentials. They long-poll the control plane for a bounded lease and submit results over HTTPS. The gateway acknowledges the stream entry only after accepting an idempotent result.
