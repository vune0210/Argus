import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RequestMethod } from "@nestjs/common";
import { HealthController } from "../health/health.controller";
import { AuthController } from "../auth/auth.controller";
import { MonitorsController } from "../monitors/monitors.controller";
import { PipelineController, ProbeController } from "../pipeline/pipeline.controller";
import { EventsController } from "../pipeline/events.controller";
import { NotificationsController } from "../notifications/notifications.controller";
import { StatusPagesController } from "../status-pages/status-pages.controller";
import { PublicStatusPagesController } from "../status-pages/public-status-pages.controller";

const controllers = [
  HealthController,
  AuthController,
  MonitorsController,
  PipelineController,
  ProbeController,
  EventsController,
  NotificationsController,
  StatusPagesController,
  PublicStatusPagesController,
];

const methodNames: Record<number, string> = {
  [RequestMethod.GET]: "get",
  [RequestMethod.POST]: "post",
  [RequestMethod.PUT]: "put",
  [RequestMethod.DELETE]: "delete",
  [RequestMethod.PATCH]: "patch",
};

function getControllerRoutes(): Array<{ method: string; path: string; deprecated?: boolean; target: any }> {
  const routes: Array<{ method: string; path: string; deprecated?: boolean; target: any }> = [];

  for (const ControllerClass of controllers) {
    const controllerPath = (Reflect.getMetadata("path", ControllerClass) as string) || "";
    const prototype = ControllerClass.prototype;

    for (const prop of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, prop);
      if (!descriptor || typeof descriptor.value !== "function") continue;

      const methodPath = Reflect.getMetadata("path", descriptor.value) as string | undefined;
      const methodEnum = Reflect.getMetadata("method", descriptor.value) as number | undefined;

      if (methodPath === undefined || methodEnum === undefined) continue;

      const httpMethod = methodNames[methodEnum];
      if (!httpMethod) continue;

      const segments = [controllerPath, methodPath]
        .map((s) => s.replace(/^\/|\/$/g, ""))
        .filter(Boolean);
      const fullPath = "/" + segments.join("/");
      const normalizedPath = fullPath.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");

      const headers = Reflect.getMetadata("__headers__", descriptor.value) as Array<{ name: string; value: string }> | undefined;
      const hasDeprecationHeader = headers?.some((h) => h.name.toLowerCase() === "deprecation" && h.value === "true");

      routes.push({
        method: httpMethod,
        path: normalizedPath,
        deprecated: hasDeprecationHeader,
        target: descriptor.value,
      });
    }
  }

  return routes;
}

describe("OpenAPI / Nest Controller route conformance", () => {
  const openapiPath = resolve(__dirname, "../../../../packages/contracts/openapi/argus-v0.2.json");
  const openapi = JSON.parse(readFileSync(openapiPath, "utf8"));
  const controllerRoutes = getControllerRoutes();

  it("every OpenAPI operation exists in Nest controllers", () => {
    const missing: string[] = [];

    for (const [path, pathItem] of Object.entries(openapi.paths as Record<string, any>)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (["parameters", "$ref", "summary", "description"].includes(method)) continue;

        const found = controllerRoutes.some(
          (r) => r.path === path && r.method.toLowerCase() === method.toLowerCase(),
        );

        if (!found) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("deprecated aliases in OpenAPI have Deprecation header on Nest controllers", () => {
    const deprecatedOpenApiRoutes: Array<{ method: string; path: string }> = [];

    for (const [path, pathItem] of Object.entries(openapi.paths as Record<string, any>)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (["parameters", "$ref"].includes(method)) continue;
        if (operation.deprecated) {
          deprecatedOpenApiRoutes.push({ method: method.toLowerCase(), path });
        }
      }
    }

    expect(deprecatedOpenApiRoutes.length).toBeGreaterThan(0);

    for (const dep of deprecatedOpenApiRoutes) {
      const match = controllerRoutes.find(
        (r) => r.path === dep.path && r.method.toLowerCase() === dep.method,
      );
      expect(match).toBeDefined();
      expect(match?.deprecated).toBe(true);
    }
  });

  it("includes /monitors/{id}/evaluate and /monitors/{id}/timeseries in OpenAPI and controllers", () => {
    expect(openapi.paths["/api/v1/monitors/{id}/evaluate"]?.post).toBeDefined();
    expect(openapi.paths["/api/v1/monitors/{id}/timeseries"]?.get).toBeDefined();

    const evaluateRoute = controllerRoutes.find(
      (r) => r.path === "/api/v1/monitors/{id}/evaluate" && r.method === "post",
    );
    expect(evaluateRoute).toBeDefined();

    const timeseriesRoute = controllerRoutes.find(
      (r) => r.path === "/api/v1/monitors/{id}/timeseries" && r.method === "get",
    );
    expect(timeseriesRoute).toBeDefined();
  });
});
