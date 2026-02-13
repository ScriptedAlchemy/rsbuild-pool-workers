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

const SUPPORTED_TEST_FILE_SUFFIXES = [
  ".test.cjs",
  ".test.cts",
  ".test.js",
  ".test.jsx",
  ".test.mjs",
  ".test.mts",
  ".test.ts",
  ".test.tsx"
];
const IGNORED_TEST_DISCOVERY_DIRECTORIES = new Set([
  ".git",
  "build",
  "dist",
  "node_modules"
]);
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
const RSTEST_INCLUDE_PATTERNS_CACHE = new Map<string, VersionedCacheEntry<string[]>>();

function getFileVersion(filePath: string): string {
  const stats = fs.statSync(filePath);
  return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`;
}

function getScriptKindFromFilePath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith(".mjs") || filePath.endsWith(".cjs") || filePath.endsWith(".js")) {
    return ts.ScriptKind.JS;
  }
  if (filePath.endsWith(".mts")) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.TS;
}

function isSupportedTestFileName(fileName: string): boolean {
  return SUPPORTED_TEST_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
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
    getScriptKindFromFilePath(filePath)
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
        if (IGNORED_TEST_DISCOVERY_DIRECTORIES.has(entry.name)) {
          continue;
        }
        visit(absolutePath);
        continue;
      }

      if (entry.isFile() && isSupportedTestFileName(entry.name)) {
        discovered.push(path.relative(directory, absolutePath).replaceAll("\\", "/"));
      }
    }
  };

  visit(directory);
  return discovered.sort();
}

function unwrapConfigExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isStringLiteralLikeExpression(
  expression: ts.Expression | undefined,
  expected: string
): boolean {
  if (!expression) {
    return false;
  }
  const unwrappedExpression = unwrapConfigExpression(expression);
  return (
    (ts.isStringLiteral(unwrappedExpression) ||
      ts.isNoSubstitutionTemplateLiteral(unwrappedExpression)) &&
    unwrappedExpression.text === expected
  );
}

function isPropertyNameText(name: ts.PropertyName, expected: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === expected;
  }
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text === expected;
  }
  if (ts.isComputedPropertyName(name)) {
    return isStringLiteralLikeExpression(name.expression, expected);
  }
  return false;
}

function readRstestIncludePatterns(
  configFilePath: string,
  version = getFileVersion(configFilePath)
): string[] {
  const cached = RSTEST_INCLUDE_PATTERNS_CACHE.get(configFilePath);
  if (cached && cached.version === version) {
    return [...cached.value];
  }

  const source = fs.readFileSync(configFilePath, "utf8");
  const sourceFile = ts.createSourceFile(
    configFilePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const defineConfigIdentifiers = new Set<string>();
  const defineConfigNamespaceIdentifiers = new Set<string>();
  const registerDefineConfigRequireBinding = (declarationName: ts.BindingName): void => {
    if (ts.isIdentifier(declarationName)) {
      defineConfigNamespaceIdentifiers.add(declarationName.text);
      return;
    }

    if (ts.isObjectBindingPattern(declarationName)) {
      for (const element of declarationName.elements) {
        const importedName = element.propertyName
          ? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
            ? element.propertyName.text
            : undefined
          : ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
        if (importedName === "defineConfig" && ts.isIdentifier(element.name)) {
          defineConfigIdentifiers.add(element.name.text);
        }
      }
    }
  };

  const isRequireFromRstestCore = (expression: ts.Expression | undefined): boolean => {
    if (!expression) {
      return false;
    }
    const unwrappedExpression = unwrapConfigExpression(expression);
    if (!ts.isCallExpression(unwrappedExpression)) {
      return false;
    }
    if (
      !ts.isIdentifier(unwrappedExpression.expression) ||
      unwrappedExpression.expression.text !== "require"
    ) {
      return false;
    }
    const [firstArgument] = unwrappedExpression.arguments;
    return (
      (ts.isStringLiteral(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument)) &&
      firstArgument.text === "@rstest/core"
    );
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@rstest/core"
      ) {
        const defaultImport = statement.importClause?.name;
        if (defaultImport) {
          defineConfigNamespaceIdentifiers.add(defaultImport.text);
        }
        const namedBindings = statement.importClause?.namedBindings;
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            defineConfigNamespaceIdentifiers.add(namedBindings.name.text);
          } else if (ts.isNamedImports(namedBindings)) {
            for (const element of namedBindings.elements) {
              const importedName = element.propertyName?.text ?? element.name.text;
              if (importedName === "defineConfig") {
                defineConfigIdentifiers.add(element.name.text);
              }
            }
          }
        }
      }
      continue;
    }

    if (ts.isImportEqualsDeclaration(statement)) {
      const moduleReference = statement.moduleReference;
      if (
        ts.isExternalModuleReference(moduleReference) &&
        moduleReference.expression &&
        ts.isStringLiteral(moduleReference.expression) &&
        moduleReference.expression.text === "@rstest/core"
      ) {
        defineConfigNamespaceIdentifiers.add(statement.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (isRequireFromRstestCore(declaration.initializer)) {
          registerDefineConfigRequireBinding(declaration.name);
        }
      }
    }
  }

  const readPatternsFromIncludeInitializer = (
    initializer: ts.Expression
  ): string[] | undefined => {
    const unwrappedInitializer = unwrapConfigExpression(initializer);
    if (ts.isArrayLiteralExpression(unwrappedInitializer)) {
      const patterns: string[] = [];
      const collectArrayLiteralStrings = (arrayExpression: ts.ArrayLiteralExpression): void => {
        for (const element of arrayExpression.elements) {
          if (ts.isSpreadElement(element)) {
            const unwrappedSpreadExpression = unwrapConfigExpression(element.expression);
            if (ts.isArrayLiteralExpression(unwrappedSpreadExpression)) {
              collectArrayLiteralStrings(unwrappedSpreadExpression);
            }
            continue;
          }

          const unwrappedElement = unwrapConfigExpression(element);
          if (ts.isStringLiteralLike(unwrappedElement)) {
            patterns.push(unwrappedElement.text);
          }
        }
      };

      collectArrayLiteralStrings(unwrappedInitializer);
      return patterns;
    }
    if (ts.isStringLiteralLike(unwrappedInitializer)) {
      return [unwrappedInitializer.text];
    }
    return undefined;
  };

  const readPatternsFromConfigObject = (
    configObject: ts.ObjectLiteralExpression
  ): string[] | undefined => {
    const readIncludeInitializerFromConfigObject = (
      objectLiteral: ts.ObjectLiteralExpression
    ): ts.Expression | "unknown" | undefined => {
      let includeInitializer: ts.Expression | undefined;
      let includeOverriddenByUnknownSpread = false;

      for (const property of objectLiteral.properties) {
        if (ts.isPropertyAssignment(property) && isPropertyNameText(property.name, "include")) {
          includeInitializer = property.initializer;
          includeOverriddenByUnknownSpread = false;
          continue;
        }

        if (ts.isShorthandPropertyAssignment(property) && property.name.text === "include") {
          includeInitializer = property.name;
          includeOverriddenByUnknownSpread = false;
          continue;
        }

        if (
          !ts.isSpreadAssignment(property) &&
          isPropertyNameText(property.name, "include")
        ) {
          includeInitializer = undefined;
          includeOverriddenByUnknownSpread = true;
          continue;
        }

        if (ts.isSpreadAssignment(property)) {
          const unwrappedSpreadExpression = unwrapConfigExpression(property.expression);
          if (ts.isObjectLiteralExpression(unwrappedSpreadExpression)) {
            const nestedInitializer = readIncludeInitializerFromConfigObject(unwrappedSpreadExpression);
            if (nestedInitializer === "unknown") {
              includeInitializer = undefined;
              includeOverriddenByUnknownSpread = true;
            } else if (nestedInitializer !== undefined) {
              includeInitializer = nestedInitializer;
              includeOverriddenByUnknownSpread = false;
            }
            continue;
          }

          includeInitializer = undefined;
          includeOverriddenByUnknownSpread = true;
        }
      }

      if (includeInitializer !== undefined) {
        return includeInitializer;
      }
      if (includeOverriddenByUnknownSpread) {
        return "unknown";
      }
      return undefined;
    };

    const includeInitializer = readIncludeInitializerFromConfigObject(configObject);
    if (includeInitializer === "unknown") {
      return [];
    }
    if (!includeInitializer) {
      return undefined;
    }
    return readPatternsFromIncludeInitializer(includeInitializer);
  };

  const readPatternsFromDefineConfigCall = (
    callExpression: ts.CallExpression
  ): string[] | undefined => {
    const [firstArgument] = callExpression.arguments;
    if (!firstArgument) {
      return undefined;
    }
    const unwrappedArgument = unwrapConfigExpression(firstArgument);
    if (!ts.isObjectLiteralExpression(unwrappedArgument)) {
      return undefined;
    }
    return readPatternsFromConfigObject(unwrappedArgument);
  };

  const isModuleExportsNamespaceExpression = (expression: ts.Expression): boolean => {
    const unwrappedExpression = unwrapConfigExpression(expression);
    if (ts.isPropertyAccessExpression(unwrappedExpression)) {
      const unwrappedBaseExpression = unwrapConfigExpression(unwrappedExpression.expression);
      return (
        ts.isIdentifier(unwrappedBaseExpression) &&
        unwrappedBaseExpression.text === "module" &&
        unwrappedExpression.name.text === "exports"
      );
    }
    if (ts.isElementAccessExpression(unwrappedExpression)) {
      const unwrappedBaseExpression = unwrapConfigExpression(unwrappedExpression.expression);
      return (
        ts.isIdentifier(unwrappedBaseExpression) &&
        unwrappedBaseExpression.text === "module" &&
        isStringLiteralLikeExpression(unwrappedExpression.argumentExpression, "exports")
      );
    }
    return false;
  };

  const isModuleExportsAssignmentTarget = (expression: ts.Expression): boolean => {
    const unwrappedExpression = unwrapConfigExpression(expression);
    if (ts.isPropertyAccessExpression(unwrappedExpression)) {
      const unwrappedBaseExpression = unwrapConfigExpression(unwrappedExpression.expression);
      if (
        ts.isIdentifier(unwrappedBaseExpression) &&
        unwrappedBaseExpression.text === "module" &&
        unwrappedExpression.name.text === "exports"
      ) {
        return true;
      }
      if (
        ts.isIdentifier(unwrappedBaseExpression) &&
        unwrappedBaseExpression.text === "exports" &&
        unwrappedExpression.name.text === "default"
      ) {
        return true;
      }
      if (
        unwrappedExpression.name.text === "default" &&
        isModuleExportsNamespaceExpression(unwrappedBaseExpression)
      ) {
        return true;
      }
    }
    if (ts.isElementAccessExpression(unwrappedExpression)) {
      const unwrappedBaseExpression = unwrapConfigExpression(unwrappedExpression.expression);
      if (
        ts.isIdentifier(unwrappedBaseExpression) &&
        unwrappedBaseExpression.text === "module" &&
        isStringLiteralLikeExpression(unwrappedExpression.argumentExpression, "exports")
      ) {
        return true;
      }
      if (
        ts.isIdentifier(unwrappedBaseExpression) &&
        unwrappedBaseExpression.text === "exports" &&
        isStringLiteralLikeExpression(unwrappedExpression.argumentExpression, "default")
      ) {
        return true;
      }
      if (
        isModuleExportsNamespaceExpression(unwrappedBaseExpression) &&
        isStringLiteralLikeExpression(unwrappedExpression.argumentExpression, "default")
      ) {
        return true;
      }
    }
    return false;
  };

  const isRstestNamespaceExpression = (
    expression: ts.LeftHandSideExpression
  ): boolean => {
    const unwrappedExpression = unwrapConfigExpression(expression);
    if (ts.isIdentifier(unwrappedExpression)) {
      return defineConfigNamespaceIdentifiers.has(unwrappedExpression.text);
    }
    return isRequireFromRstestCore(unwrappedExpression);
  };

  const isDefineConfigCallExpression = (
    expression: ts.LeftHandSideExpression
  ): boolean => {
    const unwrappedExpression = unwrapConfigExpression(expression);

    if (ts.isIdentifier(unwrappedExpression)) {
      return defineConfigIdentifiers.has(unwrappedExpression.text);
    }
    if (ts.isPropertyAccessExpression(unwrappedExpression)) {
      return (
        unwrappedExpression.name.text === "defineConfig" &&
        isRstestNamespaceExpression(unwrappedExpression.expression)
      );
    }
    if (ts.isElementAccessExpression(unwrappedExpression)) {
      if (
        isStringLiteralLikeExpression(unwrappedExpression.argumentExpression, "defineConfig") &&
        isRstestNamespaceExpression(unwrappedExpression.expression)
      ) {
        return true;
      }
    }
    return false;
  };

  const topLevelIdentifierExpressions = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          topLevelIdentifierExpressions.set(declaration.name.text, declaration.initializer);
        }
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrapConfigExpression(statement.expression.left))
    ) {
      const assignmentTarget = unwrapConfigExpression(statement.expression.left);
      if (ts.isIdentifier(assignmentTarget)) {
        topLevelIdentifierExpressions.set(assignmentTarget.text, statement.expression.right);
      }
    }
  }

  const resolveTopLevelExpression = (
    expression: ts.Expression
  ): ts.Expression => {
    let current = unwrapConfigExpression(expression);
    const seenIdentifiers = new Set<string>();
    while (true) {
      if (ts.isBinaryExpression(current)) {
        if (
          current.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          current.operatorToken.kind === ts.SyntaxKind.CommaToken
        ) {
          current = unwrapConfigExpression(current.right);
          continue;
        }
      }

      if (!ts.isIdentifier(current)) {
        break;
      }

      if (seenIdentifiers.has(current.text)) {
        break;
      }

      seenIdentifiers.add(current.text);
      const initializer = topLevelIdentifierExpressions.get(current.text);
      if (!initializer) {
        break;
      }
      current = unwrapConfigExpression(initializer);
    }
    return current;
  };

  let exportedPatterns: string[] | undefined;
  let sawExportedDefineConfigCall = false;
  for (const statement of sourceFile.statements) {
    let candidateExpression: ts.Expression | undefined;

    if (ts.isExportAssignment(statement)) {
      candidateExpression = statement.expression;
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExportsAssignmentTarget(statement.expression.left)
    ) {
      candidateExpression = statement.expression.right;
    }

    if (!candidateExpression) {
      continue;
    }

    const unwrappedCandidate = resolveTopLevelExpression(candidateExpression);
    if (
      ts.isCallExpression(unwrappedCandidate) &&
      isDefineConfigCallExpression(unwrappedCandidate.expression)
    ) {
      sawExportedDefineConfigCall = true;
      exportedPatterns = readPatternsFromDefineConfigCall(unwrappedCandidate) ?? [];
    }
  }

  if (sawExportedDefineConfigCall) {
    const finalPatterns = exportedPatterns ?? [];
    RSTEST_INCLUDE_PATTERNS_CACHE.set(configFilePath, {
      version,
      value: [...finalPatterns]
    });
    return [...finalPatterns];
  }

  let patterns: string[] | undefined;
  let sawDefineConfigCall = false;

  const visit = (node: ts.Node): void => {
    if (patterns !== undefined) {
      return;
    }

    if (ts.isCallExpression(node) && isDefineConfigCallExpression(node.expression)) {
      sawDefineConfigCall = true;
      const extracted = readPatternsFromDefineConfigCall(node);
      if (extracted !== undefined) {
        patterns = extracted;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (patterns !== undefined) {
    RSTEST_INCLUDE_PATTERNS_CACHE.set(configFilePath, {
      version,
      value: [...patterns]
    });
    return [...patterns];
  }

  if (sawDefineConfigCall) {
    RSTEST_INCLUDE_PATTERNS_CACHE.set(configFilePath, {
      version,
      value: []
    });
    return [];
  }

  // Fallback for unusual config wrappers where include can only be located heuristically.
  let fallbackPatterns: string[] | undefined;
  const fallbackVisit = (node: ts.Node): void => {
    if (fallbackPatterns !== undefined) {
      return;
    }

    if (
      ts.isPropertyAssignment(node) &&
      isPropertyNameText(node.name, "include")
    ) {
      const extracted = readPatternsFromIncludeInitializer(node.initializer);
      if (extracted !== undefined && fallbackPatterns === undefined) {
        fallbackPatterns = extracted;
      }
    }
    ts.forEachChild(node, fallbackVisit);
  };
  fallbackVisit(sourceFile);
  const resolvedPatterns = fallbackPatterns ?? [];
  RSTEST_INCLUDE_PATTERNS_CACHE.set(configFilePath, {
    version,
    value: [...resolvedPatterns]
  });
  return [...resolvedPatterns];
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
test[\`only\`]("only template bracket", () => {});
test[\`concurrent\`][\`skip\`]("concurrent skip template bracket", () => {});
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
        { title: "concurrent skip bracket", modifiers: ["concurrent", "skip"] },
        { title: "only template bracket", modifiers: ["only"] },
        {
          title: "concurrent skip template bracket",
          modifiers: ["concurrent", "skip"]
        }
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

  test("ignores non-source directories during suite discovery", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const ignoredNodeModulesDirectory = path.join(tempDirectory, "node_modules", "pkg");
    const ignoredGitDirectory = path.join(tempDirectory, ".git");
    const ignoredDistDirectory = path.join(tempDirectory, "dist");
    const sourceDirectory = path.join(tempDirectory, "src");

    fs.mkdirSync(ignoredNodeModulesDirectory, { recursive: true });
    fs.mkdirSync(ignoredGitDirectory, { recursive: true });
    fs.mkdirSync(ignoredDistDirectory, { recursive: true });
    fs.mkdirSync(sourceDirectory, { recursive: true });

    fs.writeFileSync(
      path.join(ignoredNodeModulesDirectory, "ignored.test.ts"),
      "test(\"ignored\", () => {});",
      "utf8"
    );
    fs.writeFileSync(
      path.join(ignoredGitDirectory, "ignored.test.ts"),
      "test(\"ignored\", () => {});",
      "utf8"
    );
    fs.writeFileSync(
      path.join(ignoredDistDirectory, "ignored.test.ts"),
      "test(\"ignored\", () => {});",
      "utf8"
    );
    fs.writeFileSync(path.join(sourceDirectory, "kept.test.ts"), "test(\"kept\", () => {});", "utf8");

    try {
      expect(listDiscoveredTestSuites(tempDirectory)).toEqual(["src/kept.test.ts"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("discovers supported test file extensions", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    fs.mkdirSync(path.join(tempDirectory, "nested"), { recursive: true });

    fs.writeFileSync(path.join(tempDirectory, "alpha.test.ts"), "test(\"alpha\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "beta.test.tsx"), "test(\"beta\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "gamma.test.mts"), "test(\"gamma\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "delta.test.cts"), "test(\"delta\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "epsilon.test.js"), "test(\"epsilon\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "zeta.test.jsx"), "test(\"zeta\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "eta.test.mjs"), "test(\"eta\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "theta.test.cjs"), "test(\"theta\", () => {});", "utf8");
    fs.writeFileSync(path.join(tempDirectory, "ignored.spec.js"), "test(\"ignored\", () => {});", "utf8");
    fs.writeFileSync(
      path.join(tempDirectory, "nested", "nested.test.tsx"),
      "test(\"nested\", () => {});",
      "utf8"
    );

    try {
      expect(listDiscoveredTestSuites(tempDirectory)).toEqual([
        "alpha.test.ts",
        "beta.test.tsx",
        "delta.test.cts",
        "epsilon.test.js",
        "eta.test.mjs",
        "gamma.test.mts",
        "nested/nested.test.tsx",
        "theta.test.cjs",
        "zeta.test.jsx"
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("parses executable test titles from tsx fixtures", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "tsx-fixture.test.tsx");

    fs.writeFileSync(
      fixturePath,
      `
const element = <div data-kind="fixture">hello</div>;
void element;
test("tsx title", () => {});
`,
      "utf8"
    );

    try {
      expect(readTestTitles(fixturePath)).toEqual(["tsx title"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("parses executable test titles from jsx fixtures", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const fixturePath = path.join(tempDirectory, "jsx-fixture.test.jsx");

    fs.writeFileSync(
      fixturePath,
      `
const element = <section data-kind="fixture">hello</section>;
void element;
test("jsx title", () => {});
`,
      "utf8"
    );

    try {
      expect(readTestTitles(fixturePath)).toEqual(["jsx title"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("parses executable test titles from js, mjs, and cjs fixtures", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const jsFixturePath = path.join(tempDirectory, "js-fixture.test.js");
    const mjsFixturePath = path.join(tempDirectory, "mjs-fixture.test.mjs");
    const cjsFixturePath = path.join(tempDirectory, "cjs-fixture.test.cjs");

    fs.writeFileSync(
      jsFixturePath,
      `
const payload = { kind: "js" };
void payload;
test("js title", () => {});
`,
      "utf8"
    );
    fs.writeFileSync(
      mjsFixturePath,
      `
export const payload = { kind: "mjs" };
test("mjs title", () => {});
`,
      "utf8"
    );
    fs.writeFileSync(
      cjsFixturePath,
      `
const payload = { kind: "cjs" };
module.exports = payload;
test("cjs title", () => {});
`,
      "utf8"
    );

    try {
      expect(readTestTitles(jsFixturePath)).toEqual(["js title"]);
      expect(readTestTitles(mjsFixturePath)).toEqual(["mjs title"]);
      expect(readTestTitles(cjsFixturePath)).toEqual(["cjs title"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("parses executable test titles from mts and cts fixtures", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const mtsFixturePath = path.join(tempDirectory, "mts-fixture.test.mts");
    const ctsFixturePath = path.join(tempDirectory, "cts-fixture.test.cts");

    fs.writeFileSync(
      mtsFixturePath,
      `
export const value = 1;
test("mts title", () => {});
`,
      "utf8"
    );
    fs.writeFileSync(
      ctsFixturePath,
      `
const value = 1;
void value;
test("cts title", () => {});
`,
      "utf8"
    );

    try {
      expect(readTestTitles(mtsFixturePath)).toEqual(["mts title"]);
      expect(readTestTitles(ctsFixturePath)).toEqual(["cts title"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("accepts only supported test file suffixes", () => {
    expect(isSupportedTestFileName("alpha.test.ts")).toBe(true);
    expect(isSupportedTestFileName("beta.test.tsx")).toBe(true);
    expect(isSupportedTestFileName("gamma.test.mts")).toBe(true);
    expect(isSupportedTestFileName("delta.test.cts")).toBe(true);
    expect(isSupportedTestFileName("epsilon.test.js")).toBe(true);
    expect(isSupportedTestFileName("zeta.test.jsx")).toBe(true);
    expect(isSupportedTestFileName("eta.test.mjs")).toBe(true);
    expect(isSupportedTestFileName("theta.test.cjs")).toBe(true);

    expect(isSupportedTestFileName("ignored.spec.ts")).toBe(false);
    expect(isSupportedTestFileName("ignored.test.d.ts")).toBe(false);
    expect(isSupportedTestFileName("ignored.ts")).toBe(false);
    expect(isSupportedTestFileName("ignored.js")).toBe(false);
    expect(isSupportedTestFileName("IGNORED.TEST.TS")).toBe(false);
  });

  test("maps script kinds by supported file extension", () => {
    expect(getScriptKindFromFilePath("alpha.test.ts")).toBe(ts.ScriptKind.TS);
    expect(getScriptKindFromFilePath("beta.test.tsx")).toBe(ts.ScriptKind.TSX);
    expect(getScriptKindFromFilePath("gamma.test.mts")).toBe(ts.ScriptKind.TS);
    expect(getScriptKindFromFilePath("delta.test.cts")).toBe(ts.ScriptKind.TS);
    expect(getScriptKindFromFilePath("epsilon.test.js")).toBe(ts.ScriptKind.JS);
    expect(getScriptKindFromFilePath("zeta.test.jsx")).toBe(ts.ScriptKind.JSX);
    expect(getScriptKindFromFilePath("eta.test.mjs")).toBe(ts.ScriptKind.JS);
    expect(getScriptKindFromFilePath("theta.test.cjs")).toBe(ts.ScriptKind.JS);
    expect(getScriptKindFromFilePath("fallback.unknown")).toBe(ts.ScriptKind.TS);
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

  test("keeps SUPPORTED_TEST_FILE_SUFFIXES sorted and unique", () => {
    const suffixes = [...SUPPORTED_TEST_FILE_SUFFIXES];
    const sorted = [...suffixes].sort();
    const unique = Array.from(new Set(suffixes));

    expect(
      suffixes,
      [
        "SUPPORTED_TEST_FILE_SUFFIXES must remain sorted for readability and stable discovery behavior.",
        `Expected sorted order: ${sorted.join(", ")}`
      ].join("\n")
    ).toEqual(sorted);

    expect(
      suffixes.length,
      [
        "SUPPORTED_TEST_FILE_SUFFIXES must not contain duplicate entries.",
        `Unique count: ${unique.length}, actual count: ${suffixes.length}`
      ].join("\n")
    ).toBe(unique.length);
  });

  test("keeps guarded suite entries aligned with supported suffixes", () => {
    const invalidEntries = GUARDED_TEST_SUITES.filter((suiteFile) => {
      const baseName = path.basename(suiteFile);
      return !isSupportedTestFileName(baseName);
    });

    expect(
      invalidEntries,
      [
        "GUARDED_TEST_SUITES entries must use supported test file suffixes.",
        ...invalidEntries.map((entry) => `- ${entry}`)
      ].join("\n")
    ).toEqual([]);
  });

  test("keeps ignored discovery directory list sorted and unique", () => {
    const ignoredDirectories = [...IGNORED_TEST_DISCOVERY_DIRECTORIES];
    const sorted = [...ignoredDirectories].sort();
    const unique = Array.from(new Set(ignoredDirectories));

    expect(
      ignoredDirectories,
      [
        "IGNORED_TEST_DISCOVERY_DIRECTORIES should remain sorted for readability.",
        `Expected sorted order: ${sorted.join(", ")}`
      ].join("\n")
    ).toEqual(sorted);

    expect(
      ignoredDirectories.length,
      [
        "IGNORED_TEST_DISCOVERY_DIRECTORIES must not contain duplicates.",
        `Unique count: ${unique.length}, actual count: ${ignoredDirectories.length}`
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

  test("documents and wires the matrix guard command", () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["test:matrix"]).toBe("rstest run test/coverage-matrix.test.ts");

    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    expect(readme.includes("pnpm test:matrix")).toBe(true);
  });

  test("documents supported test suffixes in README", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const missingSuffixMentions = SUPPORTED_TEST_FILE_SUFFIXES.filter(
      (suffix) => !readme.includes(`\`${suffix}\``)
    );

    expect(
      missingSuffixMentions,
      [
        "README is missing supported test suffix mentions:",
        ...missingSuffixMentions.map((suffix) => `- ${suffix}`)
      ].join("\n")
    ).toEqual([]);
  });

  test("documents rstest include parser coverage notes in README", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const requiredSnippets = [
      "alias import",
      "default-import namespace access",
      "TypeScript `import = require` bindings",
      "namespace/property or namespace-element access",
      "direct `require(\"@rstest/core\").defineConfig(...)`/`[\"defineConfig\"](...)` calls",
      "CommonJS `require(\"@rstest/core\")` namespace/destructured bindings",
      "scoped to symbols bound from `@rstest/core`",
      "array of string literals",
      "single string literal",
      "including static spread array literals",
      "dynamic/non-literal values are ignored",
      "object spread entries in recognized config objects are handled conservatively",
      "non-assignment `include` members (for example getters/setters/methods) are treated as non-literal overrides",
      "follows last-assignment object-literal semantics",
      "heuristic include fallback scanning is only used when no recognized `defineConfig` call is present",
      "config-file extension variants (`.js`, `.mjs`, `.cjs`, `.mts`, `.cts`)",
      "top-level exports (`export default`, `module.exports`, `exports.default`, `module.exports.default`), those exported call sites (including simple identifier references to top-level `defineConfig(...)` results and chained assignment forms) are preferred over non-export helper calls",
      "repeated top-level export assignments, include extraction follows last-assignment statement order"
    ];
    const missingSnippets = requiredSnippets.filter((snippet) => !readme.includes(snippet));

    expect(
      missingSnippets,
      [
        "README is missing rstest include parser coverage notes:",
        ...missingSnippets.map((snippet) => `- ${snippet}`)
      ].join("\n")
    ).toEqual([]);
  });

  test("reads rstest include patterns from array and single-string forms", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const arrayConfigPath = path.join(tempDirectory, "rstest-array.config.ts");
    const wrappedArrayElementsConfigPath = path.join(
      tempDirectory,
      "rstest-wrapped-array-elements.config.ts"
    );
    const spreadArrayElementsConfigPath = path.join(
      tempDirectory,
      "rstest-spread-array-elements.config.ts"
    );
    const nestedSpreadArrayElementsConfigPath = path.join(
      tempDirectory,
      "rstest-nested-spread-array-elements.config.ts"
    );
    const duplicateIncludeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-duplicate-include-literal.config.ts"
    );
    const duplicateIncludeNonLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-duplicate-include-non-literal.config.ts"
    );
    const duplicateIncludeShorthandNonLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-duplicate-include-shorthand-non-literal.config.ts"
    );
    const objectSpreadLiteralOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-object-spread-literal-override.config.ts"
    );
    const objectSpreadDynamicOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-object-spread-dynamic-override.config.ts"
    );
    const objectSpreadNestedDynamicOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-object-spread-nested-dynamic-override.config.ts"
    );
    const objectSpreadDynamicBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-object-spread-dynamic-before-literal.config.ts"
    );
    const objectSpreadNestedDynamicBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-object-spread-nested-dynamic-before-literal.config.ts"
    );
    const includeGetterOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-include-getter-override.config.ts"
    );
    const includeGetterBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-include-getter-before-literal.config.ts"
    );
    const includeComputedGetterOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-include-computed-getter-override.config.ts"
    );
    const includeComputedGetterBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-include-computed-getter-before-literal.config.ts"
    );
    const includeMethodOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-include-method-override.config.ts"
    );
    const includeMethodBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-include-method-before-literal.config.ts"
    );
    const includeComputedMethodOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-include-computed-method-override.config.ts"
    );
    const includeComputedMethodBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-include-computed-method-before-literal.config.ts"
    );
    const includeSetterOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-include-setter-override.config.ts"
    );
    const includeComputedSetterOverrideConfigPath = path.join(
      tempDirectory,
      "rstest-include-computed-setter-override.config.ts"
    );
    const includeSetterBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-include-setter-before-literal.config.ts"
    );
    const includeComputedSetterBeforeLiteralConfigPath = path.join(
      tempDirectory,
      "rstest-include-computed-setter-before-literal.config.ts"
    );
    const exportedDefineConfigPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-define-config-preferred.config.ts"
    );
    const exportedModuleExportsPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-exports-preferred.config.js"
    );
    const exportedExportsDefaultPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-exports-default-preferred.config.js"
    );
    const exportedExportsDefaultElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-exports-default-element-preferred.config.js"
    );
    const exportedWrappedExportsDefaultElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-wrapped-exports-default-element-preferred.config.js"
    );
    const exportedExportsDefaultIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-exports-default-identifier-preferred.config.js"
    );
    const exportedExportsDefaultElementIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-exports-default-element-identifier-preferred.config.js"
    );
    const exportedWrappedExportsDefaultElementIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-wrapped-exports-default-element-identifier-preferred.config.js"
    );
    const exportedModuleElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-element-preferred.config.js"
    );
    const exportedWrappedModulePreferredPath = path.join(
      tempDirectory,
      "rstest-exported-wrapped-module-preferred.config.js"
    );
    const exportedWrappedDefaultPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-wrapped-default-preferred.config.js"
    );
    const exportedWrappedDefaultIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-wrapped-default-identifier-preferred.config.js"
    );
    const exportedWrappedModuleDefaultElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-wrapped-module-default-element-preferred.config.js"
    );
    const exportedWrappedModuleDefaultElementIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-wrapped-module-default-element-identifier-preferred.config.js"
    );
    const exportedModuleDefaultPropertyPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-default-property-preferred.config.js"
    );
    const exportedModuleDefaultMixedElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-default-mixed-element-preferred.config.js"
    );
    const exportedModuleDefaultTemplateElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-default-template-element-preferred.config.js"
    );
    const exportedModuleElementDefaultPropertyPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-element-default-property-preferred.config.js"
    );
    const exportedModuleTemplateDefaultPropertyPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-template-default-property-preferred.config.js"
    );
    const exportedModuleDefaultElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-default-element-preferred.config.js"
    );
    const exportedModuleDefaultPropertyIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-default-property-identifier-preferred.config.js"
    );
    const exportedModuleDefaultMixedElementIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-default-mixed-element-identifier-preferred.config.js"
    );
    const exportedModuleTemplateDefaultElementPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-template-default-element-preferred.config.js"
    );
    const exportedModuleTemplateDefaultElementIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-template-default-element-identifier-preferred.config.js"
    );
    const exportedModuleDefaultElementIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-default-element-identifier-preferred.config.js"
    );
    const exportedModuleElementDefaultPropertyIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-element-default-property-identifier-preferred.config.js"
    );
    const exportedEqualsPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-equals-preferred.config.ts"
    );
    const exportedIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-identifier-preferred.config.ts"
    );
    const exportedIdentifierChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-identifier-chain-preferred.config.ts"
    );
    const exportedModuleIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-identifier-preferred.config.js"
    );
    const exportedModuleElementIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-element-identifier-preferred.config.js"
    );
    const exportedDefaultIdentifierPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-default-identifier-preferred.config.js"
    );
    const exportedIdentifierReassignmentPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-identifier-reassignment-preferred.config.ts"
    );
    const exportedIdentifierAssignmentChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-identifier-assignment-chain-preferred.config.ts"
    );
    const exportedModuleChainAssignmentPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-chain-assignment-preferred.config.js"
    );
    const exportedModuleToExportsElementChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-to-exports-element-chain-preferred.config.js"
    );
    const exportedParenthesizedElementChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-parenthesized-element-chain-preferred.config.js"
    );
    const exportedAssertedElementChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-asserted-element-chain-preferred.config.ts"
    );
    const exportedExportsElementToModuleChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-exports-element-to-module-chain-preferred.config.js"
    );
    const exportedTemplateElementChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-template-element-chain-preferred.config.js"
    );
    const exportedModuleToExportsElementIdentifierChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-to-exports-element-identifier-chain-preferred.config.js"
    );
    const exportedExportsElementToModuleIdentifierChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-exports-element-to-module-identifier-chain-preferred.config.js"
    );
    const exportedTemplateElementIdentifierChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-template-element-identifier-chain-preferred.config.js"
    );
    const exportedDefaultToModuleChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-default-to-module-chain-preferred.config.js"
    );
    const exportedModuleToIdentifierChainPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-to-identifier-chain-preferred.config.js"
    );
    const exportedMixedTargetReassignmentPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-mixed-target-reassignment-preferred.config.js"
    );
    const exportedMixedTargetNonLiteralLastPath = path.join(
      tempDirectory,
      "rstest-exported-mixed-target-non-literal-last.config.js"
    );
    const exportedMixedTargetLiteralLastPath = path.join(
      tempDirectory,
      "rstest-exported-mixed-target-literal-last.config.js"
    );
    const exportedMixedTargetInverseNonLiteralLastPath = path.join(
      tempDirectory,
      "rstest-exported-mixed-target-inverse-non-literal-last.config.js"
    );
    const exportedMixedTargetInverseLiteralLastPath = path.join(
      tempDirectory,
      "rstest-exported-mixed-target-inverse-literal-last.config.js"
    );
    const exportedModuleDuplicateLiteralPath = path.join(
      tempDirectory,
      "rstest-exported-module-duplicate-literal.config.js"
    );
    const exportedModuleDuplicateNonLiteralPath = path.join(
      tempDirectory,
      "rstest-exported-module-duplicate-non-literal.config.js"
    );
    const exportedDefaultCommaPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-default-comma-preferred.config.ts"
    );
    const exportedModuleCommaPreferredPath = path.join(
      tempDirectory,
      "rstest-exported-module-comma-preferred.config.js"
    );
    const exportedIdentifierNonLiteralPath = path.join(
      tempDirectory,
      "rstest-exported-identifier-non-literal.config.ts"
    );
    const exportedNonLiteralBeatsHelperLiteralPath = path.join(
      tempDirectory,
      "rstest-exported-non-literal-beats-helper-literal.config.ts"
    );
    const stringConfigPath = path.join(tempDirectory, "rstest-string.config.ts");
    const typeAssertionConfigPath = path.join(tempDirectory, "rstest-type-assertion.config.ts");
    const nonNullConfigPath = path.join(tempDirectory, "rstest-non-null.config.ts");
    const preferredConfigPath = path.join(tempDirectory, "rstest-preferred.config.ts");
    const namespaceConfigPath = path.join(tempDirectory, "rstest-namespace.config.ts");
    const defaultImportConfigPath = path.join(tempDirectory, "rstest-default-import.config.ts");
    const defaultImportElementConfigPath = path.join(
      tempDirectory,
      "rstest-default-import-element.config.ts"
    );
    const namespaceElementAccessConfigPath = path.join(
      tempDirectory,
      "rstest-namespace-element-access.config.ts"
    );
    const namespaceParenthesizedElementAccessConfigPath = path.join(
      tempDirectory,
      "rstest-namespace-parenthesized-element-access.config.ts"
    );
    const namespaceAssertedElementAccessConfigPath = path.join(
      tempDirectory,
      "rstest-namespace-asserted-element-access.config.ts"
    );
    const wrappedNamespacePropertyConfigPath = path.join(
      tempDirectory,
      "rstest-wrapped-namespace-property.config.ts"
    );
    const wrappedNamespaceElementConfigPath = path.join(
      tempDirectory,
      "rstest-wrapped-namespace-element.config.ts"
    );
    const requireNamespaceConfigPath = path.join(tempDirectory, "rstest-require-namespace.config.ts");
    const requireAssertedNamespaceConfigPath = path.join(
      tempDirectory,
      "rstest-require-asserted-namespace.config.ts"
    );
    const requireTemplateConfigPath = path.join(tempDirectory, "rstest-require-template.config.ts");
    const requireAliasConfigPath = path.join(tempDirectory, "rstest-require-alias.config.ts");
    const requireQuotedAliasConfigPath = path.join(
      tempDirectory,
      "rstest-require-quoted-alias.config.ts"
    );
    const requireShorthandConfigPath = path.join(
      tempDirectory,
      "rstest-require-shorthand.config.ts"
    );
    const requireDirectPropertyConfigPath = path.join(
      tempDirectory,
      "rstest-require-direct-property.config.ts"
    );
    const requireDirectElementConfigPath = path.join(
      tempDirectory,
      "rstest-require-direct-element.config.ts"
    );
    const parenthesizedRequireConfigPath = path.join(
      tempDirectory,
      "rstest-parenthesized-require.config.ts"
    );
    const importEqualsConfigPath = path.join(tempDirectory, "rstest-import-equals.config.ts");
    const importEqualsElementConfigPath = path.join(
      tempDirectory,
      "rstest-import-equals-element.config.ts"
    );
    const jsConfigPath = path.join(tempDirectory, "rstest-js.config.js");
    const cjsConfigPath = path.join(tempDirectory, "rstest-cjs.config.cjs");
    const mjsConfigPath = path.join(tempDirectory, "rstest-mjs.config.mjs");
    const mtsConfigPath = path.join(tempDirectory, "rstest-mts.config.mts");
    const ctsConfigPath = path.join(tempDirectory, "rstest-cts.config.cts");
    const localShadowConfigPath = path.join(tempDirectory, "rstest-local-shadow.config.ts");
    const wrappedCalleeConfigPath = path.join(tempDirectory, "rstest-wrapped-callee.config.ts");
    const quotedIncludeKeyConfigPath = path.join(tempDirectory, "rstest-quoted-include-key.config.ts");
    const templateIncludeKeyConfigPath = path.join(
      tempDirectory,
      "rstest-template-include-key.config.ts"
    );
    const parenthesizedComputedIncludeKeyConfigPath = path.join(
      tempDirectory,
      "rstest-parenthesized-computed-include-key.config.ts"
    );
    const assertedComputedIncludeKeyConfigPath = path.join(
      tempDirectory,
      "rstest-asserted-computed-include-key.config.ts"
    );
    const propertyAccessConfigPath = path.join(tempDirectory, "rstest-property-access.config.ts");
    const elementAccessConfigPath = path.join(tempDirectory, "rstest-element-access.config.ts");
    const aliasConfigPath = path.join(tempDirectory, "rstest-alias.config.ts");
    const fallbackConfigPath = path.join(tempDirectory, "rstest-fallback.config.ts");

    fs.writeFileSync(
      arrayConfigPath,
      `
import { defineConfig } from "@rstest/core";
const dynamic = "test/**/*.ignored.ts";

export default defineConfig({
  include: ([
    "test/**/*.test.ts",
    \`test/**/*.test.tsx\`,
    dynamic
  ] satisfies string[])
});
`,
      "utf8"
    );
    fs.writeFileSync(
      wrappedArrayElementsConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: [
    ("test/**/*.wrapped-array-parenthesized.test.ts"),
    "test/**/*.wrapped-array-asserted.test.ts" as const,
    \`test/**/*.wrapped-array-template.test.ts\`
  ]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      spreadArrayElementsConfigPath,
      `
import { defineConfig } from "@rstest/core";

const dynamicPatterns = ["test/**/*.spread-array-dynamic-should-not-be-read.ts"];

export default defineConfig({
  include: [
    "test/**/*.spread-array-direct.test.ts",
    ...[
      "test/**/*.spread-array-static-a.test.ts" as const,
      \`test/**/*.spread-array-static-b.test.ts\`
    ],
    ...dynamicPatterns
  ]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      nestedSpreadArrayElementsConfigPath,
      `
import { defineConfig } from "@rstest/core";

const dynamicPatterns = ["test/**/*.nested-spread-dynamic-should-not-be-read.ts"];

export default defineConfig({
  include: [
    ...[
      "test/**/*.nested-spread-static-a.test.ts",
      ...[
        "test/**/*.nested-spread-static-b.test.ts" as const,
        \`test/**/*.nested-spread-static-c.test.ts\`
      ]
    ],
    ...dynamicPatterns
  ]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      duplicateIncludeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.duplicate-include-first.test.ts"],
  include: ["test/**/*.duplicate-include-last.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      duplicateIncludeNonLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

const nonLiteralInclude = ["test/**/*.duplicate-include-non-literal-last.test.ts"];

export default defineConfig({
  include: ["test/**/*.duplicate-include-should-not-be-read.test.ts"],
  include: nonLiteralInclude
});
`,
      "utf8"
    );
    fs.writeFileSync(
      duplicateIncludeShorthandNonLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

const include = ["test/**/*.duplicate-include-shorthand-non-literal-last.test.ts"];

export default defineConfig({
  include: ["test/**/*.duplicate-include-shorthand-should-not-be-read.test.ts"],
  include
});
`,
      "utf8"
    );
    fs.writeFileSync(
      objectSpreadLiteralOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.object-spread-literal-first.test.ts"],
  ...{
    include: ["test/**/*.object-spread-literal-last.test.ts"]
  }
});
`,
      "utf8"
    );
    fs.writeFileSync(
      objectSpreadDynamicOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

const overrides = {
  include: ["test/**/*.object-spread-dynamic-last.test.ts"]
};

export default defineConfig({
  include: ["test/**/*.object-spread-dynamic-should-not-be-read.test.ts"],
  ...overrides
});
`,
      "utf8"
    );
    fs.writeFileSync(
      objectSpreadNestedDynamicOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

const overrides = {
  include: ["test/**/*.object-spread-nested-dynamic-last.test.ts"]
};

export default defineConfig({
  include: ["test/**/*.object-spread-nested-dynamic-should-not-be-read.test.ts"],
  ...({
    ...overrides
  })
});
`,
      "utf8"
    );
    fs.writeFileSync(
      objectSpreadDynamicBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

const overrides = {
  include: ["test/**/*.object-spread-dynamic-before-literal-should-not-be-read.test.ts"]
};

export default defineConfig({
  ...overrides,
  include: ["test/**/*.object-spread-dynamic-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      objectSpreadNestedDynamicBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

const overrides = {
  include: ["test/**/*.object-spread-nested-dynamic-before-literal-should-not-be-read.test.ts"]
};

export default defineConfig({
  ...({
    ...overrides
  }),
  include: ["test/**/*.object-spread-nested-dynamic-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeGetterOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.include-getter-override-should-not-be-read.test.ts"],
  get include() {
    return ["test/**/*.include-getter-override.test.ts"];
  }
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeGetterBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  get include() {
    return ["test/**/*.include-getter-before-literal-should-not-be-read.test.ts"];
  },
  include: ["test/**/*.include-getter-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeComputedGetterOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.include-computed-getter-override-should-not-be-read.test.ts"],
  get ["include"]() {
    return ["test/**/*.include-computed-getter-override.test.ts"];
  }
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeComputedGetterBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  get [\`include\`]() {
    return ["test/**/*.include-computed-getter-before-literal-should-not-be-read.test.ts"];
  },
  include: ["test/**/*.include-computed-getter-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeMethodOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.include-method-override-should-not-be-read.test.ts"],
  include() {
    return ["test/**/*.include-method-override.test.ts"];
  }
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeMethodBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include() {
    return ["test/**/*.include-method-before-literal-should-not-be-read.test.ts"];
  },
  include: ["test/**/*.include-method-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeComputedMethodOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.include-computed-method-override-should-not-be-read.test.ts"],
  ["include"]() {
    return ["test/**/*.include-computed-method-override.test.ts"];
  }
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeComputedMethodBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  [\`include\`]() {
    return ["test/**/*.include-computed-method-before-literal-should-not-be-read.test.ts"];
  },
  include: ["test/**/*.include-computed-method-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeSetterOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.include-setter-override-should-not-be-read.test.ts"],
  set include(value) {
    void value;
  }
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeComputedSetterOverrideConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.include-computed-setter-override-should-not-be-read.test.ts"],
  set ["include"](value) {
    void value;
  }
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeSetterBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  set include(value) {
    void value;
  },
  include: ["test/**/*.include-setter-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      includeComputedSetterBeforeLiteralConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  set [\`include\`](value) {
    void value;
  },
  include: ["test/**/*.include-computed-setter-before-literal.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedDefineConfigPreferredPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = defineConfig({
  include: ["test/**/*.exported-define-preferred-should-not-be-read.ts"]
});
void unrelated;

export default defineConfig({
  include: ["test/**/*.exported-define-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleExportsPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-exports-preferred-should-not-be-read.ts"]
});
void unrelated;

module.exports = defineConfig({
  include: ["test/**/*.module-exports-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedExportsDefaultPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exports-default-preferred-should-not-be-read.ts"]
});
void unrelated;

exports.default = defineConfig({
  include: ["test/**/*.exports-default-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedExportsDefaultElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exports-default-element-preferred-should-not-be-read.ts"]
});
void unrelated;

exports["default"] = defineConfig({
  include: ["test/**/*.exports-default-element-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedWrappedExportsDefaultElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.wrapped-exports-default-element-should-not-be-read.ts"]
});
void unrelated;

(exports["default"]) = defineConfig({
  include: ["test/**/*.wrapped-exports-default-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedExportsDefaultIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exports-default-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.exports-default-identifier.test.ts"]
});

exports.default = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedExportsDefaultElementIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exports-default-element-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.exports-default-element-identifier.test.ts"]
});

exports["default"] = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedWrappedExportsDefaultElementIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.wrapped-exports-default-element-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.wrapped-exports-default-element-identifier.test.ts"]
});

(exports["default"]) = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-element-preferred-should-not-be-read.ts"]
});
void unrelated;

module["exports"] = defineConfig({
  include: ["test/**/*.module-element-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedWrappedModulePreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.wrapped-module-preferred-should-not-be-read.ts"]
});
void unrelated;

(module).exports = defineConfig({
  include: ["test/**/*.wrapped-module-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedWrappedDefaultPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.wrapped-default-preferred-should-not-be-read.ts"]
});
void unrelated;

(exports).default = defineConfig({
  include: ["test/**/*.wrapped-default-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedWrappedDefaultIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.wrapped-default-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.wrapped-default-identifier.test.ts"]
});

(exports).default = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedWrappedModuleDefaultElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.wrapped-module-default-element-should-not-be-read.ts"]
});
void unrelated;

(module["exports"])["default"] = defineConfig({
  include: ["test/**/*.wrapped-module-default-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedWrappedModuleDefaultElementIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.wrapped-module-default-element-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.wrapped-module-default-element-identifier.test.ts"]
});

(module["exports"])["default"] = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDefaultPropertyPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-default-property-should-not-be-read.ts"]
});
void unrelated;

module.exports.default = defineConfig({
  include: ["test/**/*.module-default-property.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDefaultMixedElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-default-mixed-element-should-not-be-read.ts"]
});
void unrelated;

module.exports["default"] = defineConfig({
  include: ["test/**/*.module-default-mixed-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDefaultTemplateElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-default-template-element-should-not-be-read.ts"]
});
void unrelated;

module.exports[\`default\`] = defineConfig({
  include: ["test/**/*.module-default-template-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleElementDefaultPropertyPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-element-default-property-should-not-be-read.ts"]
});
void unrelated;

module["exports"].default = defineConfig({
  include: ["test/**/*.module-element-default-property.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleTemplateDefaultPropertyPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-template-default-property-should-not-be-read.ts"]
});
void unrelated;

module[\`exports\`].default = defineConfig({
  include: ["test/**/*.module-template-default-property.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDefaultElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-default-element-should-not-be-read.ts"]
});
void unrelated;

module["exports"]["default"] = defineConfig({
  include: ["test/**/*.module-default-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDefaultPropertyIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-default-property-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.module-default-property-identifier.test.ts"]
});

module.exports.default = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDefaultMixedElementIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-default-mixed-element-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.module-default-mixed-element-identifier.test.ts"]
});

module.exports["default"] = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleTemplateDefaultElementPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-template-default-element-should-not-be-read.ts"]
});
void unrelated;

module[\`exports\`][\`default\`] = defineConfig({
  include: ["test/**/*.module-template-default-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleTemplateDefaultElementIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-template-default-element-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.module-template-default-element-identifier.test.ts"]
});

module[\`exports\`][\`default\`] = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDefaultElementIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-default-element-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.module-default-element-identifier.test.ts"]
});

module["exports"]["default"] = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleElementDefaultPropertyIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.module-element-default-property-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.module-element-default-property-identifier.test.ts"]
});

module["exports"].default = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedEqualsPreferredPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = defineConfig({
  include: ["test/**/*.export-equals-preferred-should-not-be-read.ts"]
});
void unrelated;

export = defineConfig({
  include: ["test/**/*.export-equals-preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedIdentifierPreferredPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = defineConfig({
  include: ["test/**/*.exported-identifier-preferred-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.exported-identifier-preferred.test.ts"]
});

export default config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedIdentifierChainPreferredPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = defineConfig({
  include: ["test/**/*.exported-identifier-chain-should-not-be-read.ts"]
});
void unrelated;

const baseConfig = defineConfig({
  include: ["test/**/*.exported-identifier-chain.test.ts"]
});
const exportedConfig = baseConfig;

export default exportedConfig;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-module-identifier-preferred-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.exported-module-identifier-preferred.test.ts"]
});

module.exports = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleElementIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-module-element-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.exported-module-element-identifier.test.ts"]
});

module["exports"] = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedDefaultIdentifierPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-default-identifier-should-not-be-read.ts"]
});
void unrelated;

const config = defineConfig({
  include: ["test/**/*.exported-default-identifier.test.ts"]
});

exports.default = config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedIdentifierReassignmentPreferredPath,
      `
import { defineConfig } from "@rstest/core";

let config = defineConfig({
  include: ["test/**/*.exported-identifier-reassignment-first.test.ts"]
});

config = defineConfig({
  include: ["test/**/*.exported-identifier-reassignment-second.test.ts"]
});

export default config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedIdentifierAssignmentChainPreferredPath,
      `
import { defineConfig } from "@rstest/core";

let config: unknown;
let alias: unknown;

config = alias = defineConfig({
  include: ["test/**/*.exported-identifier-assignment-chain.test.ts"]
});

export default config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleChainAssignmentPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-chain-assignment-should-not-be-read.ts"]
});
void unrelated;

module.exports = exports.default = defineConfig({
  include: ["test/**/*.exported-chain-assignment.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleToExportsElementChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-chain-element-should-not-be-read.ts"]
});
void unrelated;

module.exports = exports["default"] = defineConfig({
  include: ["test/**/*.exported-chain-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedParenthesizedElementChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-parenthesized-chain-should-not-be-read.ts"]
});
void unrelated;

module[("exports")] = exports[("default")] = defineConfig({
  include: ["test/**/*.exported-parenthesized-chain.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedExportsElementToModuleChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-element-to-module-should-not-be-read.ts"]
});
void unrelated;

exports["default"] = module.exports = defineConfig({
  include: ["test/**/*.exported-element-to-module.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedTemplateElementChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-template-chain-should-not-be-read.ts"]
});
void unrelated;

module[\`exports\`] = exports[\`default\`] = defineConfig({
  include: ["test/**/*.exported-template-chain.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleToExportsElementIdentifierChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-chain-element-identifier-should-not-be-read.ts"]
});
void unrelated;

let config;
module.exports = exports["default"] = config = defineConfig({
  include: ["test/**/*.exported-chain-element-identifier.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedExportsElementToModuleIdentifierChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-element-to-module-identifier-should-not-be-read.ts"]
});
void unrelated;

let config;
exports["default"] = module.exports = config = defineConfig({
  include: ["test/**/*.exported-element-to-module-identifier.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedTemplateElementIdentifierChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-template-chain-identifier-should-not-be-read.ts"]
});
void unrelated;

let config;
module[\`exports\`] = exports[\`default\`] = config = defineConfig({
  include: ["test/**/*.exported-template-chain-identifier.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedDefaultToModuleChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-default-to-module-should-not-be-read.ts"]
});
void unrelated;

exports.default = module.exports = defineConfig({
  include: ["test/**/*.exported-default-to-module.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleToIdentifierChainPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-module-to-identifier-should-not-be-read.ts"]
});
void unrelated;

let config;
module.exports = config = defineConfig({
  include: ["test/**/*.exported-module-to-identifier.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedMixedTargetReassignmentPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

exports.default = defineConfig({
  include: ["test/**/*.exported-mixed-target-first.test.ts"]
});

module.exports = defineConfig({
  include: ["test/**/*.exported-mixed-target-second.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedMixedTargetNonLiteralLastPath,
      `
const { defineConfig } = require("@rstest/core");

const dynamicInclude = ["test/**/*.exported-mixed-target-non-literal-last.test.ts"];

exports.default = defineConfig({
  include: ["test/**/*.exported-mixed-target-non-literal-first.test.ts"]
});

module.exports = defineConfig({
  include: dynamicInclude
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedMixedTargetLiteralLastPath,
      `
const { defineConfig } = require("@rstest/core");

const dynamicInclude = ["test/**/*.exported-mixed-target-literal-first.test.ts"];

exports.default = defineConfig({
  include: dynamicInclude
});

module.exports = defineConfig({
  include: ["test/**/*.exported-mixed-target-literal-last.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedMixedTargetInverseNonLiteralLastPath,
      `
const { defineConfig } = require("@rstest/core");

const dynamicInclude = ["test/**/*.exported-mixed-target-inverse-non-literal-last.test.ts"];

module.exports = defineConfig({
  include: ["test/**/*.exported-mixed-target-inverse-non-literal-first.test.ts"]
});

exports["default"] = defineConfig({
  include: dynamicInclude
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedMixedTargetInverseLiteralLastPath,
      `
const { defineConfig } = require("@rstest/core");

const dynamicInclude = ["test/**/*.exported-mixed-target-inverse-literal-first.test.ts"];

module.exports = defineConfig({
  include: dynamicInclude
});

exports["default"] = defineConfig({
  include: ["test/**/*.exported-mixed-target-inverse-literal-last.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDuplicateLiteralPath,
      `
const { defineConfig } = require("@rstest/core");

module.exports = defineConfig({
  include: ["test/**/*.exported-module-duplicate-first.test.ts"]
});

module.exports = defineConfig({
  include: ["test/**/*.exported-module-duplicate-last.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleDuplicateNonLiteralPath,
      `
const { defineConfig } = require("@rstest/core");

const includePatterns = ["test/**/*.exported-module-duplicate-non-literal.test.ts"];

module.exports = defineConfig({
  include: ["test/**/*.exported-module-duplicate-should-not-be-read.test.ts"]
});

module.exports = defineConfig({
  include: includePatterns
});
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedDefaultCommaPreferredPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = defineConfig({
  include: ["test/**/*.exported-default-comma-should-not-be-read.ts"]
});

export default (unrelated, defineConfig({
  include: ["test/**/*.exported-default-comma.test.ts"]
}));
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedModuleCommaPreferredPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = defineConfig({
  include: ["test/**/*.exported-module-comma-should-not-be-read.ts"]
});

module.exports = (unrelated, defineConfig({
  include: ["test/**/*.exported-module-comma.test.ts"]
}));
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedIdentifierNonLiteralPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = {
  include: ["test/**/*.exported-identifier-non-literal-fallback-should-not-be-read.ts"]
};
void unrelated;

const includePatterns = ["test/**/*.exported-identifier-non-literal.test.ts"];
const config = defineConfig({
  include: includePatterns
});

export default config;
`,
      "utf8"
    );
    fs.writeFileSync(
      exportedNonLiteralBeatsHelperLiteralPath,
      `
import { defineConfig } from "@rstest/core";

const helper = defineConfig({
  include: ["test/**/*.exported-non-literal-helper-should-not-be-read.test.ts"]
});
void helper;

const includePatterns = ["test/**/*.exported-non-literal-beats-helper.test.ts"];

export default defineConfig({
  include: includePatterns
});
`,
      "utf8"
    );
    fs.writeFileSync(
      stringConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ("test/**/*.test.js")
});
`,
      "utf8"
    );
    fs.writeFileSync(
      typeAssertionConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: (<string[]>["test/**/*.type-asserted.test.ts"])
});
`,
      "utf8"
    );
    fs.writeFileSync(
      nonNullConfigPath,
      `
import { defineConfig } from "@rstest/core";

const includePatterns: string[] | undefined = ["test/**/*.non-null.test.ts"];

export default defineConfig({
  include: includePatterns!
});
`,
      "utf8"
    );
    fs.writeFileSync(
      preferredConfigPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = {
  include: ["test/**/*.should-not-be-read.ts"]
};
void unrelated;

export default defineConfig({
  include: ["test/**/*.preferred.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      namespaceConfigPath,
      `
import * as rstest from "@rstest/core";

const unrelated = {
  include: ["test/**/*.namespace-should-not-be-read.ts"]
};
void unrelated;

export default rstest.defineConfig({
  include: ["test/**/*.namespace.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      defaultImportConfigPath,
      `
import rstest from "@rstest/core";

const unrelated = {
  include: ["test/**/*.default-import-should-not-be-read.ts"]
};
void unrelated;

export default rstest.defineConfig({
  include: ["test/**/*.default-import.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      defaultImportElementConfigPath,
      `
import rstest from "@rstest/core";

const unrelated = {
  include: ["test/**/*.default-import-element-should-not-be-read.ts"]
};
void unrelated;

export default rstest["defineConfig"]({
  include: ["test/**/*.default-import-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      namespaceElementAccessConfigPath,
      `
import * as rstest from "@rstest/core";

const unrelated = {
  include: ["test/**/*.namespace-element-should-not-be-read.ts"]
};
void unrelated;

export default rstest["defineConfig"]({
  include: ["test/**/*.namespace-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      namespaceParenthesizedElementAccessConfigPath,
      `
import * as rstest from "@rstest/core";

const unrelated = {
  include: ["test/**/*.namespace-parenthesized-element-should-not-be-read.ts"]
};
void unrelated;

export default rstest[("defineConfig")]({
  include: ["test/**/*.namespace-parenthesized-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      wrappedNamespacePropertyConfigPath,
      `
import * as rstest from "@rstest/core";

const unrelated = {
  include: ["test/**/*.wrapped-namespace-property-should-not-be-read.ts"]
};
void unrelated;

export default (rstest).defineConfig({
  include: ["test/**/*.wrapped-namespace-property.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      wrappedNamespaceElementConfigPath,
      `
import * as rstest from "@rstest/core";

const unrelated = {
  include: ["test/**/*.wrapped-namespace-element-should-not-be-read.ts"]
};
void unrelated;

export default (rstest)["defineConfig"]({
  include: ["test/**/*.wrapped-namespace-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireNamespaceConfigPath,
      `
const rstest = require("@rstest/core");

const unrelated = {
  include: ["test/**/*.require-namespace-should-not-be-read.ts"]
};
void unrelated;

export default rstest.defineConfig({
  include: ["test/**/*.require-namespace.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireAssertedNamespaceConfigPath,
      `
const rstest = require("@rstest/core") as typeof import("@rstest/core");

const unrelated = {
  include: ["test/**/*.require-asserted-namespace-should-not-be-read.ts"]
};
void unrelated;

export default rstest.defineConfig({
  include: ["test/**/*.require-asserted-namespace.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireTemplateConfigPath,
      `
const rstest = require(\`@rstest/core\`);

const unrelated = {
  include: ["test/**/*.require-template-should-not-be-read.ts"]
};
void unrelated;

export default rstest.defineConfig({
  include: ["test/**/*.require-template.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireAliasConfigPath,
      `
const { defineConfig: makeConfig } = require("@rstest/core");

const unrelated = {
  include: ["test/**/*.require-alias-should-not-be-read.ts"]
};
void unrelated;

export default makeConfig({
  include: ["test/**/*.require-alias.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireQuotedAliasConfigPath,
      `
const { "defineConfig": makeConfig } = require("@rstest/core");

const unrelated = {
  include: ["test/**/*.require-quoted-alias-should-not-be-read.ts"]
};
void unrelated;

export default makeConfig({
  include: ["test/**/*.require-quoted-alias.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireShorthandConfigPath,
      `
const { defineConfig } = require("@rstest/core");

const unrelated = {
  include: ["test/**/*.require-shorthand-should-not-be-read.ts"]
};
void unrelated;

export default defineConfig({
  include: ["test/**/*.require-shorthand.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireDirectPropertyConfigPath,
      `
const unrelated = {
  include: ["test/**/*.require-direct-property-should-not-be-read.ts"]
};
void unrelated;

export default require("@rstest/core").defineConfig({
  include: ["test/**/*.require-direct-property.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      requireDirectElementConfigPath,
      `
const unrelated = {
  include: ["test/**/*.require-direct-element-should-not-be-read.ts"]
};
void unrelated;

export default require("@rstest/core")["defineConfig"]({
  include: ["test/**/*.require-direct-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      parenthesizedRequireConfigPath,
      `
const unrelated = {
  include: ["test/**/*.parenthesized-require-should-not-be-read.ts"]
};
void unrelated;

export default (require("@rstest/core")).defineConfig({
  include: ["test/**/*.parenthesized-require.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      importEqualsConfigPath,
      `
import rstest = require("@rstest/core");

const unrelated = {
  include: ["test/**/*.import-equals-should-not-be-read.ts"]
};
void unrelated;

export default rstest.defineConfig({
  include: ["test/**/*.import-equals.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      importEqualsElementConfigPath,
      `
import rstest = require("@rstest/core");

const unrelated = {
  include: ["test/**/*.import-equals-element-should-not-be-read.ts"]
};
void unrelated;

export default rstest["defineConfig"]({
  include: ["test/**/*.import-equals-element.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      jsConfigPath,
      `
const unrelated = {
  include: ["test/**/*.js-config-should-not-be-read.ts"]
};
void unrelated;

module.exports = require("@rstest/core").defineConfig({
  include: ["test/**/*.js-config.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      cjsConfigPath,
      `
const unrelated = {
  include: ["test/**/*.cjs-config-should-not-be-read.ts"]
};
void unrelated;

module.exports = require("@rstest/core").defineConfig({
  include: ["test/**/*.cjs-config.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      mjsConfigPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = {
  include: ["test/**/*.mjs-config-should-not-be-read.ts"]
};
void unrelated;

export default defineConfig({
  include: ["test/**/*.mjs-config.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      mtsConfigPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = {
  include: ["test/**/*.mts-config-should-not-be-read.ts"]
};
void unrelated;

export default defineConfig({
  include: ["test/**/*.mts-config.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      ctsConfigPath,
      `
import core = require("@rstest/core");

const unrelated = {
  include: ["test/**/*.cts-config-should-not-be-read.ts"]
};
void unrelated;

export default core.defineConfig({
  include: ["test/**/*.cts-config.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      localShadowConfigPath,
      `
import { defineConfig as makeConfig } from "@rstest/core";

const defineConfig = (value: unknown) => value;
const unrelated = defineConfig({
  include: ["test/**/*.shadow-should-not-be-read.ts"]
});
void unrelated;

export default makeConfig({
  include: ["test/**/*.shadow.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      wrappedCalleeConfigPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = {
  include: ["test/**/*.wrapped-callee-should-not-be-read.ts"]
};
void unrelated;

export default (defineConfig)({
  include: ["test/**/*.wrapped-callee.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      quotedIncludeKeyConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  "include": ["test/**/*.quoted-include.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      templateIncludeKeyConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  [\`include\`]: ["test/**/*.template-include.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      parenthesizedComputedIncludeKeyConfigPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  [("include")]: ["test/**/*.parenthesized-computed-include.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      propertyAccessConfigPath,
      `
const core = {
  defineConfig(value) {
    return value;
  }
};

export default core.defineConfig({
  include: ["test/**/*.property-access.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      elementAccessConfigPath,
      `
const core = {
  defineConfig(value) {
    return value;
  }
};

export default core["defineConfig"]({
  include: ["test/**/*.element-access.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      aliasConfigPath,
      `
import { defineConfig as makeConfig } from "@rstest/core";

export default makeConfig({
  include: ["test/**/*.alias.test.ts"]
});
`,
      "utf8"
    );
    fs.writeFileSync(
      fallbackConfigPath,
      `
const config = {
  include: ["test/**/*.fallback-first.test.ts"]
};

const secondary = {
  include: ["test/**/*.fallback-second.test.ts"]
};

void secondary;
export default config;
`,
      "utf8"
    );

    try {
      expect(readRstestIncludePatterns(arrayConfigPath)).toEqual([
        "test/**/*.test.ts",
        "test/**/*.test.tsx"
      ]);
      expect(readRstestIncludePatterns(wrappedArrayElementsConfigPath)).toEqual([
        "test/**/*.wrapped-array-parenthesized.test.ts",
        "test/**/*.wrapped-array-asserted.test.ts",
        "test/**/*.wrapped-array-template.test.ts"
      ]);
      expect(readRstestIncludePatterns(spreadArrayElementsConfigPath)).toEqual([
        "test/**/*.spread-array-direct.test.ts",
        "test/**/*.spread-array-static-a.test.ts",
        "test/**/*.spread-array-static-b.test.ts"
      ]);
      expect(readRstestIncludePatterns(nestedSpreadArrayElementsConfigPath)).toEqual([
        "test/**/*.nested-spread-static-a.test.ts",
        "test/**/*.nested-spread-static-b.test.ts",
        "test/**/*.nested-spread-static-c.test.ts"
      ]);
      expect(readRstestIncludePatterns(duplicateIncludeLiteralConfigPath)).toEqual([
        "test/**/*.duplicate-include-last.test.ts"
      ]);
      expect(readRstestIncludePatterns(duplicateIncludeNonLiteralConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(duplicateIncludeShorthandNonLiteralConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(objectSpreadLiteralOverrideConfigPath)).toEqual([
        "test/**/*.object-spread-literal-last.test.ts"
      ]);
      expect(readRstestIncludePatterns(objectSpreadDynamicOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(objectSpreadNestedDynamicOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(objectSpreadDynamicBeforeLiteralConfigPath)).toEqual([
        "test/**/*.object-spread-dynamic-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(objectSpreadNestedDynamicBeforeLiteralConfigPath)).toEqual([
        "test/**/*.object-spread-nested-dynamic-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(includeGetterOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(includeGetterBeforeLiteralConfigPath)).toEqual([
        "test/**/*.include-getter-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(includeComputedGetterOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(includeComputedGetterBeforeLiteralConfigPath)).toEqual([
        "test/**/*.include-computed-getter-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(includeMethodOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(includeMethodBeforeLiteralConfigPath)).toEqual([
        "test/**/*.include-method-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(includeComputedMethodOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(includeComputedMethodBeforeLiteralConfigPath)).toEqual([
        "test/**/*.include-computed-method-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(includeSetterOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(includeComputedSetterOverrideConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(includeSetterBeforeLiteralConfigPath)).toEqual([
        "test/**/*.include-setter-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(includeComputedSetterBeforeLiteralConfigPath)).toEqual([
        "test/**/*.include-computed-setter-before-literal.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedDefineConfigPreferredPath)).toEqual([
        "test/**/*.exported-define-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleExportsPreferredPath)).toEqual([
        "test/**/*.module-exports-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedExportsDefaultPreferredPath)).toEqual([
        "test/**/*.exports-default-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedExportsDefaultElementPreferredPath)).toEqual([
        "test/**/*.exports-default-element-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedWrappedExportsDefaultElementPreferredPath)).toEqual([
        "test/**/*.wrapped-exports-default-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedExportsDefaultIdentifierPreferredPath)).toEqual([
        "test/**/*.exports-default-identifier.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedExportsDefaultElementIdentifierPreferredPath)).toEqual([
        "test/**/*.exports-default-element-identifier.test.ts"
      ]);
      expect(
        readRstestIncludePatterns(exportedWrappedExportsDefaultElementIdentifierPreferredPath)
      ).toEqual(["test/**/*.wrapped-exports-default-element-identifier.test.ts"]);
      expect(readRstestIncludePatterns(exportedModuleElementPreferredPath)).toEqual([
        "test/**/*.module-element-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedWrappedModulePreferredPath)).toEqual([
        "test/**/*.wrapped-module-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedWrappedDefaultPreferredPath)).toEqual([
        "test/**/*.wrapped-default-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedWrappedDefaultIdentifierPreferredPath)).toEqual([
        "test/**/*.wrapped-default-identifier.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedWrappedModuleDefaultElementPreferredPath)).toEqual([
        "test/**/*.wrapped-module-default-element.test.ts"
      ]);
      expect(
        readRstestIncludePatterns(exportedWrappedModuleDefaultElementIdentifierPreferredPath)
      ).toEqual(["test/**/*.wrapped-module-default-element-identifier.test.ts"]);
      expect(readRstestIncludePatterns(exportedModuleDefaultPropertyPreferredPath)).toEqual([
        "test/**/*.module-default-property.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleDefaultMixedElementPreferredPath)).toEqual([
        "test/**/*.module-default-mixed-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleDefaultTemplateElementPreferredPath)).toEqual([
        "test/**/*.module-default-template-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleElementDefaultPropertyPreferredPath)).toEqual([
        "test/**/*.module-element-default-property.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleTemplateDefaultPropertyPreferredPath)).toEqual(
        ["test/**/*.module-template-default-property.test.ts"]
      );
      expect(readRstestIncludePatterns(exportedModuleDefaultElementPreferredPath)).toEqual([
        "test/**/*.module-default-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleDefaultPropertyIdentifierPreferredPath)).toEqual([
        "test/**/*.module-default-property-identifier.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleDefaultMixedElementIdentifierPreferredPath)).toEqual([
        "test/**/*.module-default-mixed-element-identifier.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleTemplateDefaultElementPreferredPath)).toEqual([
        "test/**/*.module-template-default-element.test.ts"
      ]);
      expect(
        readRstestIncludePatterns(exportedModuleTemplateDefaultElementIdentifierPreferredPath)
      ).toEqual(["test/**/*.module-template-default-element-identifier.test.ts"]);
      expect(readRstestIncludePatterns(exportedModuleDefaultElementIdentifierPreferredPath)).toEqual([
        "test/**/*.module-default-element-identifier.test.ts"
      ]);
      expect(
        readRstestIncludePatterns(exportedModuleElementDefaultPropertyIdentifierPreferredPath)
      ).toEqual(["test/**/*.module-element-default-property-identifier.test.ts"]);
      expect(readRstestIncludePatterns(exportedEqualsPreferredPath)).toEqual([
        "test/**/*.export-equals-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedIdentifierPreferredPath)).toEqual([
        "test/**/*.exported-identifier-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedIdentifierChainPreferredPath)).toEqual([
        "test/**/*.exported-identifier-chain.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleIdentifierPreferredPath)).toEqual([
        "test/**/*.exported-module-identifier-preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleElementIdentifierPreferredPath)).toEqual([
        "test/**/*.exported-module-element-identifier.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedDefaultIdentifierPreferredPath)).toEqual([
        "test/**/*.exported-default-identifier.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedIdentifierReassignmentPreferredPath)).toEqual([
        "test/**/*.exported-identifier-reassignment-second.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedIdentifierAssignmentChainPreferredPath)).toEqual([
        "test/**/*.exported-identifier-assignment-chain.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleChainAssignmentPreferredPath)).toEqual([
        "test/**/*.exported-chain-assignment.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleToExportsElementChainPreferredPath)).toEqual([
        "test/**/*.exported-chain-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedParenthesizedElementChainPreferredPath)).toEqual([
        "test/**/*.exported-parenthesized-chain.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedExportsElementToModuleChainPreferredPath)).toEqual([
        "test/**/*.exported-element-to-module.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedTemplateElementChainPreferredPath)).toEqual([
        "test/**/*.exported-template-chain.test.ts"
      ]);
      expect(
        readRstestIncludePatterns(exportedModuleToExportsElementIdentifierChainPreferredPath)
      ).toEqual(["test/**/*.exported-chain-element-identifier.test.ts"]);
      expect(
        readRstestIncludePatterns(exportedExportsElementToModuleIdentifierChainPreferredPath)
      ).toEqual(["test/**/*.exported-element-to-module-identifier.test.ts"]);
      expect(readRstestIncludePatterns(exportedTemplateElementIdentifierChainPreferredPath)).toEqual(
        ["test/**/*.exported-template-chain-identifier.test.ts"]
      );
      expect(readRstestIncludePatterns(exportedDefaultToModuleChainPreferredPath)).toEqual([
        "test/**/*.exported-default-to-module.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleToIdentifierChainPreferredPath)).toEqual([
        "test/**/*.exported-module-to-identifier.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedMixedTargetReassignmentPreferredPath)).toEqual([
        "test/**/*.exported-mixed-target-second.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedMixedTargetNonLiteralLastPath)).toEqual([]);
      expect(readRstestIncludePatterns(exportedMixedTargetLiteralLastPath)).toEqual([
        "test/**/*.exported-mixed-target-literal-last.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedMixedTargetInverseNonLiteralLastPath)).toEqual([]);
      expect(readRstestIncludePatterns(exportedMixedTargetInverseLiteralLastPath)).toEqual([
        "test/**/*.exported-mixed-target-inverse-literal-last.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleDuplicateLiteralPath)).toEqual([
        "test/**/*.exported-module-duplicate-last.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleDuplicateNonLiteralPath)).toEqual([]);
      expect(readRstestIncludePatterns(exportedDefaultCommaPreferredPath)).toEqual([
        "test/**/*.exported-default-comma.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedModuleCommaPreferredPath)).toEqual([
        "test/**/*.exported-module-comma.test.ts"
      ]);
      expect(readRstestIncludePatterns(exportedIdentifierNonLiteralPath)).toEqual([]);
      expect(readRstestIncludePatterns(exportedNonLiteralBeatsHelperLiteralPath)).toEqual([]);
      expect(readRstestIncludePatterns(stringConfigPath)).toEqual(["test/**/*.test.js"]);
      expect(readRstestIncludePatterns(typeAssertionConfigPath)).toEqual([
        "test/**/*.type-asserted.test.ts"
      ]);
      expect(readRstestIncludePatterns(nonNullConfigPath)).toEqual([]);
      expect(readRstestIncludePatterns(preferredConfigPath)).toEqual([
        "test/**/*.preferred.test.ts"
      ]);
      expect(readRstestIncludePatterns(namespaceConfigPath)).toEqual([
        "test/**/*.namespace.test.ts"
      ]);
      expect(readRstestIncludePatterns(defaultImportConfigPath)).toEqual([
        "test/**/*.default-import.test.ts"
      ]);
      expect(readRstestIncludePatterns(defaultImportElementConfigPath)).toEqual([
        "test/**/*.default-import-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(namespaceElementAccessConfigPath)).toEqual([
        "test/**/*.namespace-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(namespaceParenthesizedElementAccessConfigPath)).toEqual([
        "test/**/*.namespace-parenthesized-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(wrappedNamespacePropertyConfigPath)).toEqual([
        "test/**/*.wrapped-namespace-property.test.ts"
      ]);
      expect(readRstestIncludePatterns(wrappedNamespaceElementConfigPath)).toEqual([
        "test/**/*.wrapped-namespace-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireNamespaceConfigPath)).toEqual([
        "test/**/*.require-namespace.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireAssertedNamespaceConfigPath)).toEqual([
        "test/**/*.require-asserted-namespace.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireTemplateConfigPath)).toEqual([
        "test/**/*.require-template.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireAliasConfigPath)).toEqual([
        "test/**/*.require-alias.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireQuotedAliasConfigPath)).toEqual([
        "test/**/*.require-quoted-alias.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireShorthandConfigPath)).toEqual([
        "test/**/*.require-shorthand.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireDirectPropertyConfigPath)).toEqual([
        "test/**/*.require-direct-property.test.ts"
      ]);
      expect(readRstestIncludePatterns(requireDirectElementConfigPath)).toEqual([
        "test/**/*.require-direct-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(parenthesizedRequireConfigPath)).toEqual([
        "test/**/*.parenthesized-require.test.ts"
      ]);
      expect(readRstestIncludePatterns(importEqualsConfigPath)).toEqual([
        "test/**/*.import-equals.test.ts"
      ]);
      expect(readRstestIncludePatterns(importEqualsElementConfigPath)).toEqual([
        "test/**/*.import-equals-element.test.ts"
      ]);
      expect(readRstestIncludePatterns(jsConfigPath)).toEqual([
        "test/**/*.js-config.test.ts"
      ]);
      expect(readRstestIncludePatterns(cjsConfigPath)).toEqual([
        "test/**/*.cjs-config.test.ts"
      ]);
      expect(readRstestIncludePatterns(mjsConfigPath)).toEqual([
        "test/**/*.mjs-config.test.ts"
      ]);
      expect(readRstestIncludePatterns(mtsConfigPath)).toEqual([
        "test/**/*.mts-config.test.ts"
      ]);
      expect(readRstestIncludePatterns(ctsConfigPath)).toEqual([
        "test/**/*.cts-config.test.ts"
      ]);
      expect(readRstestIncludePatterns(localShadowConfigPath)).toEqual([
        "test/**/*.shadow.test.ts"
      ]);
      expect(readRstestIncludePatterns(wrappedCalleeConfigPath)).toEqual([
        "test/**/*.wrapped-callee.test.ts"
      ]);
      expect(readRstestIncludePatterns(quotedIncludeKeyConfigPath)).toEqual([
        "test/**/*.quoted-include.test.ts"
      ]);
      expect(readRstestIncludePatterns(templateIncludeKeyConfigPath)).toEqual([
        "test/**/*.template-include.test.ts"
      ]);
      expect(readRstestIncludePatterns(parenthesizedComputedIncludeKeyConfigPath)).toEqual([
        "test/**/*.parenthesized-computed-include.test.ts"
      ]);
      expect(readRstestIncludePatterns(propertyAccessConfigPath)).toEqual([
        "test/**/*.property-access.test.ts"
      ]);
      expect(readRstestIncludePatterns(elementAccessConfigPath)).toEqual([
        "test/**/*.element-access.test.ts"
      ]);
      expect(readRstestIncludePatterns(aliasConfigPath)).toEqual([
        "test/**/*.alias.test.ts"
      ]);
      expect(readRstestIncludePatterns(fallbackConfigPath)).toEqual([
        "test/**/*.fallback-first.test.ts"
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("returns empty include patterns for missing or non-literal include values", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const missingIncludePath = path.join(tempDirectory, "rstest-missing-include.config.ts");
    const nonLiteralIncludePath = path.join(tempDirectory, "rstest-non-literal-include.config.ts");
    const nonLiteralWithFallbackPath = path.join(
      tempDirectory,
      "rstest-non-literal-with-fallback.config.ts"
    );
    const missingDefineConfigArgumentPath = path.join(
      tempDirectory,
      "rstest-missing-define-config-argument.config.ts"
    );
    const dynamicIncludeKeyPath = path.join(tempDirectory, "rstest-dynamic-include-key.config.ts");

    fs.writeFileSync(
      missingIncludePath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  testEnvironment: "node"
});
`,
      "utf8"
    );
    fs.writeFileSync(
      nonLiteralIncludePath,
      `
import { defineConfig } from "@rstest/core";

const includePatterns = ["test/**/*.dynamic.test.ts"];

export default defineConfig({
  include: includePatterns
});
`,
      "utf8"
    );
    fs.writeFileSync(
      nonLiteralWithFallbackPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = {
  include: ["test/**/*.fallback-should-not-be-read.ts"]
};
void unrelated;

const includeValue = ["test/**/*.non-literal-with-fallback.test.ts"];

export default defineConfig({
  include: includeValue
});
`,
      "utf8"
    );
    fs.writeFileSync(
      missingDefineConfigArgumentPath,
      `
import { defineConfig } from "@rstest/core";

const unrelated = {
  include: ["test/**/*.missing-argument-fallback-should-not-be-read.ts"]
};
void unrelated;

export default defineConfig();
`,
      "utf8"
    );
    fs.writeFileSync(
      dynamicIncludeKeyPath,
      `
import { defineConfig } from "@rstest/core";

const includeKey = "include";

export default defineConfig({
  [includeKey]: ["test/**/*.dynamic-include-key.test.ts"]
});
`,
      "utf8"
    );

    try {
      expect(readRstestIncludePatterns(missingIncludePath)).toEqual([]);
      expect(readRstestIncludePatterns(nonLiteralIncludePath)).toEqual([]);
      expect(readRstestIncludePatterns(nonLiteralWithFallbackPath)).toEqual([]);
      expect(readRstestIncludePatterns(missingDefineConfigArgumentPath)).toEqual([]);
      expect(readRstestIncludePatterns(dynamicIncludeKeyPath)).toEqual([]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("returns defensive copies for cached rstest include patterns", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const configPath = path.join(tempDirectory, "rstest-include-copy.config.ts");

    fs.writeFileSync(
      configPath,
      `
import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["test/**/*.test.ts"]
});
`,
      "utf8"
    );

    try {
      const firstRead = readRstestIncludePatterns(configPath);
      firstRead.push("test/**/*.injected.ts");

      expect(readRstestIncludePatterns(configPath)).toEqual(["test/**/*.test.ts"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("invalidates cached rstest include patterns when config file changes", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rstest-workers-matrix-"));
    const configPath = path.join(tempDirectory, "rstest-include-cache-invalidation.config.ts");

    fs.writeFileSync(
      configPath,
      `
import { defineConfig } from "@rstest/core";
export default defineConfig({
  include: ["test/**/*.before.test.ts"]
});
`,
      "utf8"
    );

    try {
      expect(readRstestIncludePatterns(configPath)).toEqual(["test/**/*.before.test.ts"]);

      fs.writeFileSync(
        configPath,
        `
import { defineConfig } from "@rstest/core";
export default defineConfig({
  include: ["test/**/*.after.test.ts"]
});
`,
        "utf8"
      );
      const now = Date.now();
      fs.utimesSync(configPath, now / 1000, (now + 1000) / 1000);

      expect(readRstestIncludePatterns(configPath)).toEqual(["test/**/*.after.test.ts"]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test("keeps rstest include patterns aligned with supported test suffixes", () => {
    const rstestConfigPath = path.join(process.cwd(), "rstest.config.ts");
    const configuredPatterns = readRstestIncludePatterns(rstestConfigPath);
    const expectedPatterns = SUPPORTED_TEST_FILE_SUFFIXES.map(
      (suffix) => `test/**/*${suffix}`
    );
    const unexpectedPatterns = configuredPatterns.filter(
      (pattern) => !expectedPatterns.includes(pattern)
    );
    const missingPatterns = expectedPatterns.filter(
      (pattern) => !configuredPatterns.includes(pattern)
    );

    expect(
      configuredPatterns,
      "rstest include patterns should remain in the same order as SUPPORTED_TEST_FILE_SUFFIXES."
    ).toEqual(expectedPatterns);

    expect(
      missingPatterns,
      [
        "rstest.config.ts is missing include patterns for supported test suffixes:",
        ...missingPatterns.map((pattern) => `- ${pattern}`)
      ].join("\n")
    ).toEqual([]);

    expect(
      unexpectedPatterns,
      [
        "rstest.config.ts has unexpected include patterns not represented in SUPPORTED_TEST_FILE_SUFFIXES:",
        ...unexpectedPatterns.map((pattern) => `- ${pattern}`)
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
      "recreateWorkerInstance resets global state when singleWorker is disabled",
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
      "runDurableObjectAlarm invokes RPC-callable alarm handlers for real stubs",
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
      "runDurableObjectAlarm validates argument types and returns false when unavailable",
      "runInDurableObject rejects stubs outside same-worker namespaces when runtime bindings are available",
      "runInDurableObject only accepts namespaces designated as same-isolate by runtime metadata",
      "runInDurableObject rejects stubs when runtime bindings contain no Durable Object namespaces",
      "runDurableObjectAlarm executes alarm method when stub belongs to same-worker namespace",
      "runDurableObjectAlarm returns false when same-worker stub has no alarm method",
      "runDurableObjectAlarm rejects stubs outside same-worker namespaces when runtime bindings are available",
      "listDurableObjectIds validates namespace argument type",
      "listDurableObjectIds rejects namespace-like objects without DurableObjectNamespace constructor identity",
      "workflow introspection APIs throw with explicit guidance",
      "WorkersRuntimeState same-isolate namespace resolution excludes scriptName-scoped bindings"
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
