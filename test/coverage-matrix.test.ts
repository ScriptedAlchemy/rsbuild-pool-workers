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

function expectTitleCoverage(titles: string[], expectedTitles: string[]): void {
  const titleSet = new Set(titles);
  for (const title of expectedTitles) {
    expect(titleSet.has(title)).toBe(true);
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

  test("covers direct promise/promise-like invalid-return variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));

    const expectations: Array<{ prefix: string; suffixes: string[] }> = [
      {
        prefix: "propagates actionable error when promise top-level workers function returns ",
        suffixes: ["invalid options", "null", "undefined", "an array", "a boolean", "a number"]
      },
      {
        prefix: "propagates actionable error when promise nested workers function returns ",
        suffixes: ["invalid options", "an array", "a string", "a boolean", "a number", "null"]
      },
      {
        prefix: "defineWorkersProject propagates actionable error when promise top-level workers function returns ",
        suffixes: ["invalid options", "null", "undefined", "an array", "a boolean", "a number"]
      },
      {
        prefix: "defineWorkersProject propagates actionable error when promise nested workers function returns ",
        suffixes: ["invalid options", "an array", "a string", "a boolean", "a number", "null"]
      },
      {
        prefix: "propagates actionable error from promise-like top-level workers function ",
        suffixes: [
          "invalid options",
          "null return",
          "boolean return",
          "undefined return",
          "array return",
          "number return"
        ]
      },
      {
        prefix: "propagates actionable error from promise-like nested workers function ",
        suffixes: [
          "invalid options",
          "array return",
          "boolean return",
          "string return",
          "null return",
          "number return"
        ]
      },
      {
        prefix: "defineWorkersProject propagates actionable error from promise-like top-level workers function ",
        suffixes: [
          "invalid options",
          "null return",
          "boolean return",
          "undefined return",
          "array return",
          "number return"
        ]
      },
      {
        prefix: "defineWorkersProject propagates actionable error from promise-like nested workers function ",
        suffixes: [
          "invalid options",
          "array return",
          "boolean return",
          "string return",
          "null return",
          "number return"
        ]
      }
    ];

    for (const { prefix, suffixes } of expectations) {
      expectSuffixCoverage(titles, prefix, suffixes);
    }
  });

  test("covers direct promise/promise-like invalid-return variants in e2e suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "e2e-cli.test.ts"));

    const expectations: Array<{ prefix: string; suffixes: string[] }> = [
      {
        prefix: "surfaces promise config export top-level workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "null return invalid options errors end-to-end",
          "undefined return invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end"
        ]
      },
      {
        prefix: "surfaces promise config export nested workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "string return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end",
          "null return invalid options errors end-to-end"
        ]
      },
      {
        prefix: "surfaces defineWorkersProject promise export top-level workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "null return invalid options errors end-to-end",
          "undefined return invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end"
        ]
      },
      {
        prefix: "surfaces defineWorkersProject promise export nested workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "string return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end",
          "null return invalid options errors end-to-end"
        ]
      },
      {
        prefix: "surfaces promise-like top-level workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "null return invalid options errors end-to-end",
          "undefined return invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end"
        ]
      },
      {
        prefix: "surfaces promise-like nested workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "string return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end",
          "null return invalid options errors end-to-end"
        ]
      },
      {
        prefix: "surfaces defineWorkersProject promise-like top-level workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "null return invalid options errors end-to-end",
          "undefined return invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end"
        ]
      },
      {
        prefix: "surfaces defineWorkersProject promise-like nested workers ",
        suffixes: [
          "invalid options errors end-to-end",
          "array return invalid options errors end-to-end",
          "string return invalid options errors end-to-end",
          "boolean return invalid options errors end-to-end",
          "number return invalid options errors end-to-end",
          "null return invalid options errors end-to-end"
        ]
      }
    ];

    for (const { prefix, suffixes } of expectations) {
      expectSuffixCoverage(titles, prefix, suffixes);
    }
  });

  test("covers undefined-top-level fallback variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));
    expectTitleCoverage(titles, [
      "sync config function falls back to nested workers when top-level workers is undefined",
      "sync config function falls back to nested workers function when top-level workers is undefined",
      "async config function exports fall back to nested workers when top-level workers is undefined",
      "async config function exports fall back to nested workers function when top-level workers is undefined",
      "promise-returning config function exports fall back to nested workers when top-level workers is undefined",
      "promise-returning config function exports fall back to nested workers function when top-level workers is undefined",
      "thenable-returning config function exports fall back to nested workers when top-level workers is undefined",
      "thenable-returning config function exports fall back to nested workers function when top-level workers is undefined",
      "promise-like exports fall back to nested workers when top-level workers is undefined",
      "promise-like exports fall back to nested workers function when top-level workers is undefined",
      "promise exports fall back to nested workers when top-level workers is undefined",
      "promise exports fall back to nested workers function when top-level workers is undefined",
      "defineWorkersProject sync config function falls back to nested workers when top-level workers is undefined",
      "defineWorkersProject sync config function falls back to nested workers function when top-level workers is undefined",
      "defineWorkersProject async config exports fall back to nested workers when top-level workers is undefined",
      "defineWorkersProject async config exports fall back to nested workers function when top-level workers is undefined",
      "defineWorkersProject promise-returning config function exports fall back to nested workers when top-level workers is undefined",
      "defineWorkersProject promise-returning config function exports fall back to nested workers function when top-level workers is undefined",
      "defineWorkersProject thenable-returning config function exports fall back to nested workers when top-level workers is undefined",
      "defineWorkersProject thenable-returning config function exports fall back to nested workers function when top-level workers is undefined",
      "defineWorkersProject promise-like exports fall back to nested workers when top-level workers is undefined",
      "defineWorkersProject promise-like exports fall back to nested workers function when top-level workers is undefined",
      "defineWorkersProject promise exports fall back to nested workers when top-level workers is undefined",
      "defineWorkersProject promise exports fall back to nested workers function when top-level workers is undefined"
    ]);
  });

  test("covers undefined-top-level fallback variants in e2e suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "e2e-cli.test.ts"));
    expectTitleCoverage(titles, [
      "falls back to nested workers when defineWorkersConfig top-level workers is undefined end-to-end",
      "falls back to nested workers function when defineWorkersConfig top-level workers is undefined end-to-end",
      "falls back to nested workers for async config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function for async config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers for promise-returning config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function for promise-returning config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers for thenable config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function for thenable config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers in promise-like config exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function in promise-like config exports when top-level workers is undefined end-to-end",
      "falls back to nested workers in promise config exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function in promise config exports when top-level workers is undefined end-to-end",
      "falls back to nested workers when defineWorkersProject top-level workers is undefined end-to-end",
      "falls back to nested workers function when defineWorkersProject top-level workers is undefined end-to-end",
      "falls back to nested workers for defineWorkersProject async config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function for defineWorkersProject async config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers for defineWorkersProject promise-returning config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function for defineWorkersProject promise-returning config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers for defineWorkersProject thenable config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function for defineWorkersProject thenable config function exports when top-level workers is undefined end-to-end",
      "falls back to nested workers in defineWorkersProject promise-like exports when top-level workers is undefined end-to-end",
      "falls back to nested workers function in defineWorkersProject promise-like exports when top-level workers is undefined end-to-end",
      "falls back to nested workers in defineWorkersProject promise export when top-level workers is undefined end-to-end",
      "falls back to nested workers function in defineWorkersProject promise export when top-level workers is undefined end-to-end"
    ]);
  });

  test("covers top-level precedence guard variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));
    expectTitleCoverage(titles, [
      "does not evaluate nested workers function when top-level workers function exists",
      "does not evaluate nested workers function in async config export when top-level async function exists",
      "does not evaluate nested workers function in promise-like export when top-level function exists",
      "does not evaluate nested workers function in promise-like export when top-level async function exists",
      "does not evaluate nested workers function in promise-like export when top-level thenable function exists",
      "does not evaluate nested workers function in promise export when top-level function exists",
      "does not evaluate nested workers function in promise export when top-level async function exists",
      "does not evaluate nested workers function in promise export when top-level thenable function exists",
      "defineWorkersProject does not evaluate nested workers function when top-level function exists",
      "defineWorkersProject does not evaluate nested workers function in async config export when top-level async function exists",
      "defineWorkersProject does not evaluate nested workers function in promise-like export when top-level function exists",
      "defineWorkersProject does not evaluate nested workers function in promise-like export when top-level async function exists",
      "defineWorkersProject does not evaluate nested workers function in promise-like export when top-level thenable function exists",
      "defineWorkersProject does not evaluate nested workers function in promise export when top-level function exists",
      "defineWorkersProject does not evaluate nested workers function in promise export when top-level async function exists",
      "defineWorkersProject does not evaluate nested workers function in promise export when top-level thenable function exists"
    ]);
  });

  test("covers top-level precedence guard variants in e2e suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "e2e-cli.test.ts"));
    expectTitleCoverage(titles, [
      "does not evaluate nested workers function when defineWorkersConfig top-level function is set end-to-end",
      "does not evaluate nested workers function in async config export when top-level async function is set end-to-end",
      "does not evaluate nested workers function when promise-like top-level async workers function is set end-to-end",
      "does not evaluate nested workers function when promise-like top-level thenable workers function is set end-to-end",
      "does not evaluate nested workers function in promise config export when top-level function is set end-to-end",
      "does not evaluate nested workers function in promise config export when top-level async function is set end-to-end",
      "does not evaluate nested workers function in promise config export when top-level thenable function is set end-to-end",
      "does not evaluate nested workers function when defineWorkersProject top-level function is set end-to-end",
      "does not evaluate nested workers function in defineWorkersProject async config export when top-level async function is set end-to-end",
      "does not evaluate nested workers function when defineWorkersProject promise-like top-level async workers function is set end-to-end",
      "does not evaluate nested workers function when defineWorkersProject promise-like top-level thenable workers function is set end-to-end",
      "does not evaluate nested workers function in defineWorkersProject promise export when top-level function is set end-to-end",
      "does not evaluate nested workers function in defineWorkersProject promise export when top-level async function is set end-to-end",
      "does not evaluate nested workers function in defineWorkersProject promise export when top-level thenable function is set end-to-end"
    ]);
  });

  test("covers error propagation variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));
    expectTitleCoverage(titles, [
      "propagates thrown errors for sync config function exports",
      "propagates rejection for async config function exports",
      "propagates rejection for promise-returning config function exports",
      "propagates rejection for thenable-returning config function exports",
      "defineWorkersProject propagates thrown errors for sync config function exports",
      "defineWorkersProject propagates rejection for async config function exports",
      "defineWorkersProject propagates rejection for promise-returning config function exports",
      "defineWorkersProject propagates rejection for thenable-returning config function exports",
      "propagates rejection from promise-like config exports",
      "propagates thrown errors from promise-like config exports",
      "defineWorkersProject propagates rejection from promise-like config exports",
      "defineWorkersProject propagates thrown errors from promise-like config exports",
      "propagates rejection from promise-like nested workers function",
      "propagates thrown errors from promise-like nested workers function",
      "propagates rejection from promise-like top-level workers function",
      "propagates thrown errors from promise-like top-level workers function",
      "defineWorkersProject propagates rejection from promise-like nested workers function",
      "defineWorkersProject propagates thrown errors from promise-like nested workers function",
      "defineWorkersProject propagates rejection from promise-like top-level workers function",
      "defineWorkersProject propagates thrown errors from promise-like top-level workers function",
      "propagates rejection from promise nested workers function",
      "propagates thrown errors from promise nested workers function",
      "propagates rejection from promise top-level workers function",
      "propagates thrown errors from promise top-level workers function",
      "defineWorkersProject propagates rejection from promise nested workers function",
      "defineWorkersProject propagates thrown errors from promise nested workers function",
      "defineWorkersProject propagates rejection from promise top-level workers function",
      "defineWorkersProject propagates thrown errors from promise top-level workers function"
    ]);
  });

  test("covers error propagation variants in e2e suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "e2e-cli.test.ts"));
    expectTitleCoverage(titles, [
      "surfaces sync config function export thrown errors end-to-end",
      "surfaces async config function export rejection end-to-end",
      "surfaces promise-returning config function export rejection end-to-end",
      "surfaces thenable config function export rejection end-to-end",
      "surfaces defineWorkersProject sync config function export thrown errors end-to-end",
      "surfaces defineWorkersProject async config function export rejection end-to-end",
      "surfaces defineWorkersProject promise-returning config function export rejection end-to-end",
      "surfaces defineWorkersProject thenable config function export rejection end-to-end",
      "surfaces promise-like config export rejection end-to-end",
      "surfaces promise-like config export thrown errors end-to-end",
      "surfaces defineWorkersProject promise-like config export rejection end-to-end",
      "surfaces defineWorkersProject promise-like config export thrown errors end-to-end",
      "surfaces promise-like nested workers rejection end-to-end",
      "surfaces promise-like nested workers thrown errors end-to-end",
      "surfaces promise-like top-level workers rejection end-to-end",
      "surfaces promise-like top-level workers thrown errors end-to-end",
      "surfaces defineWorkersProject promise-like nested workers rejection end-to-end",
      "surfaces defineWorkersProject promise-like nested workers thrown errors end-to-end",
      "surfaces defineWorkersProject promise-like top-level workers rejection end-to-end",
      "surfaces defineWorkersProject promise-like top-level workers thrown errors end-to-end",
      "surfaces promise config export nested workers rejection end-to-end",
      "surfaces promise config export nested workers thrown errors end-to-end",
      "surfaces promise config export top-level workers rejection end-to-end",
      "surfaces promise config export top-level workers thrown errors end-to-end",
      "surfaces defineWorkersProject promise export nested workers rejection end-to-end",
      "surfaces defineWorkersProject promise export nested workers thrown errors end-to-end",
      "surfaces defineWorkersProject promise export top-level workers rejection end-to-end",
      "surfaces defineWorkersProject promise export top-level workers thrown errors end-to-end"
    ]);
  });

  test("covers inject direct-env and scoped-precedence variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));
    expectTitleCoverage(titles, [
      "supports sync function-valued workers options with inject()",
      "supports top-level workers function with inject()",
      "supports direct env fallback for inject()",
      "supports direct env fallback for top-level workers function inject()",
      "defineWorkersProject supports sync function-valued workers options with inject()",
      "defineWorkersProject supports top-level workers function with inject()",
      "defineWorkersProject supports direct env fallback for inject()",
      "supports direct env fallback for promise-like nested workers function",
      "prefers scoped env over direct env for promise-like nested workers function",
      "supports direct env fallback for promise-like top-level workers function",
      "prefers scoped env over direct env for promise-like top-level workers function",
      "defineWorkersProject supports direct env fallback for promise-like nested workers function",
      "defineWorkersProject prefers scoped env over direct env for promise-like nested workers function",
      "defineWorkersProject supports direct env fallback for promise-like top-level workers function",
      "defineWorkersProject prefers scoped env over direct env for promise-like top-level workers function",
      "supports direct env fallback for promise nested workers function",
      "prefers scoped env over direct env for promise nested workers function",
      "supports direct env fallback for promise top-level workers function",
      "prefers scoped env over direct env for promise top-level workers function",
      "defineWorkersProject supports direct env fallback for promise nested workers function",
      "defineWorkersProject prefers scoped env over direct env for promise nested workers function",
      "defineWorkersProject supports direct env fallback for promise top-level workers function",
      "defineWorkersProject prefers scoped env over direct env for promise top-level workers function"
    ]);
  });

  test("covers inject direct-env and scoped-precedence variants in e2e suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "e2e-cli.test.ts"));
    expectTitleCoverage(titles, [
      "supports function-valued workers options with inject() end-to-end",
      "supports top-level workers function with inject() end-to-end",
      "supports inject() direct-env fallback end-to-end",
      "supports top-level workers function inject() direct-env fallback end-to-end",
      "supports defineWorkersProject sync workers function with inject() end-to-end",
      "supports defineWorkersProject top-level workers function with inject() end-to-end",
      "supports defineWorkersProject inject() direct-env fallback end-to-end",
      "supports promise-like config exports nested workers function direct-env fallback end-to-end",
      "promise-like nested workers scoped env wins over direct env",
      "supports promise-like config exports top-level workers direct-env fallback end-to-end",
      "promise-like top-level workers scoped env wins over direct env",
      "supports defineWorkersProject promise-like export nested workers direct-env fallback end-to-end",
      "project promise-like nested workers scoped env wins over direct env",
      "supports defineWorkersProject promise-like export top-level workers direct-env fallback end-to-end",
      "project promise-like top-level workers scoped env wins over direct env",
      "supports promise config export nested workers function direct-env fallback end-to-end",
      "promise nested workers scoped env wins over direct env",
      "supports promise config export top-level workers function direct-env fallback end-to-end",
      "promise top-level workers scoped env wins over direct env",
      "supports defineWorkersProject promise nested workers direct-env fallback end-to-end",
      "project promise nested workers scoped env wins over direct env",
      "supports defineWorkersProject promise export top-level workers direct-env fallback end-to-end",
      "project promise top-level workers scoped env wins over direct env"
    ]);
  });
});
