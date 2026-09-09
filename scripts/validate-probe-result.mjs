import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const resultPath = process.argv[2];
if (!resultPath) throw new Error("Usage: node scripts/validate-probe-result.mjs <result.json|->");

const schema = JSON.parse(await readFile(new URL("../packages/contracts/schemas/probe-result.schema.json", import.meta.url), "utf8"));
let resultJson = "";
if (resultPath === "-") {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) resultJson += chunk;
} else {
  resultJson = await readFile(resultPath, "utf8");
}
const result = JSON.parse(resultJson);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(result)) {
  throw new Error(`ProbeResult does not match JSON Schema: ${JSON.stringify(validate.errors)}`);
}

console.log(`ProbeResult ${result.executionId} matches schema v${result.schemaVersion}.`);
