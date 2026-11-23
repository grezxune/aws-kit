import { describe, expect, test } from "bun:test";
import { runSteps, type Step, summarize } from "../../src/core/steps";

function step(id: string, needed: boolean, options: { manual?: boolean; fail?: boolean } = {}): Step & { applied: number } {
  const result = {
    id,
    applied: 0,
    async check() {
      if (options.fail) throw new Error("boom");
      return { needed, detail: `${id} detail`, manual: options.manual };
    },
    async apply() {
      result.applied += 1;
      return `${id} done`;
    },
  };
  return result;
}

describe("runSteps", () => {
  test("only reports without apply", async () => {
    const pending = step("a", true);
    const results = await runSteps([pending, step("b", false)], { apply: false });
    expect(results.map((result) => result.action)).toEqual(["would-change", "none"]);
    expect(pending.applied).toBe(0);
  });

  test("applies only what is needed", async () => {
    const pending = step("a", true);
    const done = step("b", false);
    const results = await runSteps([pending, done], { apply: true });
    expect(results.map((result) => result.action)).toEqual(["changed", "none"]);
    expect([pending.applied, done.applied]).toEqual([1, 0]);
  });

  test("never applies a manual step and stops at a failure", async () => {
    const manual = step("a", true, { manual: true });
    const results = await runSteps([manual, step("b", true, { fail: true }), step("c", true)], { apply: true });
    expect(results.map((result) => result.action)).toEqual(["manual", "failed"]);
    expect(manual.applied).toBe(0);
    expect(summarize(results)).toEqual({ changed: false, pending: ["a"], failed: ["b"] });
  });
});
