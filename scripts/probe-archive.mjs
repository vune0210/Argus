import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Docker's .Id may be an OCI index/manifest on containerd; inspect the saved config instead. */
export function archiveConfigDigest(archive, imageTag) {
  const read = (path) => execFileSync("tar", ["-xOf", archive, path], { maxBuffer: 4 * 1024 * 1024 });
  const entries = JSON.parse(read("manifest.json").toString("utf8"));
  const entry = entries.find((item) => item.RepoTags?.includes(imageTag));
  if (!entry || !/^(?:blobs\/sha256\/)?[a-f0-9]{64}(?:\.json)?$/.test(entry.Config)) throw new Error("Archive does not contain the expected image config");
  return `sha256:${createHash("sha256").update(read(entry.Config)).digest("hex")}`;
}
