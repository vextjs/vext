import type { Context } from "hono";
import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
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
  isSetCookieHeader,
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
 * 共享 Response 容器
 *
 * Hono 的 route handler 必须返回 Response 对象。
 * 但 vext 的中间件链通过 VextResponse 的方法（json/text/...）间接调用 Hono 的 API。
 * 这些 API（c.json / c.body / c.text / c.redirect）都返回 Response 对象。
 *
 * 通过 ResponseBox 容器，VextResponse 的每个发送方法将 Hono 返回的 Response
 * 存储到 box.value 中，adapter 的 route handler 随后通过 box.value 获取最终 Response
 * 返回给 Hono。
 *
 * 如果中间件链执行完毕后 box.value 仍为 null，说明 handler 没有调用任何发送方法，
 * adapter 将返回一个空的 204 Response 作为兜底。
 *
 * With deferred flush: terminal sends stage into `_pending` and only write into
 * the box during `_flush()` after the onion chain unwinds, so post-`await next()`
 * middleware can still setHeader/cookie.
 */
export interface ResponseBox {
  value: Response | null;
}

export interface HonoNodeResponseEnvironment {
  outgoing?: ServerResponse;
  vextStreamOwned?: boolean;
}

/**
 * 创建 ResponseBox 容器
 *
 * 由 adapter 的 registerRoute / registerNotFound 中调用，
 * 传给 createVextResponse，并在 handler 返回后读取 box.value。
 */
export function createResponseBox(): ResponseBox {
  return { value: null };
}

type DestroyableReadable = NodeJS.ReadableStream & {
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  destroy?: (error?: Error) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (
    event: string,
    listener: (...args: any[]) => void,
  ) => unknown;
  resume?: () => unknown;
};

function toWebReadable(readable: NodeJS.ReadableStream): ReadableStream {
  if (readable instanceof Readable) {
    return Readable.toWeb(readable) as unknown as ReadableStream;
  }
  const source = readable as DestroyableReadable;
  if (typeof source.on !== "function" || typeof source.once !== "function") {
    return readable as unknown as ReadableStream;
  }
  return new ReadableStream({
    start(controller) {
      let settled = false;
      const cleanup = () => {
        removeReadableListener(source, "data", onData);
        removeReadableListener(source, "end", onEnd);
        removeReadableListener(source, "close", onClose);
        removeReadableListener(source, "error", onError);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.close();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.error(error);
      };
      const onData = (chunk: unknown) => {
        if (settled) return;
        try {
          controller.enqueue(toUint8Array(chunk));
        } catch (error) {
          fail(error);
        }
      };
      const onEnd = () => finish();
      const onClose = () => finish();
      const onError = (error: unknown) => fail(error);

      source.on("data", onData);
      source.once("end", onEnd);
      source.once("close", onClose);
      source.once("error", onError);
      source.resume?.();
    },
    cancel(reason) {
      source.destroy?.(reason instanceof Error ? reason : undefined);
    },
  });
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk));
}

function removeReadableListener(
  source: DestroyableReadable,
  event: string,
  listener: (...args: any[]) => void,
): void {
  if (typeof source.off === "function") {
    source.off(event, listener);
    return;
  }
  source.removeListener?.(event, listener);
}

/**
 * HonoContext → VextResponse 转换
 *
 * Deferred terminal flush: json/rawJson/text/html/redirect stage until `_flush()`
 * so onion after-middleware can still mutate headers.
 *
 * @param c              Hono Context 对象
 * @param getRequestId   延迟获取 requestId 的 getter 函数
 * @param box            Response 捕获容器
 * @returns VextResponse 实例（含内部方法 _enableWrap）
 */
export function createVextResponse(
  c: Context,
  getRequestId: () => string,
  box: ResponseBox,
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

  /** 重复发送保护标志（P2-2：防止 handler 中多次调用 json/rawJson/text） */
  let _sent = false;

  type PendingFlush = {
    status: number;
    body?: string | null;
    /** Applied before buffered headers; `null` removes/omits default CT (204). */
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
   * 将累积的响应头设置到 Hono Context 上
   */
  function applyHeaders(): void {
    for (const [k, v] of Object.entries(_headers)) {
      if (Array.isArray(v)) {
        if (!isSetCookieHeader(k)) {
          c.header(k, v.join(", "));
          continue;
        }
        for (const value of v) {
          c.header(k, value, { append: true });
        }
        continue;
      }
      c.header(k, v);
    }
  }

  function applyNodeHeaders(target: ServerResponse): void {
    for (const [name, value] of Object.entries(_headers)) {
      target.setHeader(name, value);
    }
  }

  function nodeResponseTarget(): ServerResponse | undefined {
    return (c.env as HonoNodeResponseEnvironment | undefined)?.outgoing;
  }

  function finishNodeStreamFailure(
    target: ServerResponse,
    error: unknown,
  ): void {
    if (target.headersSent || target.writableEnded || target.destroyed) {
      target.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const body = JSON.stringify({
      code: 500,
      message:
        error instanceof Error && error.message
          ? error.message
          : "Stream response failed",
    });
    target.statusCode = 500;
    target.setHeader("Content-Type", "application/json; charset=utf-8");
    target.setHeader("Content-Length", Buffer.byteLength(body));
    target.end(body);
  }

  function queuePending(pending: PendingFlush): void {
    _pending = pending;
  }

  function flushPending(): void {
    if (_flushed || !_pending) return;
    _flushed = true;
    const pending = _pending;
    _pending = null;

    c.status(pending.status as any);

    if (pending.defaultContentType) {
      c.header("Content-Type", pending.defaultContentType);
    }

    if (
      pending.body !== undefined &&
      pending.body !== null &&
      pending.contentLengthAfterHeaders !== true
    ) {
      c.header("Content-Length", String(Buffer.byteLength(pending.body)));
    }

    applyHeaders();

    if (
      pending.body !== undefined &&
      pending.body !== null &&
      pending.contentLengthAfterHeaders === true
    ) {
      c.header("Content-Length", String(Buffer.byteLength(pending.body)));
    }

    if (pending.body === null || pending.body === undefined) {
      captureResponse(c.body(null));
    } else {
      captureResponse(c.body(pending.body));
    }
    finishResponseSend(res, pending.sendState);
  }

  /**
   * 检查是否已发送响应（重复发送保护）
   *
   * @param methodName 调用的方法名（用于警告消息）
   * @returns true 表示已发送（应终止当前方法），false 表示可以发送
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

  /**
   * 将 Hono 返回的 Response/TypedResponse 存入 box
   *
   * @param response Hono API 返回的 Response 对象
   */
  function captureResponse(response: Response): void {
    box.value = response;
  }

  const res: VextResponse & { _closeToken?: object } = {
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
            body: null,
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

      // 未包装模式（_enableWrap 未调用时的降级行为）
      if (finalStatus === 204) {
        queuePending({
          status: finalStatus,
          body: null,
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

      // Defer write so post-next setHeader can still override Content-Type etc.
      // Use c.body() at flush (not c.text()) so setHeader Content-Type is respected.
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

      const outgoing = nodeResponseTarget();
      if (outgoing) {
        outgoing.statusCode = _status;
        outgoing.setHeader("Content-Type", contentType);
        applyNodeHeaders(outgoing);
        (c.env as HonoNodeResponseEnvironment).vextStreamOwned = true;
        readable.once("error", (error) => {
          finishNodeStreamFailure(outgoing, error);
        });
        finishResponseSendAfterStreamSettlement(res, sendState, readable);
        captureResponse(c.body(null));
        readable.pipe(outgoing);
        return;
      }

      c.status(_status as any);
      c.header("Content-Type", contentType);
      // The Web-response fallback is used outside the Node server bridge.
      // Hono's own streaming response path requires explicit chunking.
      c.header("Transfer-Encoding", "chunked");
      applyHeaders();
      finishResponseSendAfterStreamSettlement(res, sendState, readable);
      captureResponse(c.body(toWebReadable(readable) as any));
    },

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

      const outgoing = nodeResponseTarget();
      if (outgoing) {
        outgoing.statusCode = _status;
        applyNodeHeaders(outgoing);
        (c.env as HonoNodeResponseEnvironment).vextStreamOwned = true;
        readable.once("error", (error) => {
          finishNodeStreamFailure(outgoing, error);
        });
        finishResponseSendAfterStreamSettlement(res, sendState, readable);
        captureResponse(c.body(null));
        readable.pipe(outgoing);
        return;
      }

      c.status(_status as any);
      applyHeaders();
      finishResponseSendAfterStreamSettlement(res, sendState, readable);
      captureResponse(c.body(toWebReadable(readable) as any));
    },

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
        queuePending({
          status: _status,
          body: null,
          sendState,
        });
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
