import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.PORT || 4002);

let control = {
  mode: "success", // "success" | "rate-limit" | "server-error" | "timeout"
  retryAfterSeconds: 30,
};

const deliveries = [];

function sanitizePayload(body) {
  if (!body || typeof body !== "object") return body;
  const clone = { ...body };
  // Ensure sensitive fields are stripped if present
  delete clone.secretArn;
  delete clone.authorization;
  delete clone.token;
  delete clone.webhook;
  return clone;
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";

  if (url.pathname === "/health" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (url.pathname === "/control" && method === "POST") {
    try {
      const body = await parseBody(req);
      if (body.mode) control.mode = body.mode;
      if (typeof body.retryAfterSeconds === "number") control.retryAfterSeconds = body.retryAfterSeconds;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, control }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === "/deliveries" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deliveries }));
    return;
  }

  if (url.pathname === "/deliveries" && method === "DELETE") {
    deliveries.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }

  if ((url.pathname === "/slack" || url.pathname === "/email") && method === "POST") {
    try {
      const body = await parseBody(req);
      const provider = url.pathname === "/slack" ? "SLACK" : "EMAIL";
      const record = {
        id: randomUUID(),
        deliveryId: body.deliveryId || null,
        provider,
        channelId: body.channelId || null,
        incidentId: body.incidentId || null,
        receivedAt: new Date().toISOString(),
        payload: sanitizePayload(body.payload || body),
      };

      if (control.mode === "timeout") {
        await delay(15000);
      }

      if (control.mode === "server-error") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_server_error" }));
        return;
      }

      if (control.mode === "rate-limit") {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(control.retryAfterSeconds || 30),
        });
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }

      // Success mode
      deliveries.push(record);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, receiptId: record.id }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Mock notification sink listening on http://0.0.0.0:${port}`);
});
