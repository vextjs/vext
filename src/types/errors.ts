/**
 * HttpError — 框架 HTTP 错误类
 *
 * 所有通过 app.throw() 抛出的错误最终都会被包装为 HttpError。
 * 全局错误处理中间件捕获后格式化为统一错误响应：
 *   { code, message, details?, requestId }
 *
 * 设计说明：
 *   - status: HTTP 状态码（400/401/403/404/409/500…）
 *   - message: 错误描述（可能是 i18n 翻译后的文本）
 *   - code: 业务错误码（可选；不传则响应 code = status；传入则响应 code = bizCode）
 *   - details: 业务错误详情（可选；响应前由 error-handler 做 JSON-safe 清洗）
 *
 * 业务错误码优先级：
 *   用户显式传入 code > locale 配置中的 code > 默认使用 status
 *
 * @example
 * throw new HttpError(404, 'User not found')
 * // → { code: 404, message: 'User not found', requestId: '...' }
 *
 * @example
 * throw new HttpError(400, '邮箱已注册', 10001)
 * // → { code: 10001, message: '邮箱已注册', requestId: '...' }
 */
export type VextJsonPrimitive = string | number | boolean | null;

export type VextJsonValue =
  | VextJsonPrimitive
  | VextJsonValue[]
  | { [key: string]: VextJsonValue };

export type VextErrorDetails =
  | { [key: string]: VextJsonValue }
  | VextJsonValue[];

export interface HttpErrorOptions {
  code?: number | string;
  details?: unknown;
}

function isHttpErrorOptions(value: unknown): value is HttpErrorOptions {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("code" in value || "details" in value)
  );
}

const HTTP_ERROR_BRAND = Symbol.for("vext.http-error");
const VALIDATION_ERROR_BRAND = Symbol.for("vext.validation-error");

export class HttpError extends Error {
  public override readonly name = "HttpError" as const;
  public readonly code?: number | string;
  public readonly details?: unknown;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== HttpError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return Boolean(
      value &&
      typeof value === "object" &&
      (value as Record<PropertyKey, unknown>)[HTTP_ERROR_BRAND] === true,
    );
  }

  constructor(
    /** HTTP 状态码 */
    public readonly status: number,
    /** 错误描述 */
    message: string,
    /** 业务错误码或完整 options（可选） */
    codeOrOptions?: number | string | HttpErrorOptions,
    /** 业务错误详情（可选；仅供底层兼容，推荐使用 options） */
    details?: unknown,
  ) {
    super(message);
    Object.defineProperty(this, HTTP_ERROR_BRAND, { value: true });

    if (isHttpErrorOptions(codeOrOptions)) {
      this.code = codeOrOptions.code;
      this.details = codeOrOptions.details;
    } else {
      this.code = codeOrOptions;
      this.details = details;
    }

    // 确保 instanceof 检查在继承链中正常工作
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 校验错误中的单个字段错误描述
 */
export interface VextValidationFieldError {
  /** 字段名称 */
  field: string;

  /** 错误描述 */
  message: string;
}

/**
 * VextValidationError — 参数校验失败错误
 *
 * 当 validate 中间件校验请求参数失败时抛出此错误。
 * 全局错误处理中间件捕获后默认格式化为 422 响应。路径参数校验失败
 * 使用 400，表示请求路径参数本身无效。
 *
 * @example
 * throw new VextValidationError([
 *   { field: 'email', message: '邮箱格式不正确' },
 *   { field: 'age', message: '年龄必须大于 0' },
 * ])
 */
export class VextValidationError extends Error {
  public override readonly name = "VextValidationError" as const;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== VextValidationError) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return Boolean(
      value &&
      typeof value === "object" &&
      (value as Record<PropertyKey, unknown>)[VALIDATION_ERROR_BRAND] === true,
    );
  }

  constructor(
    /** 校验失败的字段错误列表 */
    public readonly errors: VextValidationFieldError[],
    /** 错误消息（默认 'Validation failed'） */
    message: string = "Validation failed",
    /** 路径参数失败使用 400，其他请求数据校验保持 422。 */
    public readonly status: 400 | 422 = 422,
  ) {
    super(message);
    Object.defineProperty(this, VALIDATION_ERROR_BRAND, { value: true });

    // 确保 instanceof 检查在继承链中正常工作
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
