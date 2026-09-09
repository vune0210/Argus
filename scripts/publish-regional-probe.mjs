import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { archiveConfigDigest } from "./probe-archive.mjs";

// Invoked only by the manually dispatched release workflow with environment approval.
if (process.env.ARGUS_PUBLISH_REGIONAL !== "true") throw new Error("Regional publishing requires ARGUS_PUBLISH_REGIONAL=true");
const { AWS_REGION: region, ARGUS_RELEASE_ENV: environment, GITHUB_SHA: revision } = process.env;
if (!["ap-southeast-1", "ap-northeast-1", "eu-central-1"].includes(region) || !["staging", "production"].includes(environment) || !/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("Invalid release identity");
const aws = (args) => JSON.parse(execFileSync("aws", [...args, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
const account = aws(["sts", "get-caller-identity"]).Account;
if (!/^\d{12}$/.test(account)) throw new Error("Invalid AWS account");
const repository = `argus-${environment}-probe`;
const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
const local = `argus-probe:${revision}`;
const remote = `${registry}/${repository}:${revision}`;
const configDigest = archiveConfigDigest("probe.tar", local);
const image = () => {
  const result = aws(["ecr", "batch-get-image", "--repository-name", repository, "--image-ids", `imageTag=${revision}`]);
  if (result.failures?.some((failure) => failure.failureCode !== "ImageNotFound")) throw new Error("Cannot inspect regional image");
  return result.images?.[0];
};
let published = image();
if (!published) {
  // A task-owned temporary Docker config avoids modifying runner/user registry credentials.
  const temporary = mkdtempSync(join(tmpdir(), "argus-probe-publish-"));
  try {
    const password = execFileSync("aws", ["ecr", "get-login-password", "--region", region], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    execFileSync("docker", ["--config", temporary, "login", "--username", "AWS", "--password-stdin", registry], { input: password, stdio: ["pipe", "pipe", "pipe"] });
    execFileSync("docker", ["tag", local, remote], { stdio: "inherit" });
    execFileSync("docker", ["--config", temporary, "push", remote], { stdio: "inherit" });
  } finally {
    if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith("argus-probe-publish-")) throw new Error("Unexpected credential temp directory");
    rmSync(temporary, { recursive: true, force: true });
  }
  published = image();
}
if (!published || JSON.parse(published.imageManifest).config?.digest !== configDigest) throw new Error("Regional tag does not contain the built artifact");
const manifest = { region, environment, revision, imageDigest: published.imageId.imageDigest, image: `${registry}/${repository}@${published.imageId.imageDigest}` };
writeFileSync(`release-${region}.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));
