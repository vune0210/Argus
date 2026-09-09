import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegionalRelease } from "./check-regional-release.mjs";
const fixture = () => ["ap-southeast-1", "ap-northeast-1", "eu-central-1"].map(region => ({ region, environment: "staging", revision: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}`, image: `example/argus-probe@sha256:${"b".repeat(64)}` }));
test("release requires exactly three matching regional artifacts", () => {
  assert.equal(validateRegionalRelease(fixture()).image_digest, `sha256:${"b".repeat(64)}`);
  for (const key of ["imageDigest", "revision", "environment", "region"]) {
    const changed = fixture(); changed[1][key] = "different"; assert.throws(() => validateRegionalRelease(changed));
  }
  assert.throws(() => validateRegionalRelease(fixture().slice(1)));
});
