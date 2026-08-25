import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import fg from "fast-glob";
import {
  isUnsupportedCommonJsRouteFileName,
  ROUTE_IGNORE_PATTERNS,
  ROUTE_SOURCE_PATTERNS,
  shouldIncludeRouteFilePath,
} from "../../lib/route-file-policy.js";
import {
  assertCanonicalRouteFactoryBody,
  createCanonicalRouteIdentity,
  normalizeRegisteredRoutePath,
  VEXT_ROUTE_METHODS,
} from "../../lib/route-contract.js";
import { detectRouteSourceDocsKind } from "../../lib/openapi/route-docs-kind.js";
import { SchemaConverter } from "../../lib/openapi/schema-converter.js";
import type { VextOpenAPIDocsKind } from "../../lib/openapi/types.js";
import { schemaAdapter } from "../../lib/schema-adapter.js";
import type { DslBuilder } from "../../lib/schema-adapter.js";
import {
  createDigest,
  createRouteFreshnessIdentity,
  projectRouteSchemaContract,
} from "../../frontend/contract/schema-ir.js";
import {
  normalizeDocumentedResponseSelector,
  normalizeRuntimeResponseSelector,
  resolveRouteResponseJsonSchema,
} from "../../lib/response-serializer.js";
import type {
  VextRouteFreshnessIdentity,
  VextRouteResponseSchemaV1,
  VextRouteSchemaContractV1,
  VextSchemaIRV1,
} from "../../frontend/contract/types.js";
import type {
  RouteOptions,
  VextRouteFrontendOptions,
} from "../../types/app.js";
const HTTP_METHODS = [...VEXT_ROUTE_METHODS];

const schemaConverter = new SchemaConverter();
const NO_CANONICAL_FIELD_BUILDER = Symbol("no-canonical-field-builder");

interface StaticRouteResponseDefinition {
  status: string;
  contentType: string;
  source: "responses" | "docs.responses";
  schema?: Record<string, unknown> | string;
}

interface ConstBindingContext {
  bindings: ReadonlyMap<string, string>;
  ambiguousBindings: ReadonlySet<string>;
}

interface StaticScanContext extends ConstBindingContext {
  schemaAdapterBindings: ReadonlySet<string>;
}

interface RouteModuleContext {
  defineRoutesBindings: ReadonlySet<string>;
  topLevelBindings: ReadonlyMap<string, string>;
  ambiguousTopLevelBindings: ReadonlySet<string>;
  defaultExportExpression: string;
}

interface RouteProjectionContext {
  fileRelativePath: string;
  method: string;
  routePath?: string;
}

interface DefineRoutesBlock {
  paramName: string;
  body: string;
  maskedBody: string;
}

export interface RouteIndexEntry {
  filePath: string;
  fileRelativePath: string;
  prefix: string;
  method: string;
  path: string;
  docsSummary: string | null;
  hasDocsSummary: boolean;
  operationId: string | null;
  tags: string[];
  hidden: boolean;
  docsKind: VextOpenAPIDocsKind;
  schema: VextRouteSchemaContractV1;
  freshness: VextRouteFreshnessIdentity;
}

export interface RouteSourceSnapshot {
  fingerprint: string;
  files: string[];
}

export async function createRouteSourceSnapshot(
  rootDir: string,
): Promise<RouteSourceSnapshot> {
  const routesDir = join(rootDir, "src", "routes");
  if (!existsSync(routesDir)) {
    return { fingerprint: createDigest([]), files: [] };
  }
  const routeFiles = (
    await fg(ROUTE_SOURCE_PATTERNS, {
      cwd: routesDir,
      absolute: true,
      onlyFiles: true,
      ignore: ROUTE_IGNORE_PATTERNS,
    })
  ).sort((left, right) => left.localeCompare(right));
  const sources = routeFiles.map((filePath) => ({
    file: relative(rootDir, filePath).split(sep).join("/"),
    content: readFileSync(filePath, "utf-8"),
  }));
  return {
    fingerprint: createDigest(sources),
    files: sources.map((source) => source.file),
  };
}

export async function buildRouteIndex(
  rootDir: string,
): Promise<RouteIndexEntry[]> {
  const routesDir = join(rootDir, "src", "routes");
  if (!existsSync(routesDir)) {
    return [];
  }

  const routeFiles = (
    await fg(ROUTE_SOURCE_PATTERNS, {
      cwd: routesDir,
      absolute: true,
      onlyFiles: true,
      ignore: ROUTE_IGNORE_PATTERNS,
    })
  ).sort((left, right) => left.localeCompare(right));
  const commonJsRoute = routeFiles.find((filePath) =>
    isUnsupportedCommonJsRouteFileName(basename(filePath)),
  );
  if (commonJsRoute) {
    throw routeModuleError(
      relative(rootDir, commonJsRoute).split(sep).join("/"),
      "uses unsupported CommonJS route source; convert it to TypeScript or an ESM .js/.mjs module",
    );
  }

  const includedFiles = routeFiles
    .filter((filePath) => shouldIncludeRouteFilePath(filePath, routesDir))
    .sort((left, right) => left.localeCompare(right));
  assertUniqueRouteFilePrefixes(includedFiles, rootDir, routesDir);
  const entries = includedFiles
    .flatMap((filePath) => scanRouteEntries(filePath, rootDir, routesDir))
    .sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    );
  assertUniqueRouteEntries(entries);
  return entries;
}

function scanRouteEntries(
  filePath: string,
  rootDir: string,
  routesDir: string,
): RouteIndexEntry[] {
  const source = readFileSync(filePath, "utf-8");
  const prefix = filePathToRoutePrefix(filePath, routesDir);
  const fileRelativePath = relative(rootDir, filePath).split(sep).join("/");
  const entries: RouteIndexEntry[] = [];
  const staticContext = collectConstBindings(source);

  for (const block of [
    findDefaultExportedDefineRoutesBlock(source, fileRelativePath),
  ]) {
    const expectedRegistrations = assertCanonicalRouteFactoryBody(
      block.paramName,
      block.body,
      fileRelativePath,
    );
    const methodPattern = new RegExp(
      `(?<![\\w$.])${escapeRegExp(block.paramName)}\\.(${HTTP_METHODS.join("|")})\\s*\\(`,
      "gu",
    );

    for (const match of block.maskedBody.matchAll(methodPattern)) {
      const method = match[1]!.toUpperCase();
      const baseContext: RouteProjectionContext = {
        fileRelativePath,
        method,
      };
      assertDirectRouteRegistration(
        block.maskedBody,
        match.index!,
        baseContext,
      );
      const openParen = block.maskedBody.indexOf("(", match.index);
      const closeParen = findMatchingIndex(
        block.maskedBody,
        openParen,
        "(",
        ")",
      );
      if (closeParen < 0) {
        throw projectionError(baseContext, "route call is not balanced");
      }

      const args = splitTopLevelArgs(
        block.body.slice(openParen + 1, closeParen),
      );
      if (args.length !== 2 && args.length !== 3) {
        throw projectionError(
          baseContext,
          "route call must use app.method(path, handler) or app.method(path, options, handler)",
        );
      }
      const routePath = readStaticStringExpression(
        args[0],
        staticContext,
        baseContext,
        "route path expression must be statically resolvable",
      );
      const normalizedPath = normalizeRegisteredRoutePath(prefix, routePath);
      const context: RouteProjectionContext = {
        ...baseContext,
        routePath: normalizedPath,
      };
      const optionsObject =
        args.length >= 3
          ? readStaticObjectExpression(
              args[1],
              staticContext,
              context,
              "route options",
            )
          : undefined;

      const docs = readRouteDocs(optionsObject, staticContext, context);
      const responses = mergeRouteResponseDefinitions(
        readRouteResponseDefinitions(
          optionsObject,
          "responses",
          staticContext,
          context,
        ),
        docs.responses,
      );
      const frontend =
        optionsObject !== undefined
          ? readRouteFrontend(optionsObject, staticContext, context)
          : undefined;
      const handler = args.length >= 3 ? args[2] : args[1];

      entries.push({
        filePath,
        fileRelativePath,
        prefix,
        method,
        path: normalizedPath,
        docsSummary: docs.docsSummary,
        hasDocsSummary: docs.hasDocsSummary,
        operationId: docs.operationId,
        tags: docs.tags,
        hidden: docs.hidden,
        docsKind:
          frontend !== undefined
            ? "frontend-route"
            : detectRouteSourceDocsKind(
                resolveStaticExpressionSource(
                  handler ?? "",
                  staticContext,
                  `${formatProjectionContext(context)} route handler`,
                ),
              ),
        schema: createRouteSchemaContract(
          optionsObject,
          responses,
          method,
          staticContext,
          context,
        ),
        freshness: createRouteFreshnessIdentity({ frontend }),
      });
    }
    if (entries.length !== expectedRegistrations) {
      throw routeModuleError(
        fileRelativePath,
        "contains a route registration that the canonical static projector could not represent",
      );
    }
  }

  return entries;
}

function assertUniqueRouteFilePrefixes(
  routeFiles: readonly string[],
  rootDir: string,
  routesDir: string,
): void {
  const owners = new Map<string, string>();
  for (const filePath of routeFiles) {
    const prefix = filePathToRoutePrefix(filePath, routesDir);
    const identity = prefix.toLocaleLowerCase("en-US");
    const existing = owners.get(identity);
    if (existing) {
      throw new Error(
        `[vextjs] Route prefix conflict detected for "${prefix}": ${relative(rootDir, existing).split(sep).join("/")} and ${relative(rootDir, filePath).split(sep).join("/")} map to the same route ownership boundary.`,
      );
    }
    owners.set(identity, filePath);
  }
}

function assertUniqueRouteEntries(entries: readonly RouteIndexEntry[]): void {
  const owners = new Map<string, RouteIndexEntry>();
  for (const entry of entries) {
    const identity = createCanonicalRouteIdentity(entry.method, entry.path);
    const existing = owners.get(identity);
    if (existing) {
      throw new Error(
        `[vextjs] Duplicate route identity ${entry.method.toUpperCase()} ${entry.path}: ${existing.fileRelativePath} conflicts with ${entry.fileRelativePath}. Route paths are compared without trailing slashes and without case differences for cross-adapter safety.`,
      );
    }
    owners.set(identity, entry);
  }
}

/** Statically projects the finite RouteOptions.frontend grammar. */
function readRouteFrontend(
  optionsObject: string,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
): VextRouteFrontendOptions | undefined {
  const frontendValue = readObjectEntryValue(optionsObject, "frontend")?.trim();
  if (frontendValue === undefined) return undefined;
  const parsed = parseStaticSchemaValue(
    frontendValue,
    staticContext,
    `${formatProjectionContext(context)} RouteOptions.frontend`,
  );
  if (!isStaticSchemaObject(parsed)) {
    throw projectionError(
      context,
      "RouteOptions.frontend must be statically resolvable to an object literal",
    );
  }
  return parsed as VextRouteFrontendOptions;
}

function findDefaultExportedDefineRoutesBlock(
  source: string,
  fileRelativePath: string,
): DefineRoutesBlock {
  const masked = createLexicalMask(source);
  const moduleContext = collectRouteModuleContext(
    source,
    masked,
    fileRelativePath,
  );
  const routeDefinitionExpression = resolveTopLevelRouteExpression(
    moduleContext.defaultExportExpression,
    moduleContext,
    fileRelativePath,
  );
  return parseDefineRoutesCall(
    routeDefinitionExpression,
    moduleContext.defineRoutesBindings,
    fileRelativePath,
  );
}

function collectRouteModuleContext(
  source: string,
  masked: string,
  fileRelativePath: string,
): RouteModuleContext {
  const defineRoutesBindings = collectDefineRoutesImportBindings(
    source,
    masked,
  );
  if (defineRoutesBindings.size === 0) {
    throw routeModuleError(
      fileRelativePath,
      'must import { defineRoutes } (optionally aliased) from "vextjs"',
    );
  }

  const { bindings, ambiguousBindings } = collectTopLevelConstBindings(
    source,
    masked,
  );
  return {
    defineRoutesBindings,
    topLevelBindings: bindings,
    ambiguousTopLevelBindings: ambiguousBindings,
    defaultExportExpression: readDefaultExportExpression(
      source,
      masked,
      fileRelativePath,
    ),
  };
}

function collectDefineRoutesImportBindings(
  source: string,
  masked: string,
): ReadonlySet<string> {
  return collectFrameworkNamedImportBindings(source, masked, "defineRoutes");
}

function collectSchemaAdapterImportBindings(
  source: string,
  masked: string,
): ReadonlySet<string> {
  return collectFrameworkNamedImportBindings(source, masked, "schemaAdapter");
}

function collectFrameworkNamedImportBindings(
  source: string,
  masked: string,
  importedName: "defineRoutes" | "schemaAdapter",
): ReadonlySet<string> {
  const bindings = new Set<string>();
  const importPattern = /\bimport\s+(type\s+)?\{/gu;

  for (const match of masked.matchAll(importPattern)) {
    if (match[1] || !isTopLevelAt(masked, match.index!)) continue;
    const openBrace = match.index! + match[0].lastIndexOf("{");
    const closeBrace = findMatchingIndex(masked, openBrace, "{", "}");
    if (closeBrace < 0) continue;
    const declarationEnd = findStaticExpressionEnd(masked, closeBrace + 1);
    const declarationTail = source.slice(closeBrace + 1, declarationEnd).trim();
    const moduleMatch = /^from\s+(["'])([^"']+)\1/u.exec(declarationTail);
    if (moduleMatch?.[2] !== "vextjs") continue;

    for (const rawSpecifier of splitTopLevelArgs(
      source.slice(openBrace + 1, closeBrace),
    )) {
      const specifier = rawSpecifier.trim();
      if (specifier.startsWith("type ")) continue;
      const namedImport =
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(specifier);
      if (namedImport?.[1] === importedName) {
        bindings.add(namedImport[2] ?? importedName);
      }
    }
  }

  return bindings;
}

function collectTopLevelConstBindings(
  source: string,
  masked: string,
): ConstBindingContext {
  const bindings = new Map<string, string>();
  const ambiguousBindings = new Set<string>();
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\b/gu;
  for (const match of masked.matchAll(pattern)) {
    if (!isTopLevelAt(masked, match.index!)) continue;
    const name = match[1]!;
    const equals = findConstInitializerEquals(
      masked,
      match.index! + match[0].length,
    );
    if (equals < 0) continue;
    const end = findStaticExpressionEnd(masked, equals + 1);
    const expression = stripSourceComments(
      source.slice(equals + 1, end),
    ).trim();
    if (!expression || ambiguousBindings.has(name)) continue;
    if (bindings.has(name)) {
      bindings.delete(name);
      ambiguousBindings.add(name);
      continue;
    }
    bindings.set(name, expression);
  }

  return { bindings, ambiguousBindings };
}

function findConstInitializerEquals(masked: string, start: number): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let angles = 0;
  for (let index = start; index < masked.length; index++) {
    const char = masked[index]!;
    if (char === "(") parentheses++;
    else if (char === ")") parentheses--;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    else if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "<") angles++;
    else if (char === ">" && angles > 0) angles--;
    else if (
      char === "=" &&
      masked[index + 1] !== ">" &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0 &&
      angles === 0
    ) {
      return index;
    } else if (
      (char === ";" || char === "\n" || char === "\r") &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0 &&
      angles === 0
    ) {
      return -1;
    }
  }
  return -1;
}

function readDefaultExportExpression(
  source: string,
  masked: string,
  fileRelativePath: string,
): string {
  const candidates: string[] = [];
  const directPattern = /\bexport\s+default\b/gu;
  for (const match of masked.matchAll(directPattern)) {
    if (!isTopLevelAt(masked, match.index!)) continue;
    const start = match.index! + match[0].length;
    const end = findStaticExpressionEnd(masked, start);
    const expression = source.slice(start, end).trim();
    if (!expression) {
      throw routeModuleError(fileRelativePath, "has an empty default export");
    }
    candidates.push(expression);
  }

  const namedPattern = /\bexport\s*\{/gu;
  for (const match of masked.matchAll(namedPattern)) {
    if (!isTopLevelAt(masked, match.index!)) continue;
    const openBrace = match.index! + match[0].lastIndexOf("{");
    const closeBrace = findMatchingIndex(masked, openBrace, "{", "}");
    if (closeBrace < 0) continue;
    const statementEnd = findStaticExpressionEnd(masked, closeBrace + 1);
    const isReExport = /^\s*from\b/u.test(
      source.slice(closeBrace + 1, statementEnd),
    );

    for (const rawSpecifier of splitTopLevelArgs(
      source.slice(openBrace + 1, closeBrace),
    )) {
      const specifier = rawSpecifier.trim().replace(/^type\s+/u, "");
      const defaultSpecifier = /^([A-Za-z_$][\w$]*)\s+as\s+default$/u.exec(
        specifier,
      );
      if (!defaultSpecifier && specifier !== "default") continue;
      if (isReExport) {
        throw routeModuleError(
          fileRelativePath,
          "must not re-export its default route definition from another module",
        );
      }
      candidates.push(defaultSpecifier?.[1] ?? "default");
    }
  }

  if (candidates.length === 0) {
    throw routeModuleError(
      fileRelativePath,
      "must default-export its defineRoutes(...) result",
    );
  }
  if (candidates.length > 1) {
    throw routeModuleError(
      fileRelativePath,
      "must have exactly one statically projectable default export",
    );
  }
  return candidates[0]!;
}

function resolveTopLevelRouteExpression(
  value: string,
  moduleContext: RouteModuleContext,
  fileRelativePath: string,
  resolving: ReadonlySet<string> = new Set(),
): string {
  const expression = stripStaticSyntax(value);
  if (!/^[A-Za-z_$][\w$]*$/u.test(expression)) return expression;
  if (moduleContext.ambiguousTopLevelBindings.has(expression)) {
    throw routeModuleError(
      fileRelativePath,
      `default route binding "${expression}" is ambiguous`,
    );
  }
  const binding = moduleContext.topLevelBindings.get(expression);
  if (binding === undefined) return expression;
  if (resolving.has(expression)) {
    throw routeModuleError(
      fileRelativePath,
      `default route binding "${expression}" is circular`,
    );
  }
  const next = new Set(resolving);
  next.add(expression);
  return resolveTopLevelRouteExpression(
    binding,
    moduleContext,
    fileRelativePath,
    next,
  );
}

function parseDefineRoutesCall(
  value: string,
  defineRoutesBindings: ReadonlySet<string>,
  fileRelativePath: string,
): DefineRoutesBlock {
  const expression = stripStaticSyntax(value);
  const masked = createLexicalMask(expression);
  const call = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(masked);
  const callee = call?.[1];
  if (!call || !callee || !defineRoutesBindings.has(callee)) {
    throw routeModuleError(
      fileRelativePath,
      "default export must be a local defineRoutes(...) call or a top-level const bound to one",
    );
  }
  const openParen = masked.indexOf("(", call.index);
  const closeParen = findMatchingIndex(masked, openParen, "(", ")");
  if (closeParen < 0 || closeParen !== masked.trimEnd().length - 1) {
    throw routeModuleError(
      fileRelativePath,
      "default defineRoutes(...) call must be balanced and direct",
    );
  }
  const args = splitTopLevelArgs(expression.slice(openParen + 1, closeParen));
  if (args.length !== 1 || !args[0]) {
    throw routeModuleError(
      fileRelativePath,
      "defineRoutes(...) must receive exactly one inline synchronous factory",
    );
  }
  return parseInlineRouteFactory(args[0], fileRelativePath);
}

function parseInlineRouteFactory(
  value: string,
  fileRelativePath: string,
): DefineRoutesBlock {
  const factory = stripStaticSyntax(value);
  const masked = createLexicalMask(factory);
  if (/^async\b/u.test(masked)) {
    throw routeModuleError(
      fileRelativePath,
      "defineRoutes factory must be synchronous; async factories are not supported",
    );
  }

  const arrow =
    /^(?:\(\s*([A-Za-z_$][\w$]*)(?:\s*:[^)]*)?\s*\)|([A-Za-z_$][\w$]*))\s*(?::\s*void\s*)?=>\s*\{/u.exec(
      masked,
    );
  const functionExpression =
    /^function(?:\s+[A-Za-z_$][\w$]*)?\s*\(\s*([A-Za-z_$][\w$]*)(?:\s*:[^)]*)?\s*\)\s*(?::\s*void\s*)?\{/u.exec(
      masked,
    );
  const match = arrow ?? functionExpression;
  const paramName = arrow ? (arrow[1] ?? arrow[2]) : functionExpression?.[1];
  if (!match || !paramName) {
    throw routeModuleError(
      fileRelativePath,
      "defineRoutes(...) requires an inline arrow or function expression with one app parameter",
    );
  }

  const openBrace = match[0].lastIndexOf("{");
  const closeBrace = findMatchingIndex(masked, openBrace, "{", "}");
  if (closeBrace < 0 || closeBrace !== masked.trimEnd().length - 1) {
    throw routeModuleError(
      fileRelativePath,
      "defineRoutes factory body must be a balanced direct block",
    );
  }
  return {
    paramName,
    body: factory.slice(openBrace + 1, closeBrace),
    maskedBody: masked.slice(openBrace + 1, closeBrace),
  };
}

function isTopLevelAt(masked: string, targetIndex: number): boolean {
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < targetIndex; index++) {
    const char = masked[index]!;
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "(") parentheses++;
    else if (char === ")") parentheses--;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
  }
  return braces === 0 && parentheses === 0 && brackets === 0;
}

function routeModuleError(fileRelativePath: string, message: string): Error {
  return new Error(`[vextjs] ${fileRelativePath} ${message}.`);
}

function assertDirectRouteRegistration(
  maskedBody: string,
  matchIndex: number,
  context: RouteProjectionContext,
): void {
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < matchIndex; index++) {
    const char = maskedBody[index]!;
    if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === "(") parenthesisDepth++;
    else if (char === ")") parenthesisDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
  }

  const lineStart =
    Math.max(
      maskedBody.lastIndexOf("\n", matchIndex - 1),
      maskedBody.lastIndexOf("\r", matchIndex - 1),
    ) + 1;
  const statementStart = Math.max(
    lineStart,
    maskedBody.lastIndexOf(";", matchIndex - 1) + 1,
  );
  const linePrefix = maskedBody.slice(statementStart, matchIndex).trim();
  if (
    braceDepth !== 0 ||
    parenthesisDepth !== 0 ||
    bracketDepth !== 0 ||
    linePrefix ||
    hasRuntimeControlPrefix(maskedBody, statementStart)
  ) {
    throw projectionError(
      context,
      "route registration must be a direct top-level statement in the defineRoutes callback",
    );
  }
}

function hasRuntimeControlPrefix(
  maskedBody: string,
  statementStart: number,
): boolean {
  let previous = statementStart - 1;
  while (previous >= 0 && /\s/u.test(maskedBody[previous]!)) previous--;
  if (previous < 0 || maskedBody[previous] === ";") return false;

  const previousChar = maskedBody[previous]!;
  if (/[&|?:=,([>!+*/%^-]/u.test(previousChar)) return true;
  if (previousChar === ")") {
    const open = findOpeningIndex(maskedBody, previous, "(", ")");
    if (open >= 0) {
      const immediateWord = readPreviousIdentifier(maskedBody, open - 1);
      if (["if", "for", "while", "with"].includes(immediateWord.word)) {
        return true;
      }
      if (immediateWord.word === "await") {
        return (
          readPreviousIdentifier(maskedBody, immediateWord.start - 1).word ===
          "for"
        );
      }
    }
  }

  return ["do", "else", "return", "throw", "yield"].includes(
    readPreviousIdentifier(maskedBody, previous).word,
  );
}

function findOpeningIndex(
  source: string,
  closeIndex: number,
  openChar: "(",
  closeChar: ")",
): number {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index--) {
    const char = source[index]!;
    if (char === closeChar) depth++;
    else if (char === openChar) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readPreviousIdentifier(
  source: string,
  fromIndex: number,
): { word: string; start: number } {
  let end = fromIndex;
  while (end >= 0 && /\s/u.test(source[end]!)) end--;
  let start = end;
  while (start >= 0 && /[A-Za-z_$]/u.test(source[start]!)) start--;
  return { word: source.slice(start + 1, end + 1), start: start + 1 };
}

function readRouteDocs(
  optionsObject: string | undefined,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
): {
  docsSummary: string | null;
  hasDocsSummary: boolean;
  operationId: string | null;
  tags: string[];
  hidden: boolean;
  responses: StaticRouteResponseDefinition[];
} {
  const empty = {
    docsSummary: null,
    hasDocsSummary: false,
    operationId: null,
    tags: [],
    hidden: false,
    responses: [],
  };

  if (!optionsObject) {
    return empty;
  }

  const docsValue = readObjectEntryValue(optionsObject, "docs");
  if (docsValue === undefined) return empty;
  const docsObject = readStaticObjectExpression(
    docsValue,
    staticContext,
    context,
    "RouteOptions.docs",
  );
  const summary = readOptionalStaticStringProperty(
    docsObject,
    "summary",
    staticContext,
    context,
    "RouteOptions.docs.summary",
  );
  const operationId = readOptionalStaticStringProperty(
    docsObject,
    "operationId",
    staticContext,
    context,
    "RouteOptions.docs.operationId",
  );

  return {
    docsSummary: summary,
    hasDocsSummary: Boolean(summary?.trim()),
    operationId,
    tags: readStaticStringArrayProperty(
      docsObject,
      "tags",
      staticContext,
      context,
      "RouteOptions.docs.tags",
    ),
    hidden: readStaticBooleanProperty(
      docsObject,
      "hidden",
      staticContext,
      context,
      "RouteOptions.docs.hidden",
      false,
    ),
    responses: readRouteResponseDefinitions(
      docsObject,
      "docs.responses",
      staticContext,
      context,
    ),
  };
}

function createRouteSchemaContract(
  optionsObject: string | undefined,
  responses: readonly StaticRouteResponseDefinition[],
  method: string,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
): VextRouteSchemaContractV1 {
  let request: VextRouteSchemaContractV1["request"] = {};
  const validateValue = optionsObject
    ? readObjectEntryValue(optionsObject, "validate")
    : undefined;
  if (validateValue !== undefined) {
    const validate = parseStaticSchemaValue(
      validateValue,
      staticContext,
      `${formatProjectionContext(context)} RouteOptions.validate`,
    );
    if (!isStaticSchemaObject(validate)) {
      throw projectionError(
        context,
        "RouteOptions.validate must be statically resolvable to an object literal",
      );
    }
    try {
      request = projectRouteSchemaContract(
        { validate } as unknown as RouteOptions,
        method,
      ).request;
    } catch (error) {
      throw projectionError(
        context,
        `RouteOptions.validate projection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    schemaVersion: 1,
    request,
    responses: responses
      .map((response) => {
        const schema = response.schema
          ? createStaticResponseSchema(response, method, context)
          : undefined;
        return {
          status: response.status,
          contentType: response.contentType,
          ...(schema ? { schema } : {}),
        } satisfies VextRouteResponseSchemaV1;
      })
      .sort((left, right) => compareResponseStatus(left.status, right.status)),
  };
}

function createStaticResponseSchema(
  response: StaticRouteResponseDefinition,
  method: string,
  context: RouteProjectionContext,
): VextSchemaIRV1 | undefined {
  try {
    if (
      response.source === "responses" &&
      (method === "HEAD" || response.status === "204")
    ) {
      return undefined;
    }
    const schema =
      response.source === "responses"
        ? resolveRouteResponseJsonSchema(response.schema!)
        : schemaConverter.convertResponseSchema(response.schema!);
    const ref = typeof schema.$ref === "string" ? schema.$ref : undefined;
    return {
      schemaVersion: 1,
      kind: "vext-schema-ir",
      source: response.source,
      sourcePath: `${response.source}.${response.status}.schema`,
      schema,
      digest: createDigest(schema),
      ...(ref ? { ref } : {}),
    };
  } catch (error) {
    throw projectionError(
      context,
      `${response.source}.${response.status}.schema could not be projected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readRouteResponseDefinitions(
  containerObject: string | undefined,
  source: "responses" | "docs.responses",
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
): StaticRouteResponseDefinition[] {
  if (!containerObject) return [];
  const responsesValue = readObjectEntryValue(containerObject, "responses");
  if (responsesValue === undefined) return [];
  const responsesObject = readStaticObjectExpression(
    responsesValue,
    staticContext,
    context,
    source,
  );

  const definitions = readObjectEntries(responsesObject).map(
    ({ key, value }) => {
      const rawStatus = readObjectEntryKey(key);
      if (!rawStatus) {
        throw projectionError(
          context,
          `${source} contains a response selector that is not statically resolvable`,
        );
      }
      const responseObject = readStaticObjectExpression(
        value,
        staticContext,
        context,
        `${source}.${rawStatus}`,
      );
      const status =
        source === "responses"
          ? normalizeRuntimeResponseSelector(rawStatus)
          : normalizeDocumentedResponseSelector(rawStatus);

      const contentTypeValue = readObjectEntryValue(
        responseObject,
        "contentType",
      );
      const contentType =
        contentTypeValue === undefined
          ? "application/json"
          : readStaticStringExpression(
              contentTypeValue,
              staticContext,
              context,
              `${source}.${status}.contentType must be statically resolvable`,
            );
      const schemaValue = readObjectEntryValue(responseObject, "schema");
      const schema = parseStaticResponseSchema(
        schemaValue,
        staticContext,
        context,
        `${source}.${status}.schema`,
      );
      return { status, contentType, source, ...(schema ? { schema } : {}) };
    },
  );

  const selectors = new Set<string>();
  for (const definition of definitions) {
    if (selectors.has(definition.status)) {
      throw new Error(
        `[vextjs] Duplicate ${source} selector after normalization: ${JSON.stringify(definition.status)}.`,
      );
    }
    selectors.add(definition.status);
  }

  return definitions.sort((left, right) =>
    compareResponseStatus(left.status, right.status),
  );
}

function mergeRouteResponseDefinitions(
  runtimeResponses: readonly StaticRouteResponseDefinition[],
  documentedResponses: readonly StaticRouteResponseDefinition[],
): StaticRouteResponseDefinition[] {
  const merged = new Map(
    runtimeResponses.map((response) => [response.status, response] as const),
  );

  for (const documented of documentedResponses) {
    const runtime = merged.get(documented.status);
    if (!runtime) {
      merged.set(documented.status, documented);
      continue;
    }
    if (documented.schema !== undefined) {
      throw new Error(
        `[vextjs] Route response selector ${documented.status} declares schema in both RouteOptions.responses and docs.responses.`,
      );
    }
    merged.set(documented.status, {
      ...runtime,
      contentType: documented.contentType,
    });
  }

  return [...merged.values()].sort((left, right) =>
    compareResponseStatus(left.status, right.status),
  );
}

function parseStaticResponseSchema(
  value: string | undefined,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
  label: string,
): Record<string, unknown> | string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseStaticSchemaValue(
    value,
    staticContext,
    `${formatProjectionContext(context)} ${label}`,
  );
  if (typeof parsed === "string" || isStaticSchemaObject(parsed)) {
    return parsed;
  }
  throw projectionError(
    context,
    `${label} must be statically resolvable to a supported schema`,
  );
}

function parseStaticSchemaValue(
  value: string | undefined,
  staticContext: StaticScanContext,
  label: string,
): unknown {
  if (!value) return undefined;
  const resolved = resolveStaticExpressionSource(value, staticContext, label);
  const string = readStringLiteral(resolved);
  if (string !== null) return string;

  const canonicalBuilder = projectCanonicalFieldBuilder(
    resolved,
    staticContext,
    label,
  );
  if (canonicalBuilder !== NO_CANONICAL_FIELD_BUILDER) {
    return canonicalBuilder;
  }

  const trimmed = stripStaticSyntax(resolved);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed.startsWith("{")) {
    return parseStaticSchemaObject(trimmed, staticContext, label);
  }
  if (trimmed.startsWith("[")) {
    return parseStaticSchemaArray(trimmed, staticContext, label);
  }
  throw new Error(
    `[vextjs] ${label} must be statically resolvable. ` +
      "Use literals, same-file const values, or schemaAdapter.compileField(<static string>) " +
      "with one optional .description(<static string>); opaque/imported schema objects and other call chains are not supported.",
  );
}

function projectCanonicalFieldBuilder(
  value: string,
  staticContext: StaticScanContext,
  label: string,
): DslBuilder | typeof NO_CANONICAL_FIELD_BUILDER {
  const expression = stripStaticSyntax(value);
  const masked = createLexicalMask(expression);
  const receiver = /^([A-Za-z_$][\w$]*)\b/u.exec(masked)?.[1];
  if (!receiver || !staticContext.schemaAdapterBindings.has(receiver)) {
    return NO_CANONICAL_FIELD_BUILDER;
  }

  const compileCall = /^([A-Za-z_$][\w$]*)\s*\.\s*compileField\s*\(/u.exec(
    masked,
  );
  if (!compileCall) {
    throw new Error(
      `[vextjs] ${label} uses an unsupported schemaAdapter expression. ` +
        "Only compileField(<static string>) with one optional .description(<static string>) is projectable.",
    );
  }
  const openParen = masked.indexOf("(", compileCall.index);
  const closeParen = findMatchingIndex(masked, openParen, "(", ")");
  if (closeParen < 0) {
    throw new Error(
      `[vextjs] ${label} schemaAdapter.compileField(...) call is not balanced.`,
    );
  }
  const definition = readCanonicalBuilderStringArgument(
    expression.slice(openParen + 1, closeParen),
    staticContext,
    `${label} schemaAdapter.compileField(...)`,
  );

  const tail = expression.slice(closeParen + 1).trim();
  let description: string | undefined;
  if (tail) {
    const maskedTail = createLexicalMask(tail);
    const descriptionCall = /^\.\s*description\s*\(/u.exec(maskedTail);
    if (!descriptionCall) {
      throw new Error(
        `[vextjs] ${label} uses an unsupported schemaAdapter call chain. ` +
          "Only one optional .description(<static string>) is projectable.",
      );
    }
    const descriptionOpen = maskedTail.indexOf("(", descriptionCall.index);
    const descriptionClose = findMatchingIndex(
      maskedTail,
      descriptionOpen,
      "(",
      ")",
    );
    if (
      descriptionClose < 0 ||
      descriptionClose !== maskedTail.trimEnd().length - 1
    ) {
      throw new Error(
        `[vextjs] ${label} uses an unsupported schemaAdapter call chain. ` +
          "Only one optional .description(<static string>) is projectable.",
      );
    }
    description = readCanonicalBuilderStringArgument(
      tail.slice(descriptionOpen + 1, descriptionClose),
      staticContext,
      `${label} schemaAdapter.description(...)`,
    );
  }

  try {
    const builder = schemaAdapter.compileField(definition);
    return description === undefined
      ? builder
      : builder.description(description);
  } catch (error) {
    throw new Error(
      `[vextjs] ${label} canonical schemaAdapter builder failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function readCanonicalBuilderStringArgument(
  argsText: string,
  staticContext: StaticScanContext,
  label: string,
): string {
  const args = splitTopLevelArgs(argsText);
  if (args.length === 1 && args[0]) {
    const resolved = resolveStaticExpressionSource(
      args[0],
      staticContext,
      label,
    );
    const string = readStringLiteral(resolved);
    if (string !== null) return string;
  }
  throw new Error(
    `[vextjs] ${label} requires exactly one statically resolvable string argument.`,
  );
}

function parseStaticSchemaObject(
  source: string,
  staticContext: StaticScanContext,
  label: string,
): Record<string, unknown> | undefined {
  const object = readBalanced(source, 0, "{", "}");
  if (!object || object.length !== stripStaticSyntax(source).length) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  const members = splitTopLevelArgs(object.slice(1, -1));
  if (members.length === 1 && !members[0]) return result;
  for (const [index, member] of members.entries()) {
    if (!member && index === members.length - 1) continue;
    if (member.trimStart().startsWith("...")) return undefined;
    const separator = findTopLevelPropertySeparator(member);
    const shorthand = separator < 1 ? member.trim() : undefined;
    const key = separator < 1 ? shorthand! : member.slice(0, separator).trim();
    const value =
      separator < 1 ? shorthand! : member.slice(separator + 1).trim();
    const property = readObjectEntryKey(key);
    const parsed = parseStaticSchemaValue(
      value,
      staticContext,
      `${label}.${property ?? "<unknown>"}`,
    );
    if (!property || parsed === undefined) return undefined;
    result[property] = parsed;
  }
  return result;
}

function parseStaticSchemaArray(
  source: string,
  staticContext: StaticScanContext,
  label: string,
): unknown[] | undefined {
  const array = readBalanced(source, 0, "[", "]");
  if (!array || array.length !== stripStaticSyntax(source).length) {
    return undefined;
  }
  const members = splitTopLevelArgs(array.slice(1, -1));
  if (members.length === 1 && !members[0]) return [];

  const values: unknown[] = [];
  for (const [index, member] of members.entries()) {
    const parsed = parseStaticSchemaValue(
      member,
      staticContext,
      `${label}[${index}]`,
    );
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return values;
}

function isStaticSchemaObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStaticObjectExpression(
  value: string | undefined,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
  label: string,
): string {
  if (value === undefined) {
    throw projectionError(context, `${label} is missing`);
  }
  const resolved = stripStaticSyntax(
    resolveStaticExpressionSource(
      value,
      staticContext,
      `${formatProjectionContext(context)} ${label}`,
    ),
  );
  const object = resolved.startsWith("{")
    ? readBalanced(resolved, 0, "{", "}")
    : null;
  if (!object || object.length !== resolved.length) {
    if (
      /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*\s*\(/u.test(
        createLexicalMask(resolved),
      )
    ) {
      throw projectionError(
        context,
        `${label} helper calls are not statically projectable; inline the helper's final object literal or pass a same-file const containing that final object`,
      );
    }
    throw projectionError(
      context,
      `${label} must be statically resolvable to an object literal`,
    );
  }
  if (
    splitTopLevelArgs(object.slice(1, -1)).some((member) =>
      member.trimStart().startsWith("..."),
    )
  ) {
    throw projectionError(
      context,
      `${label} cannot contain object spreads because their keys are runtime-owned`,
    );
  }
  if (
    splitTopLevelArgs(object.slice(1, -1)).some((member) => {
      const separator = findTopLevelPropertySeparator(member);
      return (
        separator >= 1 && member.slice(0, separator).trim().startsWith("[")
      );
    })
  ) {
    throw projectionError(
      context,
      `${label} cannot contain computed property keys because their identities are runtime-owned`,
    );
  }
  return object;
}

function readStaticStringExpression(
  value: string | undefined,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
  failureMessage: string,
): string {
  if (value !== undefined) {
    const resolved = resolveStaticExpressionSource(
      value,
      staticContext,
      `${formatProjectionContext(context)} ${failureMessage}`,
    );
    const string = readStringLiteral(resolved);
    if (string !== null) return string;
  }
  throw projectionError(context, failureMessage);
}

function readOptionalStaticStringProperty(
  objectLiteral: string,
  key: string,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
  label: string,
): string | null {
  const value = readObjectEntryValue(objectLiteral, key);
  return value === undefined
    ? null
    : readStaticStringExpression(
        value,
        staticContext,
        context,
        `${label} must be statically resolvable`,
      );
}

function readStaticStringArrayProperty(
  objectLiteral: string,
  key: string,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
  label: string,
): string[] {
  const value = readObjectEntryValue(objectLiteral, key);
  if (value === undefined) return [];
  const parsed = parseStaticSchemaValue(
    value,
    staticContext,
    `${formatProjectionContext(context)} ${label}`,
  );
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw projectionError(
      context,
      `${label} must be statically resolvable to a string array`,
    );
  }
  return parsed as string[];
}

function readStaticBooleanProperty(
  objectLiteral: string,
  key: string,
  staticContext: StaticScanContext,
  context: RouteProjectionContext,
  label: string,
  fallback: boolean,
): boolean {
  const value = readObjectEntryValue(objectLiteral, key);
  if (value === undefined) return fallback;
  const parsed = parseStaticSchemaValue(
    value,
    staticContext,
    `${formatProjectionContext(context)} ${label}`,
  );
  if (typeof parsed !== "boolean") {
    throw projectionError(
      context,
      `${label} must be statically resolvable to a boolean`,
    );
  }
  return parsed;
}

function resolveStaticExpressionSource(
  value: string,
  staticContext: ConstBindingContext,
  label: string,
  resolving = new Set<string>(),
): string {
  const expression = stripStaticSyntax(value);
  if (/^[A-Za-z_$][\w$]*$/u.test(expression)) {
    if (staticContext.ambiguousBindings.has(expression)) {
      throw new Error(
        `[vextjs] ${label} refers to ambiguous same-file const binding ${JSON.stringify(expression)}.`,
      );
    }
    const binding = staticContext.bindings.get(expression);
    if (binding === undefined) return expression;
    if (resolving.has(expression)) {
      throw new Error(`[vextjs] ${label} contains a circular const binding.`);
    }
    const next = new Set(resolving);
    next.add(expression);
    return resolveStaticExpressionSource(binding, staticContext, label, next);
  }

  return expression;
}

function stripStaticSyntax(value: string): string {
  let expression = stripSourceComments(value).trim();
  let previous = "";
  while (expression !== previous) {
    previous = expression;
    expression = expression
      .replace(/\s+as\s+const\s*$/u, "")
      .replace(/\s+as\s+[A-Za-z_$][\w$]*(?:\s*<[^>]*>)?(?:\[\])?\s*$/u, "")
      .replace(
        /\s+satisfies\s+[A-Za-z_$][\w$]*(?:\s*<[^>]*>)?(?:\[\])?\s*$/u,
        "",
      )
      .trim();
    if (expression.startsWith("(")) {
      const close = findMatchingIndex(
        createLexicalMask(expression),
        0,
        "(",
        ")",
      );
      if (close === expression.length - 1) {
        expression = expression.slice(1, -1).trim();
      }
    }
  }
  return expression;
}

function collectConstBindings(source: string): StaticScanContext {
  const masked = createLexicalMask(source);
  const { bindings, ambiguousBindings } = collectTopLevelConstBindings(
    source,
    masked,
  );
  const schemaAdapterBindings = new Set(
    [...collectSchemaAdapterImportBindings(source, masked)].filter(
      (name) => !bindings.has(name) && !ambiguousBindings.has(name),
    ),
  );
  return { bindings, ambiguousBindings, schemaAdapterBindings };
}

function findStaticExpressionEnd(masked: string, start: number): number {
  let depth = 0;
  for (let index = start; index < masked.length; index++) {
    const char = masked[index]!;
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") {
      if (depth === 0) return index;
      depth--;
    } else if (char === ";" && depth === 0) {
      return index;
    } else if ((char === "\n" || char === "\r") && depth === 0) {
      const current = masked.slice(start, index).trim();
      if (current) {
        let next = index + 1;
        while (next < masked.length && /\s/u.test(masked[next]!)) next++;
        if (masked[next] === ".") continue;
        return index;
      }
    }
  }
  return masked.length;
}

function formatProjectionContext(context: RouteProjectionContext): string {
  return `${context.fileRelativePath} ${context.method}${context.routePath ? ` ${context.routePath}` : ""}`;
}

function projectionError(
  context: RouteProjectionContext,
  message: string,
): Error {
  return new Error(`[vextjs] ${formatProjectionContext(context)} ${message}.`);
}

function readObjectEntries(
  objectLiteral: string,
): Array<{ key: string; value: string }> {
  const object = stripStaticSyntax(objectLiteral);
  if (!object.startsWith("{") || !object.endsWith("}")) return [];

  const entries: Array<{ key: string; value: string }> = [];
  for (const member of splitTopLevelArgs(object.slice(1, -1))) {
    if (!member) continue;
    const separator = findTopLevelPropertySeparator(member);
    if (separator < 1) {
      const shorthand = member.trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(shorthand)) {
        entries.push({ key: shorthand, value: shorthand });
      }
      continue;
    }
    entries.push({
      key: member.slice(0, separator).trim(),
      value: member.slice(separator + 1).trim(),
    });
  }
  return entries;
}

function readObjectEntryValue(
  objectLiteral: string,
  expectedKey: string,
): string | undefined {
  let resolved: string | undefined;
  // JavaScript object literals use the last duplicate data property.
  for (const { key, value } of readObjectEntries(objectLiteral)) {
    if (readObjectEntryKey(key) === expectedKey) resolved = value;
  }
  return resolved;
}

function readObjectEntryKey(value: string): string | null {
  const string = readStringLiteral(value);
  if (string !== null) return string;
  return /^[A-Za-z_$][\w$]*$/u.test(value) || /^\d+$/u.test(value)
    ? value
    : null;
}

function findTopLevelPropertySeparator(source: string): number {
  const masked = createLexicalMask(source);
  let depth = 0;

  for (let index = 0; index < masked.length; index++) {
    const char = masked[index]!;
    if (char === "{" || char === "(" || char === "[") {
      depth++;
    } else if (char === "}" || char === ")" || char === "]") {
      depth--;
    } else if (char === ":" && depth === 0) {
      return index;
    }
  }
  return -1;
}

function compareResponseStatus(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  const masked = createLexicalMask(argsText);
  let start = 0;
  let depth = 0;

  for (let i = 0; i < masked.length; i++) {
    const char = masked[i]!;
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      args.push(stripSourceComments(argsText.slice(start, i)).trim());
      start = i + 1;
    }
  }

  args.push(stripSourceComments(argsText.slice(start)).trim());
  if (args.at(-1) === "") args.pop();
  return args;
}

function stripSourceComments(source: string): string {
  let output = "";
  let index = 0;
  let state:
    | "code"
    | "single"
    | "double"
    | "template"
    | "line-comment"
    | "block-comment" = "code";
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (char === "'" || char === '"' || char === "`") {
        state = char === "'" ? "single" : char === '"' ? "double" : "template";
        output += char;
        index++;
      } else if (char === "/" && next === "/") {
        state = "line-comment";
        output += "  ";
        index += 2;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        output += "  ";
        index += 2;
      } else {
        output += char;
        index++;
      }
      continue;
    }
    if (state === "line-comment") {
      if (char === "\n" || char === "\r") {
        state = "code";
        output += char;
      } else output += " ";
      index++;
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        output += "  ";
        index += 2;
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
        index++;
      }
      continue;
    }
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    output += char;
    index++;
    if (char === "\\" && index < source.length) {
      output += source[index]!;
      index++;
    } else if (char === quote) {
      state = "code";
    }
  }
  return output;
}

function readStringLiteral(value: string): string | null {
  const trimmed = stripStaticSyntax(value);
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }
  if (quote === "`" && trimmed.includes("${")) return null;
  let escaped = false;
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      const escapedCharacter = trimmed[index + 1];
      if (
        escapedCharacter !== "\\" &&
        escapedCharacter !== '"' &&
        escapedCharacter !== "'" &&
        escapedCharacter !== "`"
      ) {
        return null;
      }
      escaped = true;
      continue;
    }
    if (char === quote) {
      return index === trimmed.length - 1
        ? trimmed.slice(1, index).replace(/\\([\\"'`])/gu, "$1")
        : null;
    }
  }
  return null;
}

function readBalanced(
  source: string,
  openIndex: number,
  openChar: "{" | "(" | "[",
  closeChar: "}" | ")" | "]",
): string | null {
  if (openIndex < 0 || source[openIndex] !== openChar) return null;
  const closeIndex = findMatchingIndex(
    createLexicalMask(source),
    openIndex,
    openChar,
    closeChar,
  );
  return closeIndex < 0 ? null : source.slice(openIndex, closeIndex + 1);
}

function findMatchingIndex(
  maskedSource: string,
  openIndex: number,
  openChar: "{" | "(" | "[",
  closeChar: "}" | ")" | "]",
): number {
  if (openIndex < 0 || maskedSource[openIndex] !== openChar) return -1;
  let depth = 0;
  for (let index = openIndex; index < maskedSource.length; index++) {
    const char = maskedSource[index]!;
    if (char === openChar) depth++;
    else if (char === closeChar) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function createLexicalMask(source: string): string {
  const chars = source.split("");
  const blank = (index: number) => {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  };

  for (let index = 0; index < source.length; ) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      blank(index++);
      blank(index++);
      while (index < source.length && source[index] !== "\n") blank(index++);
      continue;
    }
    if (char === "/" && next === "*") {
      blank(index++);
      blank(index++);
      while (index < source.length) {
        const current = source[index]!;
        const following = source[index + 1];
        blank(index++);
        if (current === "*" && following === "/") {
          blank(index++);
          break;
        }
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      blank(index++);
      let escaped = false;
      while (index < source.length) {
        const current = source[index]!;
        blank(index++);
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) break;
      }
      continue;
    }
    if (char === "/" && isRegexLiteralStart(chars, index)) {
      blank(index++);
      let escaped = false;
      let inClass = false;
      while (index < source.length) {
        const current = source[index]!;
        blank(index++);
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
      }
      while (index < source.length && /[A-Za-z]/u.test(source[index]!)) {
        blank(index++);
      }
      continue;
    }
    index++;
  }
  return chars.join("");
}

function isRegexLiteralStart(chars: readonly string[], index: number): boolean {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(chars[previous]!)) previous--;
  if (previous < 0) return true;
  if (/[({[=,:;!&|?+\-*%^~<>]/u.test(chars[previous]!)) return true;

  let wordEnd = previous + 1;
  while (previous >= 0 && /[A-Za-z_$]/u.test(chars[previous]!)) previous--;
  const word = chars.slice(previous + 1, wordEnd).join("");
  return [
    "return",
    "throw",
    "case",
    "delete",
    "void",
    "typeof",
    "yield",
    "await",
  ].includes(word);
}

function filePathToRoutePrefix(filePath: string, routesDir: string): string {
  let rel = relative(routesDir, filePath);
  rel = rel.split(sep).join("/");

  const ext = extname(rel);
  rel = rel.slice(0, -ext.length);

  if (rel === "index") {
    rel = "";
  } else if (rel.endsWith("/index")) {
    rel = rel.slice(0, -"/index".length);
  }

  rel = rel.replace(/\[([^]]+)]/g, ":$1");

  if (!rel.startsWith("/")) {
    rel = `/${rel}`;
  }

  if (rel.length > 1 && rel.endsWith("/")) {
    rel = rel.slice(0, -1);
  }

  return rel;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
