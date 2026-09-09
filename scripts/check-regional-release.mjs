import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function validateRegionalRelease(releases) {
  const regions = ["ap-southeast-1", "ap-northeast-1", "eu-central-1"];
  assert.deepEqual(releases.map((r) => r.region).sort(), [...regions].sort(), "Missing or duplicate region");
  assert.equal(new Set(releases.map((r) => r.imageDigest)).size, 1, "Manifest digests differ across regions");
  assert.equal(new Set(releases.map((r) => r.revision)).size, 1, "Source revisions differ across regions");
  assert.equal(new Set(releases.map((r) => r.environment)).size, 1, "Environments differ across regions");
  for (const release of releases) {
    assert.match(release.imageDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(release.revision, /^[a-f0-9]{40}$/);
    assert.ok(["staging", "production"].includes(release.environment));
    assert.ok(release.image.endsWith(`@${release.imageDigest}`));
  }
  return { image_digest: releases[0].imageDigest };
}
if (process.argv[1]?.endsWith("check-regional-release.mjs")) {
  const manifests = ["ap-southeast-1", "ap-northeast-1", "eu-central-1"].map(region => JSON.parse(readFileSync(`release-${region}.json`, "utf8")));
  console.log(JSON.stringify(validateRegionalRelease(manifests), null, 2));
}
