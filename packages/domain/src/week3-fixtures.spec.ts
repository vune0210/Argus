import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, reduceHealth, type Evaluation, type Observation, type HealthState } from "./index.js";

const cases = JSON.parse(readFileSync(resolve(__dirname, "../../contracts/examples/week3-evaluator.json"), "utf8")) as Array<{
  name: string; outcomes: Array<"PASS" | "FAIL" | null>; input: Omit<Evaluation, "observation">; now: number;
  expected: { observation: Observation; state: HealthState; applied: boolean };
}>;
describe("day-one shared evaluator handoff", () => {
  for (const scenario of cases) it(scenario.name, () => {
    const observation = aggregate(scenario.outcomes);
    expect(observation).toBe(scenario.expected.observation);
    const actual = reduceHealth({ ...scenario.input, observation }, scenario.now);
    expect(actual).toMatchObject({ state: scenario.expected.state, applied: scenario.expected.applied });
  });
});
