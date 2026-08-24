import { existsSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import fg from "fast-glob";
import {
  ROUTE_IGNORE_PATTERNS,
  ROUTE_SOURCE_PATTERNS,
  shouldIncludeRouteFilePath,
} from "../../lib/route-file-policy.js";
import { detectRouteSourceDocsKind } from "../../lib/openapi/route-docs-kind.js";
import { SchemaConverter } from "../../lib/openapi/schema-converter.js";
import type { VextOpenAPIDocsKind } from "../../lib/openapi/types.js";
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
const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
];

const schemaConverter = new SchemaConverter();

interface StaticRouteResponseDefinition {
  status: string;
  contentType: string;
  source: "responses" | "docs.responses";
  schema?: Record<string, unknown> | string;
}

interface StaticScanContext {
  bindings: ReadonlyMap<string, string>;
  ambiguousBindings: ReadonlySet<string>;
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

export async function buildRouteIndex(
  rootDir: string,
): Promise<RouteIndexEntry[]> {
  const routesDir = join(rootDir, "src", "routes");
  if (!existsSync(routesDir)) {
    return [];
  }

  const routeFiles = await fg(ROUTE_SOURCE_PATTERNS, {
    cwd: routesDir,
    absolute: true,
    onlyFiles: true,
    ignore: ROUTE_IGNORE_PATTERNS,
  });

  return routeFiles
    .filter((filePath) => shouldIncludeRouteFilePath(filePath, routesDir))
    .flatMap((filePath) => scanRouteEntries(filePath, rootDir, routesDir))
    .sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    );
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

  for (const block of findDefineRoutesBlocks(source)) {
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
      const routePath = readStaticStringExpression(
        args[0],
        staticContext,
        baseContext,
        "route path expression must be statically resolvable",
      );
      const normalizedPath = normalizeRoutePath(prefix, routePath);
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
              true,
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
        docsKind: detectRouteSourceDocsKind(handler),
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
  }

  return entries;
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

function findDefineRoutesBlocks(source: string): DefineRoutesBlock[] {
  const blocks: DefineRoutesBlock[] = [];
  const masked = createLexicalMask(source);
  const pattern =
    /(?<![\w$.])defineRoutes\s*\(\s*(?:async\s*)?(?:\(\s*([A-Za-z_$][\w$]*)(?:\s*:[^)]*)?\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/gu;

  for (const match of masked.matchAll(pattern)) {
    const openBrace = match.index! + match[0].lastIndexOf("{");
    const closeBrace = findMatchingIndex(masked, openBrace, "{", "}");
    const paramName = match[1] ?? match[2];
    if (closeBrace >= 0 && paramName) {
      blocks.push({
        paramName,
        body: source.slice(openBrace + 1, closeBrace),
        maskedBody: masked.slice(openBrace + 1, closeBrace),
      });
    }
  }

  return blocks;
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
  const resolved = resolveStaticExpressionSource(
    value,
    staticContext,
    label,
    false,
  );
  const string = readStringLiteral(resolved);
  if (string !== null) return string;

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
  return undefined;
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
  allowHelperWrapper = false,
): string {
  if (value === undefined) {
    throw projectionError(context, `${label} is missing`);
  }
  const resolved = stripStaticSyntax(
    resolveStaticExpressionSource(
      value,
      staticContext,
      `${formatProjectionContext(context)} ${label}`,
      allowHelperWrapper,
    ),
  );
  const object = resolved.startsWith("{")
    ? readBalanced(resolved, 0, "{", "}")
    : null;
  if (!object || object.length !== resolved.length) {
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
      false,
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
  staticContext: StaticScanContext,
  label: string,
  allowHelperWrapper: boolean,
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
    return resolveStaticExpressionSource(
      binding,
      staticContext,
      label,
      allowHelperWrapper,
      next,
    );
  }

  if (allowHelperWrapper) {
    const masked = createLexicalMask(expression);
    const call = /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/u.exec(masked);
    if (call) {
      const openParen = masked.indexOf("(", call.index);
      const closeParen = findMatchingIndex(masked, openParen, "(", ")");
      if (closeParen === masked.trimEnd().length - 1) {
        const [first] = splitTopLevelArgs(
          expression.slice(openParen + 1, closeParen),
        );
        if (!first) {
          throw new Error(
            `[vextjs] ${label} helper wrapper must receive a statically resolvable options object as its first argument.`,
          );
        }
        return resolveStaticExpressionSource(
          first,
          staticContext,
          label,
          true,
          resolving,
        );
      }
    }
  }

  return expression;
}

function stripStaticSyntax(value: string): string {
  let expression = value.trim();
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
  const bindings = new Map<string, string>();
  const ambiguousBindings = new Set<string>();
  const masked = createLexicalMask(source);
  const pattern = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/gu;
  for (const match of masked.matchAll(pattern)) {
    const name = match[1]!;
    const start = match.index! + match[0].length;
    const end = findStaticExpressionEnd(masked, start);
    const expression = source.slice(start, end).trim();
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
      if (current) return index;
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
      args.push(argsText.slice(start, i).trim());
      start = i + 1;
    }
  }

  args.push(argsText.slice(start).trim());
  return args;
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

function normalizeRoutePath(prefix: string, subPath: string): string {
  const cleanPrefix =
    prefix.endsWith("/") && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
  const cleanSubPath = subPath.startsWith("/") ? subPath.slice(1) : subPath;

  if (!cleanSubPath) {
    return cleanPrefix || "/";
  }

  if (cleanPrefix === "/") {
    return `/${cleanSubPath}`;
  }

  const fullPath = `${cleanPrefix}/${cleanSubPath}`;
  if (fullPath.length > 1 && fullPath.endsWith("/")) {
    return fullPath.slice(0, -1);
  }

  return fullPath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
