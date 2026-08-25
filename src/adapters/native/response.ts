import type { ServerResponse } from "node:http";
import type { VextRequest } from "../../types/request.js";
import type { VextResponse } from "../../types/response.js";
import type { RouteOptions } from "../../types/app.js";
import type { VextHeaderValue, VextHeaders } from "../../types/headers.js";
import type { CookieSerializeOptions } from "../../types/cookies.js";
import {
  beginResponseSend,
  finishResponseSend,
  finishResponseSendAfterStreamSettlement,
} from "../../lib/response-hooks.js";
import {
  cloneHeaders,
  mergeHeaders,
  replaceHeaders,
  setHeader as setBufferedHeader,
} from "../../lib/headers.js";
import {
  appendSetCookie,
  serializeClearCookie,
  serializeCookie,
} from "../../lib/cookies.js";
import {
  renderErrorUnavailable,
  renderUnavailable,
} from "../../lib/response-render-placeholder.js";
import { buildAttachmentContentDisposition } from "../../lib/content-disposition.js";
import { prepareRedirect } from "../../lib/redirect.js";
import {
  getPreparedRouteResponseSerializers,
  stringifyRouteResponse,
  type CompiledRouteResponseSerializers,
} from "../../lib/response-serializer.js";

type RequestIdSource = Pick<VextRequest, "requestId"> | (() => string);

/**
 * Native ServerResponse → VextResponse 转换（F5 优化：class 实例化）
 *
 * 直接操作 Node.js ServerResponse，不经过第三方 HTTP 框架中间层。
 * 这是 Native Adapter 的核心性能优势之一：跳过 Fastify reply / Koa ctx.response /
 * Express res 等框架的响应对象包装层，直接调用原生 API。
 *
 * F5 优化说明：
 *   从闭包工厂函数 createVextResponse() 改为 class NativeVextResponse。
 *   方法通过原型链共享定义，避免每请求都创建新的闭包对象。
 *   V8 对 class 实例的 Hidden Class 优化比闭包对象更好，
 *   减少每请求的内存分配和 GC 压力。
 *
 *   接口完全兼容：NativeVextResponse implements VextResponse，
 *   外部代码无需任何改动。
 *
 * 核心设计（与其他 Adapter 的 response.ts 逻辑对齐）：
 *
 *   1. 延迟绑定 requestId（request 对象引用或 getRequestId getter）
 *      requestId 在 createVextResponse 调用时尚未生成（requestId 中间件还没执行），
 *      通过 request 对象引用确保 json() 实际调用时才取值（此时 requestId 必然已由中间件生成）。
 *
 *   2. 内建出口包装（_wrapEnabled 标志）
 *      response-wrapper 中间件通过 _enableWrap() 开启包装标志。
 *      json() 根据标志决定是否将响应体包装为 { code: 0, data, requestId }。
 *      rawJson() 始终绕过包装——仅供框架内部错误处理使用。
 *
 *   3. 重复发送保护（_sent 标志）
 *      防止 handler 中误调用多次 res.json()，dev 模式打印警告，生产模式静默忽略。
 *
 *   4. 链式调用（status / setHeader 返回 this）
 *      res.status(201).json(data) 正确设置 HTTP 201。
 *
 *   5. 204 No Content 合规（RFC 9110 §15.3.5）
 *      无论包装是否开启，204 均发送无消息体的响应。
 *
 *   6. 直接 JSON 序列化
 *      使用 serverResponse.end(JSON.stringify(...))，
 *      没有任何中间层（Fastify 的 reply.send / Express 的 res.json 都有额外逻辑）。
 *      这是 Native Adapter 性能优势的关键来源。
 *
 * 与其他 Adapter 的差异：
 *   - Fastify: reply.status().header().send(JSON.stringify(...))
 *   - Express: res.status().set().json(data) 或 res.send()
 *   - Koa: ctx.status = N; ctx.body = data
 *   - Hono: ResponseBox 容器捕获 c.json() 返回的 Web Response
 *   - Native: serverResponse.writeHead(status, headers); serverResponse.end(body)
 *     零中间层，最短调用路径
 *
 * 时序保证：
 *   createVextResponse(serverResponse, req)
 *     ↓ executeChain 开始
 *   [requestIdMiddleware]        → req.requestId = 'a1b2c3d4...'
 *   [responseWrapperMiddleware]  → res._enableWrap()
 *     ↓
 *   [handler] res.status(201).json(data)
 *     → _wrapEnabled = true
 *     → req.requestId → 'a1b2c3d4...'（已设置）
 *     → serverResponse.end(JSON.stringify({ code: 0, data, requestId }))
 *     → HTTP 201 ✅
 *
 * @see adapters/fastify/response.ts（Fastify Adapter 对应实现）
 * @see adapters/express/response.ts（Express Adapter 对应实现）
 * @see adapters/koa/response.ts（Koa Adapter 对应实现）
 * @see adapters/hono/response.ts（Hono Adapter 对应实现）
 */

/**
 * 是否为生产环境（模块级缓存，避免每次 checkSent 都读取 process.env）
 */
const _isProduction = process.env.NODE_ENV === "production";

/**
 * NativeVextResponse — class 实现的 VextResponse
 *
 * F5 优化核心：方法定义在原型上，所有实例共享，
 * 避免闭包工厂模式下每请求创建 N 个函数对象。
 *
 * V8 Hidden Class：class 实例的属性形状在构造时确定，
 * V8 可保持快速属性模式（vs 闭包对象的动态形状）。
 */
class NativeVextResponse implements VextResponse {
  /** Node.js 原始 ServerResponse */
  private _serverResponse: ServerResponse;

  /** 延迟获取 requestId 的来源；Native adapter 传入 request 对象，避免每请求 getter 闭包 */
  private _requestIdSource: RequestIdSource;

  /** 当前 HTTP 状态码（默认 200，可通过 status() 修改） */
  private _status: number = 200;

  /** 响应头缓冲区（通过 setHeader() 累积，在发送时一次性设置） */
  private _headers: VextHeaders = {};

  /** 出口包装开关（由 response-wrapper 中间件通过 _enableWrap() 开启） */
  private _wrapEnabled: boolean = false;

  /** 重复发送保护标志（防止 handler 中多次调用 json/rawJson/text） */
  private _sent: boolean = false;

  /**
   * Buffered body exit staged until `_flush()` after onion unwind.
   * Lets post-`await next()` middleware still mutate headers.
   */
  private _pending: {
    status: number;
    body?: string;
    /** Applied before buffered headers; `null` removes Content-Type (204). */
    defaultContentType?: string | null;
    /** When true, Content-Length is set after `_applyHeaders` (text path). */
    contentLengthAfterHeaders?: boolean;
    sendState: ReturnType<typeof beginResponseSend>;
  } | null = null;

  /** True once the underlying ServerResponse has been written/ended. */
  private _flushed: boolean = false;

  /** Registration-time compiled response serializers for this route. */
  private _responseSerializers?: CompiledRouteResponseSerializers;

  /** 发送前拦截钩子（缓存中间件在 MISS 时注册） @internal */
  _onSend?: (data: unknown, statusCode: number, headers?: VextHeaders) => void;

  /**
   * Token for exactly-once req.onClose via finishResponseSend.
   * Typically the VextRequest for the active request.
   * @internal
   */
  _closeToken?: object;

  constructor(
    serverResponse: ServerResponse,
    requestIdSource: RequestIdSource,
    closeToken?: object,
    responseSerializers?: CompiledRouteResponseSerializers,
  ) {
    this._serverResponse = serverResponse;
    this._requestIdSource = requestIdSource;
    if (closeToken) {
      this._closeToken = closeToken;
    }
    this._responseSerializers = responseSerializers;
  }

  // ── 内部辅助方法（原型上共享）──────────────────────────

  /**
   * 延迟读取 requestId。
   *
   * Native adapter 热路径传入 VextRequest 对象，避免每请求创建 `() => req.requestId`
   * 闭包；保留函数来源兼容内部测试或未来调用方。
   */
  private _resolveRequestId(): string {
    const source = this._requestIdSource;
    return typeof source === "function" ? source() : source.requestId;
  }

  /**
   * 将累积的响应头设置到 ServerResponse 上
   *
   * 在每个发送方法中调用，将通过 setHeader() 累积的头信息
   * 一次性设置到 serverResponse 对象上。
   *
   * 使用原生 serverResponse.setHeader() 而非 writeHead()，
   * 因为 writeHead() 会立即发送 header，而 setHeader() 允许后续修改。
   * 最终的 statusCode 和 header 在 end() 调用时统一发送。
   */
  private _applyHeaders(): void {
    const headers = this._headers;
    const sr = this._serverResponse;
    for (const key in headers) {
      sr.setHeader(key, headers[key]!);
    }
  }

  /**
   * 检查是否已发送响应（重复发送保护）
   *
   * 第一次调用返回 false 并设置 _sent = true。
   * 后续调用返回 true（表示已发送，调用方应终止当前方法）。
   * dev 模式下打印警告，帮助开发者发现 handler 中的重复发送 bug。
   *
   * @param methodName 调用的方法名（用于警告消息）
   * @returns true 表示已发送（应终止当前方法），false 表示可以发送
   */
  private _checkSent(methodName: string): boolean {
    if (this._sent) {
      if (!_isProduction) {
        console.warn(
          `[vextjs] ⚠️ res.${methodName}() called after response already sent. ` +
            "This is a no-op. Check your handler for duplicate sends.",
        );
      }
      return true;
    }
    this._sent = true;
    return false;
  }

  private _stringifyJson(data: unknown): string {
    try {
      return JSON.stringify(data) ?? "";
    } catch (error) {
      this._sent = false;
      throw error;
    }
  }

  private _stringifyRouteJson(
    data: unknown,
    status: number,
    wrapped: boolean,
  ): string {
    try {
      return stringifyRouteResponse(
        this._responseSerializers,
        status,
        data,
        wrapped,
      );
    } catch (error) {
      this._sent = false;
      throw error;
    }
  }

  /**
   * Stage a JSON body for deferred flush (onion post-next headers).
   *
   * @param body   已序列化的 JSON 字符串
   * @param status HTTP 状态码
   * @param sendState response:before lifecycle state finished at `_flush`
   */
  private _sendJsonString(
    body: string,
    status: number,
    sendState: ReturnType<typeof beginResponseSend>,
  ): void {
    this._pending = {
      status,
      body,
      defaultContentType: "application/json; charset=utf-8",
      contentLengthAfterHeaders: false,
      sendState,
    };
  }

  /**
   * Stage a 204 No Content exit for deferred flush.
   *
   * RFC 9110 §15.3.5 要求 204 不能有消息体。
   */
  private _send204(sendState: ReturnType<typeof beginResponseSend>): void {
    this._pending = {
      status: 204,
      defaultContentType: null,
      sendState,
    };
  }

  /**
   * Write staged body/headers to the underlying ServerResponse.
   *
   * Called once by the adapter after the middleware chain (and error handler)
   * returns so onion after-logic can still `setHeader` / `cookie`.
   */
  _discardPendingSend(): boolean {
    if (this._flushed) return false;
    this._pending = null;
    this._sent = false;
    return true;
  }

  _flush(): void {
    if (this._flushed || !this._pending) return;
    this._flushed = true;
    const pending = this._pending;
    this._pending = null;

    const sr = this._serverResponse;
    sr.statusCode = pending.status;

    if (pending.defaultContentType === null) {
      sr.removeHeader("Content-Type");
    } else if (pending.defaultContentType) {
      sr.setHeader("Content-Type", pending.defaultContentType);
    }

    if (
      pending.body !== undefined &&
      pending.contentLengthAfterHeaders !== true
    ) {
      sr.setHeader("Content-Length", Buffer.byteLength(pending.body));
    }

    this._applyHeaders();

    if (
      pending.body !== undefined &&
      pending.contentLengthAfterHeaders === true
    ) {
      sr.setHeader("Content-Length", Buffer.byteLength(pending.body));
    }

    if (pending.body !== undefined) {
      sr.end(pending.body);
    } else {
      sr.end();
    }

    finishResponseSend(this, pending.sendState);
  }

  // ── VextResponse 接口实现（原型方法，所有实例共享）──────

  /**
   * 返回 JSON 响应
   *
   * 当出口包装开启时（response-wrapper 中间件已执行 _enableWrap()），
   * 自动包装为：{ code: 0, data, requestId }
   * 当包装未开启时，直接发送原始 data。
   *
   * 204 特殊处理：无论包装是否开启，204 均不发送消息体（RFC 9110 §15.3.5）。
   *
   * Native 特殊处理：
   *   直接调用 serverResponse.end(JSON.stringify(...))，
   *   没有任何框架中间层（Fastify 有 reply.send、Express 有 res.json、
   *   Koa 有 ctx.body 赋值），这是 Native Adapter 性能优势的关键来源。
   */
  json(data: unknown, status?: number): void {
    if (this._checkSent("json")) return;

    let finalStatus = status ?? this._status;
    this._status = finalStatus;

    // Session (_onBeforeSend) must run before route-cache (_onSend) so Set-Cookie
    // from auto-commit is visible to cache policy. Cache still receives the
    // original handler data (not response:before patches).
    const originalData = data;
    const sendState = beginResponseSend(this, {
      kind: "json",
      data,
      status: finalStatus,
      headers: cloneHeaders(this._headers),
      wrapped: this._wrapEnabled,
      requestId: this._resolveRequestId(),
    });
    if (this._onSend) {
      this._onSend(originalData, sendState.status, sendState.headers);
    }
    data = sendState.data;
    finalStatus = sendState.status;
    this._status = finalStatus;
    replaceHeaders(this._headers, sendState.headers);

    if (this._wrapEnabled) {
      // 204 No Content 不能有消息体（RFC 9110 §15.3.5）
      if (finalStatus === 204) {
        this._send204(sendState);
        return;
      }

      // 出口包装：{ code: 0, data, requestId }
      this._sendJsonString(
        this._stringifyRouteJson(
          {
            code: 0,
            data,
            requestId: this._resolveRequestId(),
          },
          finalStatus,
          true,
        ),
        finalStatus,
        sendState,
      );
      return;
    }

    // 未包装模式
    if (finalStatus === 204) {
      this._send204(sendState);
      return;
    }

    this._sendJsonString(
      this._stringifyRouteJson(data, finalStatus, false),
      finalStatus,
      sendState,
    );
  }

  /**
   * 返回原始 JSON（不经过出口包装）
   *
   * 仅框架内部错误处理使用，用户代码不应直接调用。
   * 通过 VextPublicResponse 类型从用户可见接口中排除。
   *
   * @internal
   */
  rawJson(data: unknown, status?: number): void {
    if (this._checkSent("rawJson")) return;

    let finalStatus = status ?? this._status;
    this._status = finalStatus;
    const sendState = beginResponseSend(this, {
      kind: "rawJson",
      data,
      status: finalStatus,
      headers: cloneHeaders(this._headers),
      wrapped: false,
      requestId: this._resolveRequestId(),
    });
    data = sendState.data;
    finalStatus = sendState.status;
    this._status = finalStatus;
    replaceHeaders(this._headers, sendState.headers);

    this._sendJsonString(this._stringifyJson(data), finalStatus, sendState);
  }

  /**
   * 返回纯文本响应（不经过出口包装）
   */
  text(content: string, status?: number): void {
    if (this._checkSent("text")) return;

    let finalStatus = status ?? this._status;
    this._status = finalStatus;
    const sendState = beginResponseSend(this, {
      kind: "text",
      data: content,
      status: finalStatus,
      headers: cloneHeaders(this._headers),
      wrapped: false,
      requestId: this._resolveRequestId(),
    });
    content =
      typeof sendState.data === "string" ? sendState.data : String(content);
    finalStatus = sendState.status;
    this._status = finalStatus;
    replaceHeaders(this._headers, sendState.headers);

    // Defer write so post-next setHeader can still override Content-Type etc.
    this._pending = {
      status: finalStatus,
      body: content,
      defaultContentType: "text/plain; charset=utf-8",
      contentLengthAfterHeaders: true,
      sendState,
    };
  }

  _sendHtml(
    html: string,
    status: number,
    headers: VextHeaders,
    kind: "html" | "render",
    data?: unknown,
  ): void {
    if (this._checkSent(kind)) return;

    let finalStatus = status ?? this._status;
    this._status = finalStatus;
    mergeHeaders(this._headers, headers);
    const sendState = beginResponseSend(this, {
      kind,
      data: data ?? html,
      status: finalStatus,
      headers: cloneHeaders(this._headers),
      wrapped: false,
      requestId: this._resolveRequestId(),
    });
    html = typeof sendState.data === "string" ? sendState.data : html;
    finalStatus = sendState.status;
    this._status = finalStatus;
    replaceHeaders(this._headers, sendState.headers);

    this._pending = {
      status: finalStatus,
      body: html,
      defaultContentType: "text/html; charset=utf-8",
      contentLengthAfterHeaders: false,
      sendState,
    };
  }

  render = renderUnavailable;

  renderError = renderErrorUnavailable;

  /**
   * 流式响应（大文件传输、实时数据流）
   *
   * 直接将 ReadableStream pipe 到 ServerResponse。
   * 直接使用 Node.js 原生 pipe 机制，不经过额外框架流转层。
   */
  stream(
    readable: NodeJS.ReadableStream,
    contentType: string = "application/octet-stream",
  ): void {
    if (this._checkSent("stream")) return;

    const sendState = beginResponseSend(this, {
      kind: "stream",
      status: this._status,
      headers: cloneHeaders(this._headers),
      wrapped: false,
      requestId: this._resolveRequestId(),
    });
    this._status = sendState.status;
    replaceHeaders(this._headers, sendState.headers);

    // Streams cannot be deferred; mark flushed so `_flush` is a no-op.
    this._flushed = true;
    this._pending = null;

    const sr = this._serverResponse;
    sr.statusCode = this._status;
    sr.setHeader("Content-Type", contentType);
    this._applyHeaders();

    // 使用 pipe 自动处理背压（backpressure）
    finishResponseSendAfterStreamSettlement(this, sendState, readable, sr);
    (readable as NodeJS.ReadableStream).pipe(sr);
  }

  /**
   * 文件下载（触发浏览器下载行为）
   *
   * 自动设置 Content-Disposition: attachment 头，
   * 触发浏览器的文件下载对话框。
   */
  download(
    readable: NodeJS.ReadableStream,
    filename: string,
    contentType?: string,
  ): void {
    if (this._checkSent("download")) return;

    const ct = contentType ?? "application/octet-stream";
    const headers = cloneHeaders(this._headers);
    setBufferedHeader(headers, "Content-Type", ct);
    setBufferedHeader(
      headers,
      "Content-Disposition",
      buildAttachmentContentDisposition(filename),
    );
    const sendState = beginResponseSend(this, {
      kind: "download",
      status: this._status,
      headers,
      wrapped: false,
      requestId: this._resolveRequestId(),
    });
    this._status = sendState.status;
    replaceHeaders(this._headers, sendState.headers);

    this._flushed = true;
    this._pending = null;

    const sr = this._serverResponse;
    sr.statusCode = this._status;
    this._applyHeaders();

    finishResponseSendAfterStreamSettlement(this, sendState, readable, sr);
    (readable as NodeJS.ReadableStream).pipe(sr);
  }

  /**
   * 重定向
   *
   * 直接设置 Location 响应头和状态码，然后 end()。
   * 不依赖任何框架的 redirect 方法。
   *
   * Location is normalized (non-ASCII encoded, CRLF rejected) and status is
   * coerced to an allowed redirect code *before* mark-sent; write failures roll back.
   */
  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): void {
    const prepared = prepareRedirect(url, status);
    if (this._checkSent("redirect")) return;

    try {
      const headers = cloneHeaders(this._headers);
      setBufferedHeader(headers, "Location", prepared.location);
      const sendState = beginResponseSend(this, {
        kind: "redirect",
        data: prepared.location,
        status: prepared.status,
        headers,
        wrapped: false,
        requestId: this._resolveRequestId(),
      });
      this._status = sendState.status;
      replaceHeaders(this._headers, sendState.headers);
      setBufferedHeader(this._headers, "Content-Length", "0");
      this._pending = {
        status: this._status,
        sendState,
      };
    } catch (error) {
      this._sent = false;
      this._pending = null;
      throw error;
    }
  }

  /**
   * 设置 HTTP 状态码（链式调用）
   */
  status(code: number): this {
    this._status = code;
    return this;
  }

  /**
   * 设置响应头（链式调用）
   */
  setHeader(name: string, value: VextHeaderValue): this {
    setBufferedHeader(this._headers, name, value);
    return this;
  }

  cookie(name: string, value: string, options?: CookieSerializeOptions): this {
    appendSetCookie(this._headers, serializeCookie(name, value, options));
    return this;
  }

  clearCookie(name: string, options?: CookieSerializeOptions): this {
    appendSetCookie(this._headers, serializeClearCookie(name, options));
    return this;
  }

  /**
   * 当前 HTTP 状态码（只读）
   *
   * 返回通过 .status() 设置的值，或 json/rawJson/text 等方法
   * 传入的 status 参数所确定的最终状态码。默认 200。
   *
   * 主要用途：洋葱模型 after-middleware 在 `await next()` 后
   * 读取响应状态码（如 access-log 中间件记录请求耗时与状态码）。
   */
  get statusCode(): number {
    return this._status;
  }

  get headersSent(): boolean {
    return this._sent;
  }

  /**
   * 开启出口包装标志（内部方法）
   *
   * 仅由 response-wrapper 中间件调用，用户代码不应直接调用。
   * 调用后 json() 将自动包装响应为 { code: 0, data, requestId }。
   *
   * @internal
   */
  _enableWrap(): void {
    this._wrapEnabled = true;
  }

  _isSent(): boolean {
    return this._sent;
  }
}

/**
 * 创建 VextResponse 实例（工厂函数 — 保持与其他 Adapter 的调用接口一致）
 *
 * F5 优化：内部使用 NativeVextResponse class 实例化，
 * 方法通过原型链共享，避免闭包工厂模式下每请求创建 N 个函数对象。
 *
 * @param serverResponse   Node.js ServerResponse 原始响应对象
 * @param requestIdSource  延迟获取 requestId 的来源；优先传入 VextRequest 对象以减少闭包分配
 * @param closeToken       Optional token for req.onClose (typically the VextRequest)
 * @returns VextResponse 实例（含内部方法 _enableWrap）
 */
export function createVextResponse(
  serverResponse: ServerResponse,
  requestIdSource: RequestIdSource,
  closeToken?: object,
  routeOptions?: RouteOptions,
  routeMethod?: string,
): VextResponse {
  return new NativeVextResponse(
    serverResponse,
    requestIdSource,
    closeToken,
    getPreparedRouteResponseSerializers(routeOptions, routeMethod),
  );
}
