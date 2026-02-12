import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import ts from "typescript";

const GUARDED_TEST_SUITES = [
  "cloudflare-test-helpers.test.ts",
  "cloudflare-test-unsupported.test.ts",
  "config-types.test.ts",
  "config-utilities.test.ts",
  "config.test.ts",
  "coverage-matrix.test.ts",
  "e2e-cli.test.ts",
  "runtime-options.test.ts",
  "runtime-state.test.ts",
  "workers-plugin.test.ts"
] as const;

const TEST_MODIFIER_SEGMENTS = new Set(["only", "skip", "todo", "concurrent"]);
type VersionedCacheEntry<T> = {
  version: string;
  value: T;
};
type ParsedTestCall = {
  title?: string;
  modifiers: string[];
};
const COLLECTED_TITLE_CACHE = new Map<string, VersionedCacheEntry<string[]>>();
const UNIQUE_TITLE_CACHE = new Map<string, VersionedCacheEntry<string[]>>();
const TITLE_COUNT_CACHE = new Map<string, VersionedCacheEntry<Map<string, number>>>();
const PARSED_TEST_CALL_CACHE = new Map<string, VersionedCacheEntry<ParsedTestCall[]>>();

function getFileVersion(filePath: string): string {
  const stats = fs.statSync(filePath);
  return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`;
}

function cloneParsedTestCalls(calls: ParsedTestCall[]): ParsedTestCall[] {
  return calls.map((call) => ({
    title: call.title,
    modifiers: [...call.modifiers]
  }));
}

function extractSupportedModifierChain(
  expression: ts.LeftHandSideExpression
): string[] | undefined {
  const chain: string[] = [];
  let current: ts.LeftHandSideExpression | ts.Expression = expression;

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      chain.unshift(current.name.text);
      current = current.expression;
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      const argument = current.argumentExpression;
      if (
        !argument ||
        (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        return undefined;
      }
      chain.unshift(argument.text);
      current = current.expression;
      continue;
    }

    break;
  }

  if (!ts.isIdentifier(current) || current.text !== "test") {
    return undefined;
  }

  if (chain.length === 0) {
    return [];
  }

  if (!chain.every((segment) => TEST_MODIFIER_SEGMENTS.has(segment))) {
    return undefined;
  }

  return chain;
}

function collectParsedTestCalls(
  filePath: string,
  version = getFileVersion(filePath)
): ParsedTestCall[] {
  const cached = PARSED_TEST_CALL_CACHE.get(filePath);
  if (cached && cached.version === version) {
    return cloneParsedTestCalls(cached.value);
  }

  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const calls: ParsedTestCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const modifiers = extractSupportedModifierChain(node.expression);
      if (modifiers === undefined) {
        ts.forEachChild(node, visit);
        return;
      }

      const [titleNode] = node.arguments;
      let title: string | undefined;
      if (
        titleNode &&
        (ts.isStringLiteral(titleNode) || ts.isNoSubstitutionTemplateLiteral(titleNode))
      ) {
        title = titleNode.text;
      }
      calls.push({ title, modifiers: [...modifiers] });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  PARSED_TEST_CALL_CACHE.set(filePath, {
    version,
    value: cloneParsedTestCalls(calls)
  });
  return cloneParsedTestCalls(calls);
}

function collectTestTitles(
  filePath: string,
  version = getFileVersion(filePath)
): string[] {
  const cached = COLLECTED_TITLE_CACHE.get(filePath);
  if (cached && cached.version === version) {
    return [...cached.value];
  }

  const titles = collectParsedTestCalls(filePath, version)
    .map((call) => call.title)
    .filter((title): title is string => title !== undefined);

  COLLECTED_TITLE_CACHE.set(filePath, {
    version,
    value: [...titles]
  });
  return [...titles];
}

function readTestTitles(filePath: string): string[] {
  const version = getFileVersion(filePath);
  const cached = UNIQUE_TITLE_CACHE.get(filePath);
  if (cached && cached.version === version) {
    return [...cached.value];
  }

  const titles = Array.from(new Set(collectTestTitles(filePath, version)));
  UNIQUE_TITLE_CACHE.set(filePath, {
    version,
    value: [...titles]
  });
  return [...titles];
}

function readTestTitleCounts(filePath: string): Map<string, number> {
  const version = getFileVersion(filePath);
  const cached = TITLE_COUNT_CACHE.get(filePath);
  if (cached && cached.version === version) {
    return new Map(cached.value);
  }

  const counts = new Map<string, number>();
  for (const title of collectTestTitles(filePath, version)) {
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  TITLE_COUNT_CACHE.set(filePath, {
    version,
    value: new Map(counts)
  });
  return counts;
}

function listDiscoveredTestSuites(directory: string): string[] {
  const discovered: string[] = [];

  const visit = (currentDirectory: string): void => {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        discovered.push(path.relative(directory, absolutePath).replaceAll("\\", "/"));
      }
    }
  };

  visit(directory);
  return discovered.sort();
}

function expectSuffixCoverage(
  titles: string[],
  prefix: string,
  expectedSuffixes: string[]
): void {
  const duplicateExpectedSuffixes = findDuplicateEntries(expectedSuffixes);
  expect(
    duplicateExpectedSuffixes,
    [
      `Duplicate expected suffix entries for prefix: ${prefix}`,
      ...duplicateExpectedSuffixes.map((suffix) => `- ${suffix}`)
    ].join("\n")
  ).toEqual([]);

  const found = new Set(
    titles.filter((title) => title.startsWith(prefix)).map((title) => title.slice(prefix.length))
  );
  expect(found.size).toBeGreaterThanOrEqual(expectedSuffixes.length);
  const missing = expectedSuffixes.filter((suffix) => !found.has(suffix));
  expect(
    missing,
    [
      `Missing expected suffixes for prefix: ${prefix}`,
      `Expected: ${expectedSuffixes.join(", ")}`,
      `Found: ${Array.from(found).join(", ")}`
    ].join("\n")
  ).toEqual([]);
}

function expectTitleCoverage(titles: string[], expectedTitles: string[]): void {
  const duplicateExpectedTitles = findDuplicateEntries(expectedTitles);
  expect(
    duplicateExpectedTitles,
    [
      "Duplicate expected test title entries:",
      ...duplicateExpectedTitles.map((title) => `- ${title}`)
    ].join("\n")
  ).toEqual([]);

  const titleSet = new Set(titles);
  const missing = expectedTitles.filter((title) => !titleSet.has(title));
  expect(
    missing,
    [
      "Missing expected test titles:",
      ...missing.map((title) => `- ${title}`)
    ].join("\n")
  ).toEqual([]);
}

function findDuplicateEntries(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([value, count]) => `${value} (${count}x)`);
}

describe("regression coverage matrix", () => {
  test("parses title strings across quote styles and test modifiers", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "title-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `
test("double quote", () => {});
test("escaped \\"double\\" quote", () => {});
test('single quote', () => {});
test('single \\'quote\\' value', () => {});
test(\`template literal\`, () => {});
test(\`template \\\`quote\\\`\`, () => {});
test.only("only variant", () => {});
test.skip('skip variant', () => {});
test.todo(\`todo variant\`, () => {});
test.concurrent("concurrent variant", () => {});
test.concurrent.only("concurrent only variant", () => {});
test.concurrent.skip("concurrent skip variant", () => {});
`,
      "utf8"
    );

    try {
      const titles = readTestTitles(fixturePath);
      expectTitleCoverage(titles, [
        "double quote",
        'escaped "double" quote',
        "single quote",
        "single 'quote' value",
        "template literal",
        "template `quote`",
        "only variant",
        "skip variant",
        "todo variant",
        "concurrent variant",
        "concurrent only variant",
        "concurrent skip variant"
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("ignores embedded fixture-source strings when collecting titles", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "embedded-source-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `
const generatedSource = \`
  test("embedded fixture title", () => {});
  test.only("embedded only fixture title", () => {});
\`;

test("actual executable title", () => {});
`,
      "utf8"
    );

    try {
      const titles = readTestTitles(fixturePath);
      expect(titles.includes("actual executable title")).toBe(true);
      expect(titles.includes("embedded fixture title")).toBe(false);
      expect(titles.includes("embedded only fixture title")).toBe(false);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("ignores non-literal and interpolated test title arguments", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "non-literal-title-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `
const dynamicTitle = "dynamic title";
const suffix = "segment";

test(dynamicTitle, () => {});
test(\`interpolated \${suffix}\`, () => {});
test(String("computed"), () => {});
test("literal title", () => {});
`,
      "utf8"
    );

    try {
      const titles = readTestTitles(fixturePath);
      expect(titles.includes("literal title")).toBe(true);
      expect(titles.includes("dynamic title")).toBe(false);
      expect(titles.includes("interpolated segment")).toBe(false);
      expect(titles.includes("computed")).toBe(false);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("ignores non-root test-like call expressions", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "non-root-call-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `
const alias = test;
const objectWithTest = { test };
const getTest = () => test;

contest("contest title", () => {});
objectWithTest.test("object member title", () => {});
alias("alias title", () => {});
getTest()("factory title", () => {});
test("root test title", () => {});
`,
      "utf8"
    );

    try {
      expect(readTestTitles(fixturePath)).toEqual(["root test title"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("extracts supported modifier chains and ignores unsupported call forms", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "modifier-chain-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `
test("plain", () => {});
test.only("only", () => {});
test.concurrent.skip("concurrent skip", () => {});
test["only"]("only bracket", () => {});
test["concurrent"]["skip"]("concurrent skip bracket", () => {});
test.each([1])("parameterized %i", () => {});
test.runIf(true)("run if", () => {});
const dynamicModifier = "only";
test[dynamicModifier]("dynamic bracket run if", () => {});
`,
      "utf8"
    );

    try {
      expect(collectParsedTestCalls(fixturePath)).toEqual([
        { title: "plain", modifiers: [] },
        { title: "only", modifiers: ["only"] },
        { title: "concurrent skip", modifiers: ["concurrent", "skip"] },
        { title: "only bracket", modifiers: ["only"] },
        { title: "concurrent skip bracket", modifiers: ["concurrent", "skip"] }
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("discovers nested test suites and normalizes relative paths", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const nestedDirectory = path.join(tempDirectory, "nested");
    const deeperDirectory = path.join(nestedDirectory, "deeper");
    fs.mkdirSync(deeperDirectory, { recursive: true });

    fs.writeFileSync(path.join(tempDirectory, "root.test.ts"), "test(\"root\", () => {});", "utf8");
    fs.writeFileSync(
      path.join(nestedDirectory, "nested.test.ts"),
      "test(\"nested\", () => {});",
      "utf8"
    );
    fs.writeFileSync(
      path.join(deeperDirectory, "deeper.test.ts"),
      "test(\"deeper\", () => {});",
      "utf8"
    );
    fs.writeFileSync(path.join(deeperDirectory, "helper.ts"), "export {};", "utf8");

    try {
      const discovered = listDiscoveredTestSuites(tempDirectory);
      expect(discovered).toEqual([
        "nested/deeper/deeper.test.ts",
        "nested/nested.test.ts",
        "root.test.ts"
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("invalidates cached titles when a fixture file changes", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "cache-invalidation-fixture.test.ts");

    fs.writeFileSync(fixturePath, `test("before update", () => {});\n`, "utf8");

    try {
      expect(readTestTitles(fixturePath)).toEqual(["before update"]);

      fs.writeFileSync(fixturePath, `test("after update", () => {});\n`, "utf8");
      const now = Date.now();
      fs.utimesSync(fixturePath, now / 1000, (now + 1000) / 1000);

      expect(readTestTitles(fixturePath)).toEqual(["after update"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("invalidates cached title counts when a fixture file changes", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "count-cache-invalidation-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `test("duplicate", () => {});\ntest("duplicate", () => {});\n`,
      "utf8"
    );

    try {
      expect(Array.from(readTestTitleCounts(fixturePath).entries())).toEqual([["duplicate", 2]]);

      fs.writeFileSync(
        fixturePath,
        `test("first", () => {});\ntest("second", () => {});\n`,
        "utf8"
      );
      const now = Date.now();
      fs.utimesSync(fixturePath, now / 1000, (now + 1000) / 1000);

      expect(Array.from(readTestTitleCounts(fixturePath).entries())).toEqual([
        ["first", 1],
        ["second", 1]
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("invalidates caches when content changes with preserved mtime and size", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "mtime-size-preserved-fixture.test.ts");

    fs.writeFileSync(fixturePath, `test("before!", () => {});\n`, "utf8");
    const initialStats = fs.statSync(fixturePath);

    try {
      expect(readTestTitles(fixturePath)).toEqual(["before!"]);

      fs.writeFileSync(fixturePath, `test("after!!", () => {});\n`, "utf8");
      fs.utimesSync(fixturePath, initialStats.atime, initialStats.mtime);

      expect(readTestTitles(fixturePath)).toEqual(["after!!"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("keeps parser caches isolated between different fixture files", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixtureAPath = path.join(tempDirectory, "fixture-a.test.ts");
    const fixtureBPath = path.join(tempDirectory, "fixture-b.test.ts");

    fs.writeFileSync(fixtureAPath, `test("title from fixture A", () => {});\n`, "utf8");
    fs.writeFileSync(fixtureBPath, `test("title from fixture B", () => {});\n`, "utf8");

    try {
      expect(readTestTitles(fixtureAPath)).toEqual(["title from fixture A"]);
      expect(readTestTitles(fixtureBPath)).toEqual(["title from fixture B"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("returns defensive copies for cached title count maps", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "defensive-copy-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `test("same", () => {});\ntest("same", () => {});\n`,
      "utf8"
    );

    try {
      const firstRead = readTestTitleCounts(fixturePath);
      firstRead.set("same", 999);
      firstRead.set("injected", 1);

      expect(Array.from(readTestTitleCounts(fixturePath).entries())).toEqual([["same", 2]]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("returns defensive copies for parsed executable test call metadata", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "parsed-call-copy-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `test.concurrent.only("stable title", () => {});\n`,
      "utf8"
    );

    try {
      const firstRead = collectParsedTestCalls(fixturePath);
      firstRead[0].title = "mutated title";
      firstRead[0].modifiers.push("skip");

      expect(collectParsedTestCalls(fixturePath)).toEqual([
        { title: "stable title", modifiers: ["concurrent", "only"] }
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("returns defensive copies for cached unique title arrays", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "title-array-copy-fixture.test.ts");

    fs.writeFileSync(
      fixturePath,
      `test("first", () => {});\ntest("second", () => {});\n`,
      "utf8"
    );

    try {
      const firstRead = readTestTitles(fixturePath);
      firstRead.push("injected");

      expect(readTestTitles(fixturePath)).toEqual(["first", "second"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("ensures guarded suites have unique executable test titles", () => {
    for (const suiteFile of GUARDED_TEST_SUITES) {
      const counts = readTestTitleCounts(path.join(process.cwd(), "test", suiteFile));
      const duplicates = Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([title, count]) => `${count}x ${title}`);

      expect(
        duplicates,
        [
          `Duplicate executable test titles in ${suiteFile}:`,
          ...duplicates.map((entry) => `- ${entry}`)
        ].join("\n")
      ).toEqual([]);
    }
  });

  test("ensures executable test titles are globally unique across guarded suites", () => {
    const titleOrigins = new Map<string, string[]>();

    for (const suiteFile of GUARDED_TEST_SUITES) {
      const counts = readTestTitleCounts(path.join(process.cwd(), "test", suiteFile));
      for (const [title, count] of counts.entries()) {
        const origins = titleOrigins.get(title) ?? [];
        for (let index = 0; index < count; index += 1) {
          origins.push(suiteFile);
        }
        titleOrigins.set(title, origins);
      }
    }

    const duplicates = Array.from(titleOrigins.entries())
      .filter(([, origins]) => origins.length > 1)
      .map(([title, origins]) => `${title} => ${origins.join(", ")}`);

    expect(
      duplicates,
      [
        "Duplicate executable test titles across guarded suites:",
        ...duplicates.map((entry) => `- ${entry}`)
      ].join("\n")
    ).toEqual([]);
  });

  test("keeps GUARDED_TEST_SUITES sorted and unique", () => {
    const guardedSuites = [...GUARDED_TEST_SUITES];
    const sorted = [...guardedSuites].sort();
    const unique = Array.from(new Set(guardedSuites));

    expect(
      guardedSuites,
      [
        "GUARDED_TEST_SUITES must remain sorted for review clarity.",
        `Expected sorted order: ${sorted.join(", ")}`
      ].join("\n")
    ).toEqual(sorted);

    expect(
      guardedSuites.length,
      [
        "GUARDED_TEST_SUITES must not contain duplicate entries.",
        `Unique count: ${unique.length}, actual count: ${guardedSuites.length}`
      ].join("\n")
    ).toBe(unique.length);
  });

  test("guards every test suite file in the test directory", () => {
    const discovered = listDiscoveredTestSuites(path.join(process.cwd(), "test"));
    const guarded = [...GUARDED_TEST_SUITES].sort();

    const missingFromGuard = discovered.filter((suiteFile) => !guarded.includes(suiteFile));
    const unexpectedInGuard = guarded.filter((suiteFile) => !discovered.includes(suiteFile));

    expect(
      missingFromGuard,
      [
        "Discovered test suites missing from GUARDED_TEST_SUITES:",
        ...missingFromGuard.map((suiteFile) => `- ${suiteFile}`)
      ].join("\n")
    ).toEqual([]);

    expect(
      unexpectedInGuard,
      [
        "GUARDED_TEST_SUITES entries without matching discovered test suite files:",
        ...unexpectedInGuard.map((suiteFile) => `- ${suiteFile}`)
      ].join("\n")
    ).toEqual([]);
  });

  test("ensures guarded suites do not contain focused/skipped/todo executable tests", () => {
    const violations: string[] = [];

    for (const suiteFile of GUARDED_TEST_SUITES) {
      const filePath = path.join(process.cwd(), "test", suiteFile);
      for (const testCall of collectParsedTestCalls(filePath)) {
        if (
          !testCall.modifiers.some(
            (modifier) => modifier === "only" || modifier === "skip" || modifier === "todo"
          )
        ) {
          continue;
        }

        violations.push(
          `${suiteFile}: test.${testCall.modifiers.join(".")}(${JSON.stringify(
            testCall.title ?? "<non-literal title>"
          )})`
        );
      }
    }

    expect(
      violations,
      [
        "Focused/skipped/todo executable tests are not allowed in guarded suites:",
        ...violations.map((violation) => `- ${violation}`)
      ].join("\n")
    ).toEqual([]);
  });

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
      "supports promise-like config exports nested async workers direct-env fallback end-to-end",
      "supports promise-like config exports nested thenable workers direct-env fallback end-to-end",
      "supports promise-like config exports top-level workers direct-env fallback end-to-end",
      "supports promise-like config exports async top-level workers direct-env fallback end-to-end",
      "supports promise-like config exports top-level thenable workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise-like export nested workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise-like export nested async workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise-like export nested thenable workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise-like export top-level workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise-like export async top-level workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise-like export top-level thenable workers direct-env fallback end-to-end",
      "supports promise config export nested workers function direct-env fallback end-to-end",
      "supports promise config export nested async workers function direct-env fallback end-to-end",
      "supports promise config export nested thenable workers direct-env fallback end-to-end",
      "supports promise config export top-level workers function direct-env fallback end-to-end",
      "supports promise config export async top-level workers direct-env fallback end-to-end",
      "supports promise config export top-level thenable workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise nested workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise nested async workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise nested thenable workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise export top-level workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise export async top-level workers direct-env fallback end-to-end",
      "supports defineWorkersProject promise export top-level thenable workers direct-env fallback end-to-end"
    ]);
  });

  test("covers argument forwarding and this-binding variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));
    expectTitleCoverage(titles, [
      "forwards sync config function arguments",
      "forwards async config function arguments",
      "forwards config function arguments when function returns a promise",
      "forwards arguments for thenable-returning config function exports",
      "preserves this binding for sync config function exports",
      "preserves this binding for async config function exports",
      "preserves this binding for promise-returning config function exports",
      "preserves this binding for thenable-returning config function exports",
      "defineWorkersProject forwards sync config function arguments",
      "defineWorkersProject forwards async config function arguments",
      "defineWorkersProject forwards arguments when config function returns a promise",
      "defineWorkersProject forwards arguments for thenable-returning config function exports",
      "defineWorkersProject preserves this binding for sync config function exports",
      "defineWorkersProject preserves this binding for async config function exports",
      "defineWorkersProject preserves this binding for promise-returning config function exports",
      "defineWorkersProject preserves this binding for thenable-returning config function exports"
    ]);
  });

  test("covers plugin dedup and relative-path resolution variants in unit suite", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "config.test.ts"));
    expectTitleCoverage(titles, [
      "resolves relative workers.main from caller directory",
      "resolves relative wrangler.configPath from caller directory",
      "resolves relative wrangler.configPath for async top-level workers function",
      "defineWorkersProject resolves relative workers.main in promise top-level workers function",
      "defineWorkersProject resolves relative wrangler.configPath from caller directory",
      "defineWorkersProject resolves relative wrangler.configPath in promise top-level workers function",
      "does not inject duplicate workers plugin when already present",
      "does not inject duplicate workers plugin in async config path",
      "does not inject duplicate workers plugin in async config path when plugins is single value",
      "does not inject duplicate workers plugin when plugins is a single value",
      "defineWorkersProject deduplicates existing workers plugin",
      "defineWorkersProject deduplicates workers plugin in async config path",
      "defineWorkersProject deduplicates workers plugin in async config path when plugins is single value",
      "defineWorkersProject deduplicates workers plugin when plugins is single value",
      "keeps falsey plugin entries while deduping in sync config path",
      "keeps falsey plugin entries while deduping in async config path",
      "keeps falsey plugin entries while deduping in promise config exports",
      "keeps falsey plugin entries while deduping in promise-like config exports",
      "keeps falsey plugin entries while deduping thenable config function exports",
      "defineWorkersProject keeps falsey plugin entries while deduping in sync config path",
      "defineWorkersProject keeps falsey plugin entries while deduping in async config path",
      "defineWorkersProject keeps falsey plugin entries while deduping in promise exports",
      "defineWorkersProject keeps falsey plugin entries while deduping in promise-like config exports",
      "defineWorkersProject keeps falsey plugin entries while deduping thenable config function exports"
    ]);
  });

  test("covers workers plugin suite variants", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "workers-plugin.test.ts"));
    expectTitleCoverage(titles, [
      "registers module resolution aliases for cloudflare:test modules",
      "adds workerd resolve conditions and removes node"
    ]);
  });

  test("covers runtime options suite variants", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "runtime-options.test.ts"));
    expectTitleCoverage(titles, [
      "resolves relative main path and fills miniflare defaults",
      "preserves explicit compatibilityDate when provided",
      "preserves explicit script config",
      "preserves explicit scriptPath config",
      "accepts additional worker export hints in options",
      "bundles TypeScript entrypoint into in-memory script",
      "bundles TSX entrypoint into in-memory script",
      "bundles MTS entrypoint into in-memory script",
      "bundles CTS entrypoint into in-memory script",
      "falls back to scriptPath when TypeScript entrypoint file is missing"
    ]);
  });

  test("covers runtime state suite variants", () => {
    const titles = readTestTitles(path.join(process.cwd(), "test", "runtime-state.test.ts"));
    expectTitleCoverage(titles, [
      "SELF.fetch executes worker script and exposes bindings through env",
      "SELF.fetch supports Request inputs with method/body semantics",
      "SELF.fetch supports URL object inputs",
      "SELF.fetch supports relative string inputs",
      "SELF.fetch normalizes bare path string inputs",
      "SELF.fetch Request inputs honor init overrides",
      "SELF.fetch Request inputs preserve headers",
      "SELF.fetch Request init can override headers",
      "pushStorageSnapshot and popStorageSnapshot restore persisted KV state",
      "listDurableObjectIds enumerates created Durable Object IDs",
      "fetchMock intercepts outbound fetch and resets interceptor state",
      "fetchMock remains usable after teardown followed by setup",
      "runInDurableObject executes RPC-callable instance methods",
      "runInDurableObject throws actionable error on state access",
      "runInDurableObject preserves callback return values and errors",
      "runDurableObjectAlarm rejects with unsupported guidance for real stubs",
      "SELF.scheduled dispatches scheduled handler and persists effects",
      "SELF.scheduled applies default cron/time when options are omitted"
    ]);
  });

  test("covers cloudflare helper and unsupported suite variants", () => {
    const helperTitles = readTestTitles(path.join(process.cwd(), "test", "cloudflare-test-helpers.test.ts"));
    expectTitleCoverage(helperTitles, [
      "waitOnExecutionContext resolves waitUntil promises",
      "queue helpers collect ack/retry results",
      "scheduled controller exposes normalized values",
      "applyD1Migrations runs only unapplied migrations"
    ]);

    const unsupportedTitles = readTestTitles(
      path.join(process.cwd(), "test", "cloudflare-test-unsupported.test.ts")
    );
    expectTitleCoverage(unsupportedTitles, [
      "runInDurableObject validates argument types",
      "runDurableObjectAlarm throws with explicit guidance",
      "listDurableObjectIds validates namespace argument type",
      "workflow introspection APIs throw with explicit guidance"
    ]);
  });

  test("covers config utility and config type mapping suite variants", () => {
    const utilityTitles = readTestTitles(path.join(process.cwd(), "test", "config-utilities.test.ts"));
    expectTitleCoverage(utilityTitles, [
      "readD1Migrations sorts by migration number and splits statements",
      "buildPagesASSETSBinding serves static files",
      "readD1Migrations throws on non-string input",
      "buildPagesASSETSBinding throws on non-string input"
    ]);

    const configTypeTitles = readTestTitles(path.join(process.cwd(), "test", "config-types.test.ts"));
    expectTitleCoverage(configTypeTitles, [
      "maps object config exports",
      "throws when mapper throws for object config exports",
      "maps promise config exports",
      "propagates mapper throws for promise config exports",
      "propagates rejection for promise config exports",
      "maps promise-like config exports",
      "propagates mapper throws for promise-like config exports",
      "propagates rejection for promise-like config exports",
      "forwards config function export arguments through mapper",
      "preserves this binding for mapped config function exports",
      "forwards async config function export arguments through mapper",
      "preserves this and arguments for promise-returning mapped config functions",
      "preserves this and arguments for thenable-returning mapped config functions",
      "propagates mapper throws for mapped config function exports",
      "propagates mapper throws for promise-returning mapped config functions",
      "propagates mapper throws for async mapped config function exports",
      "propagates mapper throws for thenable-returning mapped config functions",
      "propagates rejection for thenable-returning mapped config functions",
      "propagates rejection for promise-returning mapped config functions",
      "propagates thrown errors from mapped config function exports",
      "propagates rejection from async mapped config function exports"
    ]);
  });
});
