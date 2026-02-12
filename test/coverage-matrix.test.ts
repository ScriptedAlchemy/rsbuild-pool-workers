import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@rstest/core";

function readTestTitles(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const matches = source.matchAll(/test\("([^"]+)"/g);
  return Array.from(matches, (match) => match[1]);
}

function expectSuffixCoverage(
  titles: string[],
  prefix: string,
  expectedSuffixes: string[]
): void {
  const found = new Set(
    titles.filter((title) => title.startsWith(prefix)).map((title) => title.slice(prefix.length))
  );
  expect(found.size).toBeGreaterThanOrEqual(expectedSuffixes.length);
  for (const suffix of expectedSuffixes) {
    expect(found.has(suffix)).toBe(true);
  }
}

describe("invalid workers options diagnostics coverage matrix", () => {
  test("covers config-function invalid-return variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));
    const expectedUnitSuffixes = [
      "invalid options",
      "null",
      "string",
      "array",
      "undefined",
      "boolean",
      "number"
    ];

    const prefixes = [
      "throws actionable error for sync config function exports when top-level workers function returns ",
      "throws actionable error for sync config function exports when nested workers function returns ",
      "propagates rejection for async config function exports when top-level workers function returns ",
      "propagates rejection for async config function exports when nested workers function returns ",
      "propagates rejection for promise-returning config function exports when top-level workers function returns ",
      "propagates rejection for promise-returning config function exports when nested workers function returns ",
      "propagates rejection for thenable-returning config function exports when top-level workers function returns ",
      "propagates rejection for thenable-returning config function exports when nested workers function returns ",
      "defineWorkersProject throws actionable error for sync config function exports when top-level workers function returns ",
      "defineWorkersProject throws actionable error for sync config function exports when nested workers function returns ",
      "defineWorkersProject propagates rejection for async config function exports when top-level workers function returns ",
      "defineWorkersProject propagates rejection for async config function exports when nested workers function returns ",
      "defineWorkersProject propagates rejection for promise-returning config function exports when top-level workers function returns ",
      "defineWorkersProject propagates rejection for promise-returning config function exports when nested workers function returns ",
      "defineWorkersProject propagates rejection for thenable-returning config function exports when top-level workers function returns ",
      "defineWorkersProject propagates rejection for thenable-returning config function exports when nested workers function returns "
    ];

    for (const prefix of prefixes) {
      expectSuffixCoverage(titles, prefix, expectedUnitSuffixes);
    }
  });

  test("covers config-function invalid-return variants in e2e suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "e2e-cli.test.ts"));
    const expectedE2eSuffixes = [
      "function return options end-to-end",
      "null return options end-to-end",
      "string return options end-to-end",
      "array return options end-to-end",
      "undefined return options end-to-end",
      "boolean return options end-to-end",
      "number return options end-to-end"
    ];

    const prefixes = [
      "surfaces sync config function export invalid top-level workers ",
      "surfaces sync config function export invalid nested workers ",
      "surfaces async config function export invalid top-level workers ",
      "surfaces async config function export invalid nested workers ",
      "surfaces promise-returning config function export invalid top-level workers ",
      "surfaces promise-returning config function export invalid nested workers ",
      "surfaces thenable config function export invalid top-level workers ",
      "surfaces thenable config function export invalid nested workers ",
      "surfaces defineWorkersProject sync config function export invalid top-level workers ",
      "surfaces defineWorkersProject sync config function export invalid nested workers ",
      "surfaces defineWorkersProject async config function export invalid top-level workers ",
      "surfaces defineWorkersProject async config function export invalid nested workers ",
      "surfaces defineWorkersProject promise-returning config function export invalid top-level workers ",
      "surfaces defineWorkersProject promise-returning config function export invalid nested workers ",
      "surfaces defineWorkersProject thenable config function export invalid top-level workers ",
      "surfaces defineWorkersProject thenable config function export invalid nested workers "
    ];

    for (const prefix of prefixes) {
      expectSuffixCoverage(titles, prefix, expectedE2eSuffixes);
    }
  });
});
