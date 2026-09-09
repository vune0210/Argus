# Argus domain glossary

- **Organization**: tenant boundary. Every operational resource belongs to exactly one organization.
- **Monitor**: versioned definition of a check. Week one implements HTTP monitors only.
- **Execution**: one scheduled or manually requested evaluation window for a monitor.
- **Probe**: managed agent that executes jobs from a declared region.
- **Probe job**: immutable execution instruction containing the monitor version and bounded check configuration.
- **Probe result**: normalized observation returned by one probe for one execution.
- **Health state**: `UNKNOWN`, `HEALTHY`, `DEGRADED`, `PENDING_DOWN`, `DOWN`, or `PENDING_RECOVERY`.
- **Incident**: deduplicated operational record opened after a monitor satisfies a failure policy.
- **UTC timestamp**: RFC 3339 timestamp used in persistence and contracts. Display timezone is an IANA timezone.
- **Public API version**: major version in the path (`/api/v1`); contract changes remain backward compatible within v1.

Identifiers are UUIDs. Durations are integer milliseconds. API and event timestamps are RFC 3339 UTC strings.
- **Execution target**: one region's work for an immutable execution snapshot.
- **Lease**: a 45-second, probe-owned delivery attempt fenced by its unique ID.
- **Receipt**: stable acknowledgement of a committed result; matching redelivery returns the same ID.
- **Diagnostic execution**: a manual run that records observations without updating monitor health.
- **Insufficient results**: at least one missing region with explicit failures below majority quorum.
- **Outbox**: PostgreSQL transactionally persisted transport work, retried until Redis accepts it.
