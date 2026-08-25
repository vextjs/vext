export const VEXT_ROUTE_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

export type VextRouteMethod = (typeof VEXT_ROUTE_METHODS)[number];

export interface CanonicalRouteFactoryValidationOptions {
  validateHandler?: boolean;
  /** Accept only the top-level comma sequence emitted by minified CJS builds. */
  allowCompilerLoweredSequence?: boolean;
}

const VEXT_ROUTE_METHOD_SET = new Set<string>(VEXT_ROUTE_METHODS);

export function isVextRouteMethod(value: string): value is VextRouteMethod {
  return VEXT_ROUTE_METHOD_SET.has(value);
}

/** Canonical path join used by runtime registration and static projection. */
export function normalizeRegisteredRoutePath(
  prefix: string,
  subPath: string,
): string {
  const cleanPrefix =
    prefix.endsWith("/") && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
  const cleanSubPath = subPath.startsWith("/") ? subPath.slice(1) : subPath;
  const joined = !cleanSubPath
    ? cleanPrefix || "/"
    : cleanPrefix === "/"
      ? `/${cleanSubPath}`
      : `${cleanPrefix}/${cleanSubPath}`;
  return joined.length > 1 ? joined.replace(/\/+$/u, "") : joined;
}

/**
 * Adapters differ in case and trailing-slash matching. Reject identities that
 * would be ambiguous on any supported adapter before registration.
 */
export function createCanonicalRouteIdentity(
  method: string,
  routePath: string,
): string {
  const normalizedPath =
    routePath.length > 1 ? routePath.replace(/\/+$/u, "") : routePath;
  return `${method.toUpperCase()} ${normalizedPath.toLocaleLowerCase("en-US")}`;
}

export function assertCanonicalRouteFactorySource(
  factorySource: string,
  label = "defineRoutes(factory)",
  options: CanonicalRouteFactoryValidationOptions = {},
): number {
  const source = factorySource.trim();
  const masked = createRouteLexicalMask(source);
  const arrow =
    /^(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/u.exec(
      masked,
    );
  const expression =
    /^function(?:\s+[A-Za-z_$][\w$]*)?\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/u.exec(
      masked,
    );
  const match = arrow ?? expression;
  const paramName = arrow ? (arrow[1] ?? arrow[2]) : expression?.[1];
  if (!match || !paramName) {
    throw new Error(
      `[vextjs] ${label} must be an inline function with one app parameter and a block body.`,
    );
  }
  const openBrace = match[0].lastIndexOf("{");
  const closeBrace = findRouteMatchingIndex(masked, openBrace, "{", "}");
  if (closeBrace < 0 || closeBrace !== masked.trimEnd().length - 1) {
    throw new Error(
      `[vextjs] ${label} must have a balanced direct block body.`,
    );
  }
  return assertCanonicalRouteFactoryBody(
    paramName,
    source.slice(openBrace + 1, closeBrace),
    label,
    options,
  );
}

export function assertCanonicalRouteFactoryBody(
  paramName: string,
  body: string,
  label: string,
  options: CanonicalRouteFactoryValidationOptions = {},
): number {
  const masked = createRouteLexicalMask(body);
  const identifier = new RegExp(
    `(?<![\\w$])${escapeRouteRegExp(paramName)}(?![\\w$])`,
    "gu",
  );
  let registrations = 0;

  let match: RegExpExecArray | null;
  while ((match = identifier.exec(masked))) {
    const index = match.index!;
    let previous = index - 1;
    while (previous >= 0 && /\s/u.test(masked[previous]!)) previous--;
    let next = index + paramName.length;
    while (next < masked.length && /\s/u.test(masked[next]!)) next++;
    if (masked[previous] === "." || masked[next] === ":") {
      continue;
    }
    const tail = masked.slice(index);
    const member = new RegExp(
      `^${escapeRouteRegExp(paramName)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
      "u",
    ).exec(tail);
    if (member?.[1] && !isVextRouteMethod(member[1])) {
      // The route factory may read or configure other VextApp capabilities.
      // Only the seven registrar members participate in static projection.
      // A naked `app` passed to a helper still reaches the fail-closed branch.
      continue;
    }
    const call = new RegExp(
      `^${escapeRouteRegExp(paramName)}\\s*\\.\\s*(${VEXT_ROUTE_METHODS.join("|")})\\s*\\(`,
      "u",
    ).exec(tail);
    if (!call) {
      throw canonicalRouteFactoryError(label, paramName);
    }
    const openParen = masked.indexOf("(", index + call[0].lastIndexOf("("));
    const closeParen = findRouteMatchingIndex(masked, openParen, "(", ")");
    if (
      closeParen < 0 ||
      !isDirectRouteStatement(
        masked,
        index,
        options.allowCompilerLoweredSequence === true,
      )
    ) {
      throw canonicalRouteFactoryError(label, paramName, call[1]);
    }
    const args = splitRouteTopLevelArgs(body.slice(openParen + 1, closeParen));
    if (args.length !== 2 && args.length !== 3) {
      throw new Error(
        `[vextjs] ${label} ${call[1]!.toUpperCase()} route call must use exactly (path, handler) or (path, options, handler).`,
      );
    }
    const handler = stripRouteComments(args[args.length - 1]!).trim();
    if (
      options.validateHandler !== false &&
      isObviouslyNonCallableRouteSource(handler)
    ) {
      throw new Error(
        `[vextjs] ${label} ${call[1]!.toUpperCase()} route handler must be a function or a callable reference.`,
      );
    }
    registrations++;
    identifier.lastIndex = closeParen + 1;
  }
  return registrations;
}

function canonicalRouteFactoryError(
  label: string,
  paramName: string,
  method?: string,
): Error {
  return new Error(
    `[vextjs] ${label}${method ? ` ${method.toUpperCase()}` : ""} route registration must use a direct top-level statement with ${paramName}.method(path, handler) or ${paramName}.method(path, options, handler); bracket access, extracted/destructured methods, helpers, and runtime control flow are not supported.`,
  );
}

function isDirectRouteStatement(
  maskedBody: string,
  matchIndex: number,
  allowCompilerLoweredSequence: boolean,
): boolean {
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let compilerSequenceStart = -1;
  for (let index = 0; index < matchIndex; index++) {
    const char = maskedBody[index]!;
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "(") parentheses++;
    else if (char === ")") parentheses--;
    else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    else if (
      char === "," &&
      braces === 0 &&
      parentheses === 0 &&
      brackets === 0
    ) {
      compilerSequenceStart = index + 1;
    }
  }
  const statementStart = Math.max(
    maskedBody.lastIndexOf(";", matchIndex - 1) + 1,
    maskedBody.lastIndexOf("\n", matchIndex - 1) + 1,
    maskedBody.lastIndexOf("\r", matchIndex - 1) + 1,
  );
  const directStatement =
    braces === 0 &&
    parentheses === 0 &&
    brackets === 0 &&
    maskedBody.slice(statementStart, matchIndex).trim() === "" &&
    !hasRouteControlPrefix(maskedBody, statementStart);
  if (directStatement) return true;

  // esbuild can lower consecutive top-level expression statements to a comma
  // sequence, including non-registrar app configuration followed by routes.
  // The source scanner keeps the stricter statement grammar. Runtime treats
  // only a depth-zero comma as a boundary; a route behind `if`, `&&`, `?:`, or
  // another nested expression still has a non-empty prefix and is rejected.
  return (
    allowCompilerLoweredSequence &&
    compilerSequenceStart >= 0 &&
    braces === 0 &&
    parentheses === 0 &&
    brackets === 0 &&
    maskedBody.slice(compilerSequenceStart, matchIndex).trim() === ""
  );
}

function hasRouteControlPrefix(
  source: string,
  statementStart: number,
): boolean {
  let previous = statementStart - 1;
  while (previous >= 0 && /\s/u.test(source[previous]!)) previous--;
  if (previous < 0 || source[previous] === ";" || source[previous] === "}") {
    return false;
  }
  const previousChar = source[previous]!;
  if (/[&|?:=,([>!+*/%^-]/u.test(previousChar)) return true;
  if (previousChar === ")") {
    const open = findRouteOpeningIndex(source, previous, "(", ")");
    if (open >= 0) {
      const word = readRoutePreviousIdentifier(source, open - 1);
      if (["if", "for", "while", "with"].includes(word)) return true;
    }
  }
  return ["do", "else", "return", "throw", "yield"].includes(
    readRoutePreviousIdentifier(source, previous),
  );
}

function findRouteOpeningIndex(
  source: string,
  closeIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index--) {
    if (source[index] === closeChar) depth++;
    else if (source[index] === openChar) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readRoutePreviousIdentifier(
  source: string,
  fromIndex: number,
): string {
  let end = fromIndex;
  while (end >= 0 && /\s/u.test(source[end]!)) end--;
  let start = end;
  while (start >= 0 && /[A-Za-z_$]/u.test(source[start]!)) start--;
  return source.slice(start + 1, end + 1);
}

function splitRouteTopLevelArgs(source: string): string[] {
  const masked = createRouteLexicalMask(source);
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index]!;
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  if (args.at(-1) === "") args.pop();
  return args;
}

function isObviouslyNonCallableRouteSource(source: string): boolean {
  const value = source.trim();
  return (
    value === "" ||
    value === "null" ||
    value === "true" ||
    value === "false" ||
    value.startsWith("{") ||
    value.startsWith("[") ||
    /^(?:["'`]|[+-]?(?:\d|\.\d))/u.test(value)
  );
}

function stripRouteComments(source: string): string {
  const masked = createRouteLexicalMask(source);
  let output = "";
  let state: "code" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (
      state === "code" &&
      char === "/" &&
      next === "/" &&
      masked[index] === " "
    ) {
      state = "line";
      output += "  ";
      index++;
      continue;
    }
    if (
      state === "code" &&
      char === "/" &&
      next === "*" &&
      masked[index] === " "
    ) {
      state = "block";
      output += "  ";
      index++;
      continue;
    }
    if (state === "line") {
      if (char === "\n" || char === "\r") {
        state = "code";
        output += char;
      } else output += " ";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        output += "  ";
        index++;
      } else output += char === "\n" || char === "\r" ? char : " ";
      continue;
    }
    output += char;
  }
  return output;
}

function createRouteLexicalMask(source: string): string {
  const chars = source.split("");
  let index = 0;
  while (index < chars.length) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (char === "/" && next === "/") {
      chars[index++] = " ";
      chars[index++] = " ";
      while (
        index < chars.length &&
        chars[index] !== "\n" &&
        chars[index] !== "\r"
      ) {
        chars[index++] = " ";
      }
      continue;
    }
    if (char === "/" && next === "*") {
      chars[index++] = " ";
      chars[index++] = " ";
      while (index < chars.length) {
        if (chars[index] === "*" && chars[index + 1] === "/") {
          chars[index++] = " ";
          chars[index++] = " ";
          break;
        }
        if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
        index++;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      chars[index++] = " ";
      while (index < chars.length) {
        if (chars[index] === "\\") {
          chars[index++] = " ";
          if (index < chars.length) chars[index++] = " ";
          continue;
        }
        const current = chars[index]!;
        if (current === quote) {
          chars[index++] = " ";
          break;
        }
        if (current !== "\n" && current !== "\r") chars[index] = " ";
        index++;
      }
      continue;
    }
    index++;
  }
  return chars.join("");
}

function findRouteMatchingIndex(
  source: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === openChar) depth++;
    else if (source[index] === closeChar) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function escapeRouteRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
