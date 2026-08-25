import type Koa from "koa";
import type { VextResponse } from "../../types/response.js";
import type { RouteOptions } from "../../types/app.js";
import type { VextHeaderValue, VextHeaders } from "../../types/headers.js";
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
} from "../../lib/response-serializer.js";

/**
 * Koa Context → VextResponse 转换
 *
 * 核心设计（与 Hono / Fastify / Express Adapter 的 response.ts 逻辑对齐）：
 *
 *   1. 延迟绑定 requestId（getRequestId getter）
 *   2. 内建出口包装（_wrapEnabled 标志）
 *   3. 重复发送保护（_sent 标志）
 *   4. 链式调用（status / setHeader 返回 this）
 *   5. 204 No Content 合规（RFC 9110 §15.3.5）
 *   6. 手动 JSON 序列化 via ctx.res.end(JSON.stringify(...))
 *   7. Deferred terminal flush — json/rawJson/text/html/redirect stage into
 *      `_pending` and only write the host response in `_flush()` after the onion
 *      chain unwinds, so post-`await next()` middleware can still setHeader/cookie.
 *
 * @param ctx            Koa Context 对象
 * @param getRequestId   延迟获取 requestId 的 getter 函数
 * @returns VextResponse 实例（含内部方法 _enableWrap）
 */
export function createVextResponse(
  ctx: Koa.Context,
  getRequestId: () => string,
  closeToken?: object,
  routeOptions?: RouteOptions,
  routeMethod?: string,
): VextResponse {
  /** 当前 HTTP 状态码（默认 200，可通过 status() 修改） */
  let _status = 200;

  /** 响应头缓冲区（通过 setHeader() 累积，在发送时一次性设置） */
  const _headers: VextHeaders = {};

  /** 出口包装开关（由 response-wrapper 中间件通过 _enableWrap() 开启） */
  let _wrapEnabled = false;

  /** 重复发送保护标志（防止 handler 中多次调用 json/rawJson/text） */
  let _sent = false;

  type PendingFlush = {
    status: number;
    body?: string;
    /** Applied before buffered headers; `null` removes Content-Type (204). */
    defaultContentType?: string | null;
    /** When true, Content-Length is set after applyHeaders (text path). */
    contentLengthAfterHeaders?: boolean;
    sendState: ReturnType<typeof beginResponseSend>;
  };
  let _pending: PendingFlush | null = null;
  let _flushed = false;
  const _responseSerializers = getPreparedRouteResponseSerializers(
    routeOptions,
    routeMethod,
  );

  /**
   * 将累积的响应头设置到 Koa Context 的底层 ServerResponse 上
   */
  function applyHeaders(): void {
    for (const [k, v] of Object.entries(_headers)) {
      ctx.res.setHeader(k, v);
    }
  }

  function queuePending(pending: PendingFlush): void {
    _pending = pending;
  }

  function flushPending(): void {
    if (_flushed || !_pending) return;
    _flushed = true;
    const pending = _pending;
    _pending = null;

    ctx.res.statusCode = pending.status;
    if (pending.defaultContentType === null) {
      ctx.res.removeHeader("Content-Type");
    } else if (pending.defaultContentType) {
      ctx.res.setHeader("Content-Type", pending.defaultContentType);
    }
    if (
      pending.body !== undefined &&
      pending.contentLengthAfterHeaders !== true
    ) {
      ctx.res.setHeader("Content-Length", Buffer.byteLength(pending.body));
    }
    applyHeaders();
    if (
      pending.body !== undefined &&
      pending.contentLengthAfterHeaders === true
    ) {
      ctx.res.setHeader("Content-Length", Buffer.byteLength(pending.body));
    }
    if (pending.body !== undefined) {
      ctx.res.end(pending.body);
    } else {
      ctx.res.end();
    }
    finishResponseSend(res, pending.sendState);
  }

  /**
   * 检查是否已发送响应（重复发送保护）
   */
  function checkSent(methodName: string): boolean {
    if (_sent) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[vextjs] ⚠️ res.${methodName}() called after response already sent. ` +
            "This is a no-op. Check your handler for duplicate sends.",
        );
      }
      return true;
    }
    _sent = true;
    return false;
  }

  function stringifyJson(data: unknown): string {
    try {
      return JSON.stringify(data) ?? "";
    } catch (error) {
      _sent = false;
      throw error;
    }
  }

  function stringifyRouteJson(
    data: unknown,
    status: number,
    wrapped: boolean,
  ): string {
    try {
      return stringifyRouteResponse(
        _responseSerializers,
        status,
        data,
        wrapped,
      );
    } catch (error) {
      _sent = false;
      throw error;
    }
  }

  const res: VextResponse & { _closeToken?: object } = {
    /**
     * 返回 JSON 响应
     *
     * 204 特殊处理：无论包装是否开启，204 均不发送消息体（RFC 9110 §15.3.5）。
     */
    json(data: unknown, status?: number): void {
      if (checkSent("json")) return;

      let finalStatus = status ?? _status;
      _status = finalStatus;

      // Session (_onBeforeSend) must run before route-cache (_onSend) so Set-Cookie
      // from auto-commit is visible to cache policy. Cache still receives the
      // original handler data (not response:before patches).
      const originalData = data;
      const sendState = beginResponseSend(res, {
        kind: "json",
        data,
        status: finalStatus,
        headers: cloneHeaders(_headers),
        wrapped: _wrapEnabled,
        requestId: getRequestId(),
      });
      if (res._onSend) {
        res._onSend(originalData, sendState.status, sendState.headers);
      }
      data = sendState.data;
      finalStatus = sendState.status;
      _status = finalStatus;
      replaceHeaders(_headers, sendState.headers);

      if (_wrapEnabled) {
        // P1-7: 204 No Content 不能有消息体（RFC 9110 §15.3.5）
        if (finalStatus === 204) {
          queuePending({
            status: finalStatus,
            defaultContentType: null,
            sendState,
          });
          return;
        }

        const body = stringifyRouteJson(
          {
            code: 0,
            data,
            requestId: getRequestId(),
          },
          finalStatus,
          true,
        );
        queuePending({
          status: finalStatus,
          body,
          defaultContentType: "application/json; charset=utf-8",
          sendState,
        });
        return;
      }

      // 未包装模式
      if (finalStatus === 204) {
        queuePending({
          status: finalStatus,
          defaultContentType: null,
          sendState,
        });
        return;
      }

      queuePending({
        status: finalStatus,
        body: stringifyRouteJson(data, finalStatus, false),
        defaultContentType: "application/json; charset=utf-8",
        sendState,
      });
    },

    /**
     * 返回原始 JSON（不经过出口包装）
     *
     * @internal
     */
    rawJson(data: unknown, status?: number): void {
      if (checkSent("rawJson")) return;

      let finalStatus = status ?? _status;
      _status = finalStatus;
      const sendState = beginResponseSend(res, {
        kind: "rawJson",
        data,
        status: finalStatus,
        headers: cloneHeaders(_headers),
        wrapped: false,
        requestId: getRequestId(),
      });
      data = sendState.data;
      finalStatus = sendState.status;
      _status = finalStatus;
      replaceHeaders(_headers, sendState.headers);

      queuePending({
        status: finalStatus,
        body: stringifyJson(data),
        defaultContentType: "application/json; charset=utf-8",
        sendState,
      });
    },

    /**
     * 返回纯文本响应（不经过出口包装）
     */
    text(content: string, status?: number): void {
      if (checkSent("text")) return;

      let finalStatus = status ?? _status;
      _status = finalStatus;
      const sendState = beginResponseSend(res, {
        kind: "text",
        data: content,
        status: finalStatus,
        headers: cloneHeaders(_headers),
        wrapped: false,
        requestId: getRequestId(),
      });
      content =
        typeof sendState.data === "string" ? sendState.data : String(content);
      finalStatus = sendState.status;
      _status = finalStatus;
      replaceHeaders(_headers, sendState.headers);

      queuePending({
        status: finalStatus,
        body: content,
        defaultContentType: "text/plain; charset=utf-8",
        contentLengthAfterHeaders: true,
        sendState,
      });
    },

    _sendHtml(html, status, headers, kind, data): void {
      if (checkSent(kind)) return;

      let finalStatus = status ?? _status;
      _status = finalStatus;
      mergeHeaders(_headers, headers);
      const sendState = beginResponseSend(res, {
        kind,
        data: data ?? html,
        status: finalStatus,
        headers: cloneHeaders(_headers),
        wrapped: false,
        requestId: getRequestId(),
      });
      html = typeof sendState.data === "string" ? sendState.data : html;
      finalStatus = sendState.status;
      _status = finalStatus;
      replaceHeaders(_headers, sendState.headers);

      queuePending({
        status: finalStatus,
        body: html,
        defaultContentType: "text/html; charset=utf-8",
        contentLengthAfterHeaders: true,
        sendState,
      });
    },

    _discardPendingSend(): boolean {
      if (_flushed) return false;
      _pending = null;
      _sent = false;
      return true;
    },

    _flush(): void {
      flushPending();
    },

    render: renderUnavailable,

    renderError: renderErrorUnavailable,

    /**
     * 流式响应（大文件传输、实时数据流）
     */
    stream(
      readable: NodeJS.ReadableStream,
      contentType: string = "application/octet-stream",
    ): void {
      if (checkSent("stream")) return;

      const sendState = beginResponseSend(res, {
        kind: "stream",
        status: _status,
        headers: cloneHeaders(_headers),
        wrapped: false,
        requestId: getRequestId(),
      });
      _status = sendState.status;
      replaceHeaders(_headers, sendState.headers);

      // Streams cannot be deferred; mark flushed so `_flush` is a no-op.
      _flushed = true;
      _pending = null;

      ctx.res.statusCode = _status;
      ctx.res.setHeader("Content-Type", contentType);
      applyHeaders();

      finishResponseSendAfterStreamSettlement(
        res,
        sendState,
        readable,
        ctx.res,
      );
      readable.pipe(ctx.res);
    },

    /**
     * 文件下载（触发浏览器下载行为）
     */
    download(
      readable: NodeJS.ReadableStream,
      filename: string,
      contentType?: string,
    ): void {
      if (checkSent("download")) return;

      const ct = contentType ?? "application/octet-stream";
      const headers = cloneHeaders(_headers);
      setBufferedHeader(headers, "Content-Type", ct);
      setBufferedHeader(
        headers,
        "Content-Disposition",
        buildAttachmentContentDisposition(filename),
      );
      const sendState = beginResponseSend(res, {
        kind: "download",
        status: _status,
        headers,
        wrapped: false,
        requestId: getRequestId(),
      });
      _status = sendState.status;
      replaceHeaders(_headers, sendState.headers);

      _flushed = true;
      _pending = null;

      ctx.res.statusCode = _status;
      applyHeaders();

      finishResponseSendAfterStreamSettlement(
        res,
        sendState,
        readable,
        ctx.res,
      );
      readable.pipe(ctx.res);
    },

    /**
     * 重定向
     *
     * Location is normalized (non-ASCII encoded, CRLF rejected) and status is
     * coerced to an allowed redirect code *before* mark-sent; write failures roll back.
     */
    redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): void {
      const prepared = prepareRedirect(url, status);
      if (checkSent("redirect")) return;

      try {
        const headers = cloneHeaders(_headers);
        setBufferedHeader(headers, "Location", prepared.location);
        const sendState = beginResponseSend(res, {
          kind: "redirect",
          data: prepared.location,
          status: prepared.status,
          headers,
          wrapped: false,
          requestId: getRequestId(),
        });
        _status = sendState.status;
        replaceHeaders(_headers, sendState.headers);
        setBufferedHeader(_headers, "Content-Length", "0");
        queuePending({ status: _status, sendState });
      } catch (error) {
        _sent = false;
        _pending = null;
        throw error;
      }
    },

    status(code: number): VextResponse {
      _status = code;
      return res;
    },

    setHeader(name: string, value: VextHeaderValue): VextResponse {
      setBufferedHeader(_headers, name, value);
      return res;
    },

    cookie(name, value, options): VextResponse {
      appendSetCookie(_headers, serializeCookie(name, value, options));
      return res;
    },

    clearCookie(name, options): VextResponse {
      appendSetCookie(_headers, serializeClearCookie(name, options));
      return res;
    },

    get statusCode(): number {
      return _status;
    },

    get headersSent(): boolean {
      return _sent;
    },

    _enableWrap(): void {
      _wrapEnabled = true;
    },

    _isSent(): boolean {
      return _sent;
    },
  };

  if (closeToken) {
    res._closeToken = closeToken;
  }

  return res;
}
