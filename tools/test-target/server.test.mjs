import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createTarget } from "./server.mjs";

async function target(t, controlEnabled) {
  const server = createTarget({ controlEnabled }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return (path, method = "GET") => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
}
test("same check URL supports healthy, slow, down and recovery without changing the monitor", async (t) => {
  const request = await target(t, true);
  assert.equal((await request("/check")).status, 200);
  assert.equal((await request("/__control?mode=slow&delayMs=50", "POST")).status, 200);
  const started = performance.now();
  assert.equal((await (await request("/check")).json()).status, "slow");
  assert.ok(performance.now() - started >= 40);
  await request("/__control?mode=down", "POST");
  assert.equal((await request("/check")).status, 503);
  assert.equal((await request("/healthy")).status, 200);
  await request("/__control?mode=healthy", "POST");
  assert.equal((await request("/check")).status, 200);
});
test("control is opt-in, method-restricted and bounded", async (t) => {
  const disabled = await target(t, false);
  assert.equal((await disabled("/__control?mode=down", "POST")).status, 404);
  const enabled = await target(t, true);
  assert.equal((await enabled("/__control?mode=down")).status, 405);
  for (const query of ["mode=invalid", "mode=slow&delayMs=NaN", "mode=slow&delayMs=-1", "mode=slow&delayMs=10001"]) {
    assert.equal((await enabled(`/__control?${query}`, "POST")).status, 400);
  }
});
