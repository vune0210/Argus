import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { checkGeneratedContracts } from "./generate-contracts.mjs";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const jobSchema = await readJson("packages/contracts/schemas/probe-job.schema.json");
const resultSchema = await readJson("packages/contracts/schemas/probe-result.schema.json");
const eventSchema = await readJson("packages/contracts/schemas/event-envelope.schema.json");
const example = await readJson("packages/contracts/examples/probe-job.local.json");
const dockerExample = await readJson("packages/contracts/examples/probe-job.docker.json");
const tcpJobExample = await readJson("packages/contracts/examples/probe-job.tcp.json");
const sslJobExample = await readJson("packages/contracts/examples/probe-job.ssl.json");
const keywordJobExample = await readJson("packages/contracts/examples/probe-job.keyword.json");
const resultExample = await readJson("packages/contracts/examples/probe-result.pass.json");
const tcpResultExample = await readJson("packages/contracts/examples/probe-result.tcp.json");
const sslResultExample = await readJson("packages/contracts/examples/probe-result.ssl.json");
const keywordResultExample = await readJson("packages/contracts/examples/probe-result.keyword.json");
const eventExample = await readJson("packages/contracts/examples/event-envelope.json");
const openapi = await readJson("packages/contracts/openapi/argus-v0.2.json");
const regional = await readJson("packages/contracts/examples/week3-three-region.json");
const publicStatusExample = await readJson("packages/contracts/examples/public-status-page.json");
const week4Day1Fixtures = await readJson("packages/contracts/examples/week4-day1-fixtures.json");
const goModels = await readFile(new URL("agents/probe/internal/contracts/models.gen.go", root), "utf8");
const tsModels = await readFile(new URL("packages/contracts/src/index.ts", root), "utf8");

await checkGeneratedContracts();

assert.equal(openapi.openapi, "3.1.0");
assert.ok(
  jobSchema.properties.schemaVersion.enum
    ? jobSchema.properties.schemaVersion.enum.includes(example.schemaVersion)
    : example.schemaVersion === jobSchema.properties.schemaVersion.const,
);
assert.equal(example.config.kind, jobSchema.$defs.httpMonitorConfig.properties.kind.const);
for (const field of jobSchema.required) assert.ok(field in example, `ProbeJob example is missing ${field}`);
for (const field of jobSchema.required) assert.ok(field in dockerExample, `Docker ProbeJob example is missing ${field}`);
for (const field of jobSchema.required) assert.ok(field in tcpJobExample, `TCP ProbeJob example is missing ${field}`);
for (const field of jobSchema.required) assert.ok(field in sslJobExample, `SSL ProbeJob example is missing ${field}`);
for (const field of jobSchema.required) assert.ok(field in keywordJobExample, `Keyword ProbeJob example is missing ${field}`);

assert.deepEqual(
  resultSchema.properties.outcome.enum,
  ["PASS", "FAIL"],
  "ProbeResult outcome contract changed unexpectedly",
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateJob = ajv.compile(jobSchema);
const validateResult = ajv.compile(resultSchema);
const validateEvent = ajv.compile(eventSchema);

assert.ok(validateJob(example), `Local ProbeJob does not match JSON Schema: ${JSON.stringify(validateJob.errors)}`);
assert.ok(validateJob(dockerExample), `Docker ProbeJob does not match JSON Schema: ${JSON.stringify(validateJob.errors)}`);
assert.ok(validateJob(tcpJobExample), `TCP ProbeJob does not match JSON Schema: ${JSON.stringify(validateJob.errors)}`);
assert.ok(validateJob(sslJobExample), `SSL ProbeJob does not match JSON Schema: ${JSON.stringify(validateJob.errors)}`);
assert.ok(validateJob(keywordJobExample), `Keyword ProbeJob does not match JSON Schema: ${JSON.stringify(validateJob.errors)}`);

assert.ok(validateResult(resultExample), `ProbeResult example does not match JSON Schema: ${JSON.stringify(validateResult.errors)}`);
assert.ok(validateResult(tcpResultExample), `TCP ProbeResult example does not match JSON Schema: ${JSON.stringify(validateResult.errors)}`);
assert.ok(validateResult(sslResultExample), `SSL ProbeResult example does not match JSON Schema: ${JSON.stringify(validateResult.errors)}`);
assert.ok(validateResult(keywordResultExample), `Keyword ProbeResult example does not match JSON Schema: ${JSON.stringify(validateResult.errors)}`);
assert.ok(validateEvent(eventExample), `EventEnvelope example does not match JSON Schema: ${JSON.stringify(validateEvent.errors)}`);

// Validate wire fixtures consumed by Go, API and UI tests.
const definitions = JSON.parse(JSON.stringify(openapi.components.schemas).replaceAll("#/components/schemas/", "#/$defs/"));
definitions.ProbeJob = { $ref: jobSchema.$id };
definitions.ProbeResult = { $ref: resultSchema.$id };
ajv.addSchema({ $id: "urn:argus:api", $defs: definitions });

for (const [name, values] of Object.entries({
  ProbeLease: regional.leases,
  ResultReceipt: [regional.receipt],
  MonitorSnapshot: Object.values(regional.snapshots),
})) {
  const validate = ajv.compile({ $ref: `urn:argus:api#/$defs/${name}` });
  for (const value of values) assert.ok(validate(value), `${name}: ${JSON.stringify(validate.errors)}`);
}

// Validate Week 4 Day 1 fixtures
const validatePublicStatus = ajv.compile({ $ref: "urn:argus:api#/$defs/PublicStatusPage" });
assert.ok(validatePublicStatus(publicStatusExample), `PublicStatusPage example error: ${JSON.stringify(validatePublicStatus.errors)}`);

const validateIncident = ajv.compile({ $ref: "urn:argus:api#/$defs/Incident" });
for (const incident of Object.values(week4Day1Fixtures.incidentStates)) {
  assert.ok(validateIncident(incident), `Week 4 Incident error: ${JSON.stringify(validateIncident.errors)}`);
}

const validateChannel = ajv.compile({ $ref: "urn:argus:api#/$defs/NotificationChannel" });
for (const channel of week4Day1Fixtures.notificationChannels) {
  assert.ok(validateChannel(channel), `Week 4 Channel error: ${JSON.stringify(validateChannel.errors)}`);
}

const validateEscalation = ajv.compile({ $ref: "urn:argus:api#/$defs/EscalationPolicy" });
assert.ok(validateEscalation(week4Day1Fixtures.escalationPolicy), `Week 4 Escalation error: ${JSON.stringify(validateEscalation.errors)}`);

const validateDelivery = ajv.compile({ $ref: "urn:argus:api#/$defs/NotificationDelivery" });
for (const delivery of week4Day1Fixtures.deliveries) {
  assert.ok(validateDelivery(delivery), `Week 4 Delivery error: ${JSON.stringify(validateDelivery.errors)}`);
}

for (const value of regional.results) assert.ok(validateResult(value), JSON.stringify(validateResult.errors));
for (const value of regional.events) assert.ok(validateEvent(value), JSON.stringify(validateEvent.errors));
assert.equal(new Set(regional.leases.map((lease) => lease.job.executionId)).size, 1);
assert.equal(new Set(regional.leases.map((lease) => lease.targetRegion)).size, 3);
for (const [index, lease] of regional.leases.entries()) {
  assert.equal(lease.targetRegion, regional.results[index].region);
  assert.equal(lease.job.executionId, regional.results[index].executionId);
}

for (const path of [
  "/health/live",
  "/health/ready",
  "/api/v1/auth/bootstrap",
  "/api/v1/monitors",
  "/api/v1/monitors/{id}",
  "/api/v1/monitors/{id}/run",
  "/api/v1/monitors/{id}/executions",
  "/api/v1/monitors/{id}/snapshot",
  "/api/v1/executions/{id}",
  "/api/v1/incidents",
  "/api/v1/incidents/{id}",
  "/api/v1/incidents/{id}/ack",
  "/api/v1/incidents/{id}/resolve",
  "/api/v1/notification-channels",
  "/api/v1/notification-channels/{id}",
  "/api/v1/escalation-policy",
  "/api/v1/status-pages",
  "/api/v1/status-pages/{id}",
  "/api/v1/status-pages/{id}/components",
  "/api/public/v1/status-pages/{slug}",
  "/api/v1/probe-leases",
  "/api/v1/probe-leases/{id}/heartbeat",
  "/api/v1/probe-leases/{id}/result",
  "/api/v1/organizations/{organizationId}/events",
]) {
  assert.ok(openapi.paths[path], `OpenAPI is missing ${path}`);
}

assert.ok(tsModels.includes('from "./probe.gen"'), "TypeScript contract entry point does not export generated probe models");
for (const field of ["ExecutionID", "OrganizationID", "MonitorID", "MonitorVersion", "ProbeID", "Region", "Outcome"]) {
  assert.ok(goModels.includes(field), `Go contract is missing ${field}`);
}

console.log("Contract checks passed (OpenAPI 3.1, ProbeJob v0.2, ProbeResult v0.2, EventEnvelope v1, Week 4 Day 1 fixtures).");
