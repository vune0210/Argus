# ADR 0004: Redis Streams for asynchronous delivery

Status: accepted

Beginning in week two, regional jobs and domain events use Redis Streams consumer groups. Delivery is at least once; consumers are idempotent, reclaim expired pending work, and send poison messages to a dead-letter stream.
