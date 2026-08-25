import type {
  VextResponseBeforePatch,
  VextResponseKind,
} from "../types/hooks.js";
import type { VextResponse } from "../types/response.js";
import type { VextHeaders } from "../types/headers.js";
import { isInternalHooks } from "./hooks.js";
import { cloneHeaders, mergeHeaders } from "./headers.js";
import { fireRequestCloseHandlers } from "./request-close.js";

export interface ResponseSendState {
  kind: VextResponseKind;
  data?: unknown;
  status: number;
  headers: VextHeaders;
  requestId: string;
  startedAt: number;
  hideInternalErrors: boolean;
}

type EventEmitterLike = {
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => unknown;
  destroy?: (error?: Error) => unknown;
  destroyed?: boolean;
  writableEnded?: boolean;
  headersSent?: boolean;
  statusCode?: number;
  setHeader?: (name: string, value: number | string) => unknown;
  end?: (chunk?: string) => unknown;
  readableEnded?: boolean;
};

const responseCompletions = new WeakMap<VextResponse, Promise<void>>();

export function beginResponseSend(
  res: VextResponse,
  payload: {
    kind: VextResponseKind;
    data?: unknown;
    status: number;
    headers: VextHeaders;
    wrapped: boolean;
    requestId: string;
  },
): ResponseSendState {
  const startedAt = performance.now();
  const hooks = isInternalHooks(res._hooks) ? res._hooks : undefined;
  const hasBeforeHook = hooks?.has("response:before") === true;
  const needsMutableHeaders = Boolean(res._onBeforeSend) || hasBeforeHook;
  // Response adapters already pass an owned header snapshot. A second clone is
  // needed only when an interceptor can mutate it.
  const nextHeaders = needsMutableHeaders
    ? cloneHeaders(payload.headers)
    : payload.headers;
  res._onBeforeSend?.(payload.kind, payload.data, payload.status, nextHeaders);

  const hookPayload = {
    ...payload,
    headers: nextHeaders,
  };
  const patch = (
    hasBeforeHook ? hooks!.emitSync("response:before", hookPayload) : undefined
  ) as VextResponseBeforePatch | undefined;

  if (patch?.headers) {
    mergeHeaders(nextHeaders, patch.headers);
  }

  return {
    kind: payload.kind,
    data: patch && "data" in patch ? patch.data : payload.data,
    status: patch?.status ?? payload.status,
    headers: nextHeaders,
    requestId: payload.requestId,
    startedAt,
    hideInternalErrors: res._hideInternalErrors ?? true,
  };
}

export function finishResponseSend(
  res: VextResponse,
  state: ResponseSendState,
): void {
  const hooks = isInternalHooks(res._hooks) ? res._hooks : undefined;
  if (hooks?.has("response:after")) {
    hooks.emitSafeSync("response:after", {
      kind: state.kind,
      status: state.status,
      headers: state.headers,
      requestId: state.requestId,
      durationMs: Math.round(performance.now() - state.startedAt),
    });
  }

  // Fire req.onClose exactly-once when the response has completed send.
  // Inject/testing paths may not emit host IncomingMessage 'close'.
  const closeToken = (res as VextResponse & { _closeToken?: object })
    ._closeToken;
  if (closeToken) {
    fireRequestCloseHandlers(closeToken);
  }
}

export function finishResponseSendAfterStreamSettlement(
  res: VextResponse,
  state: ResponseSendState,
  readable: NodeJS.ReadableStream,
  target?: EventEmitterLike,
): void {
  const completion = waitForStreamSettlement(readable, state, target).then(
    () => {
      finishResponseSend(res, state);
    },
  );
  responseCompletions.set(res, completion);
  void completion;
}

export async function waitForResponseSend(res: VextResponse): Promise<void> {
  await responseCompletions.get(res);
}

function waitForStreamSettlement(
  readable: NodeJS.ReadableStream,
  state: ResponseSendState,
  target?: EventEmitterLike,
): Promise<void> {
  const source = readable as EventEmitterLike;
  const observedTarget = target && hasOnce(target) ? target : undefined;
  const observedSource = hasOnce(source) ? source : undefined;

  return new Promise((resolve) => {
    if (!observedTarget && !observedSource) {
      queueMicrotask(resolve);
      return;
    }

    let responseSettled = false;
    let sourceSettled = !observedSource;
    type ListenerRegistration = {
      emitter: EventEmitterLike;
      event: string;
      listener: (...args: unknown[]) => void;
    };
    const targetListeners: ListenerRegistration[] = [];
    const sourceListeners: ListenerRegistration[] = [];

    const cleanup = (listeners: ListenerRegistration[]) => {
      for (const item of listeners) {
        removeListener(item.emitter, item.event, item.listener);
      }
      listeners.length = 0;
    };

    const settleResponse = () => {
      if (responseSettled) return;
      responseSettled = true;
      cleanup(targetListeners);
      if (sourceSettled) cleanup(sourceListeners);
      resolve();
    };

    const settleSource = () => {
      if (sourceSettled) return;
      sourceSettled = true;
      cleanup(sourceListeners);
      if (!observedTarget) settleResponse();
    };

    const failSource = (error?: unknown) => {
      // The source error is already observed here. Closing the response target
      // with the same Error can re-emit it through an underlying socket.
      if (!responseSettled) {
        if (!writeStreamFailureResponse(observedTarget, state, error)) {
          destroyTarget(observedTarget);
        }
      }
      settleSource();
      settleResponse();
    };

    const stopSource = () => {
      if (!observedSource || sourceSettled) return;
      if (observedSource.readableEnded || observedSource.destroyed) {
        settleSource();
        return;
      }
      try {
        observedSource.destroy?.();
      } catch {
        settleSource();
      }
    };

    const settleTarget = () => {
      stopSource();
      settleResponse();
    };

    const failTarget = () => {
      stopSource();
      destroyTarget(observedTarget);
      settleResponse();
    };

    const on = (
      listeners: ListenerRegistration[],
      emitter: EventEmitterLike,
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      emitter.once?.(event, listener);
      listeners.push({ emitter, event, listener });
    };

    if (observedTarget) {
      on(targetListeners, observedTarget, "finish", settleTarget);
      on(targetListeners, observedTarget, "close", settleTarget);
      on(targetListeners, observedTarget, "error", failTarget);
      if (observedTarget.writableEnded || observedTarget.destroyed) {
        queueMicrotask(settleTarget);
      }
    }

    if (observedSource) {
      on(sourceListeners, observedSource, "end", settleSource);
      on(sourceListeners, observedSource, "close", settleSource);
      on(sourceListeners, observedSource, "error", failSource);
      if (observedSource.readableEnded || observedSource.destroyed) {
        queueMicrotask(settleSource);
      }
    }
  });
}

function hasOnce(value: EventEmitterLike): boolean {
  return typeof value.once === "function";
}

function removeListener(
  emitter: EventEmitterLike,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof emitter.off === "function") {
    emitter.off(event, listener);
    return;
  }
  emitter.removeListener?.(event, listener);
}

function destroyTarget(target: EventEmitterLike | undefined) {
  if (!target || typeof target.destroy !== "function") return;
  if (target.destroyed || target.writableEnded) return;
  target.destroy();
}

function writeStreamFailureResponse(
  target: EventEmitterLike | undefined,
  state: ResponseSendState,
  error: unknown,
): boolean {
  if (!target || typeof target.end !== "function") return false;
  if (target.headersSent || target.writableEnded || target.destroyed) {
    return false;
  }
  const body = createStreamFailureBody(error, {
    requestId: state.requestId,
    hideInternalErrors: state.hideInternalErrors,
  });
  target.statusCode = 500;
  target.setHeader?.("Content-Type", "application/json; charset=utf-8");
  target.setHeader?.("Content-Length", Buffer.byteLength(body));
  target.end(body);
  return true;
}

export function createStreamFailureBody(
  error: unknown,
  options: { requestId?: string; hideInternalErrors?: boolean } = {},
): string {
  const message =
    (options.hideInternalErrors ?? true)
      ? "Internal Server Error"
      : error instanceof Error && error.message
        ? error.message
        : "Stream response failed";
  return JSON.stringify({
    code: 500,
    message,
    ...(options.requestId ? { requestId: options.requestId } : {}),
  });
}
