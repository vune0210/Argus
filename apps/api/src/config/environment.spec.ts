import { describe, expect, it } from "vitest";
import { readEnvironment } from "./environment";

describe("environment", () => {
  it("allows mock auth in development", () => {
    expect(readEnvironment({ NODE_ENV: "development", AUTH_MODE: "mock" }).authMode).toBe("mock");
  });

  it("rejects mock auth in production", () => {
    expect(() => readEnvironment({ NODE_ENV: "production", AUTH_MODE: "mock" })).toThrow(/forbidden/);
  });

  it("requires Cognito settings", () => {
    expect(() => readEnvironment({ NODE_ENV: "production", AUTH_MODE: "cognito" })).toThrow(/COGNITO/);
  });
});
