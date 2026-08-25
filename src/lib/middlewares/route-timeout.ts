import type { VextMiddleware } from "../../types/middleware.js";

export function createRouteTimeoutMiddleware(
  timeoutMs: number,
): VextMiddleware {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error(
      "[vextjs] RouteOptions.timeout must be a positive integer in milliseconds",
    );
  }

  return async (req, res, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const previousOnBeforeSend = res._onBeforeSend;
    const timeoutController = new AbortController();
    req.signal = AbortSignal.any(
      req.signal
        ? [req.signal, timeoutController.signal]
        : [timeoutController.signal],
    );

    const clearTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    res._onBeforeSend = (kind, data, statusCode, headers) => {
      clearTimer();
      previousOnBeforeSend?.(kind, data, statusCode, headers);
    };

    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timer = undefined;
        timedOut = true;
        timeoutController.abort(
          new Error(`[vextjs] Route timed out after ${timeoutMs}ms`),
        );
        if (!res._isSent()) {
          try {
            res.rawJson(
              {
                code: 504,
                message: "Request Timeout",
                requestId: req.requestId,
              },
              504,
            );
          } catch (error) {
            req.app.logger.error(
              { error: error instanceof Error ? error.message : String(error) },
              "[vextjs] failed to send route timeout response",
            );
          }
        }
        resolve("timeout");
      }, timeoutMs);
    });

    const downstream = Promise.resolve()
      .then(next)
      .then(
        () => "completed" as const,
        (error: unknown) => {
          if (!timedOut) {
            throw error;
          }
          req.app.logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            "[vextjs] route handler rejected after its timeout",
          );
          return "late-error" as const;
        },
      );

    try {
      await Promise.race([downstream, deadline]);
    } finally {
      if (!timedOut) {
        clearTimer();
      }
    }
  };
}
