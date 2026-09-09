# Week-two state-machine test table

| Current | Observation | Counter | Next | Incident action |
|---|---|---:|---|---|
| UNKNOWN | quorum pass | 1 | HEALTHY | none |
| HEALTHY | one region fails | 1 | DEGRADED | none |
| HEALTHY | quorum fails | 1 | PENDING_DOWN | none |
| PENDING_DOWN | quorum fails | 2 | DOWN | open once |
| PENDING_DOWN | quorum passes | 0 | HEALTHY | none |
| DOWN | quorum passes | 1 | PENDING_RECOVERY | none |
| PENDING_RECOVERY | quorum passes | 2 | HEALTHY | resolve once |
| PENDING_RECOVERY | quorum fails | 0 | DOWN | append event |

Additional tests must cover missing regions, stale/out-of-order results, duplicate results, and four transitions within ten minutes (flapping suppression for fifteen minutes).
