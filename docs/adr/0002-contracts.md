# ADR 0002: REST, OpenAPI, and SSE

Status: accepted

REST under `/api/v1` is the command/query interface. OpenAPI 3.1 and JSON Schema are the contract sources. Server-sent events will carry realtime UI updates because the first product flow is server-to-browser only. Events use an explicit type and version envelope.
