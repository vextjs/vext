import { createServer, get, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createHonoAdapter } from "../../../src/adapters/hono/adapter.js";
import { getHandlerDone } from "../../../src/lib/handler-completion.js";
import { createHookManager } from "../../../src/lib/hooks.js";
import type { VextAdapter } from "../../../src/types/adapter.js";
import type { VextApp } from "../../../src/types/app.js";
import type { VextMiddleware } from "../../../src/types/middleware.js";

interface DispatchResult {
  status: number;
  headers: Record<string, string | string[]>;
  text: string;
}

interface StreamSettlementResult {
  backpressureViolated?: boolean;
  error?: unknown;
  settlement: "destroyed" | "ended";
  text: string;
}

interface StreamSettlementOptions {
  closeAfterFirstWrite?: boolean;
  forceBackpressureOnFirstWrite?: boolean;
}

function createAdapter(hideInternalErrors = true): VextAdapter {
  return createHonoAdapter({
    config: {
      requestContext: { enabled: false },
      requestId: { header: "x-request-id" },
      trustProxy: false,
      response: { hideInternalErrors },
    },
    hooks: createHookManager(),
  } as unknown as VextApp);
}

function registerGet(
  adapter: VextAdapter,
  path: string,
  handler: VextMiddleware,
) {
  adapter.registerRoute("GET", path, [handler]);
}

function dispatch(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  path: string,
): Promise<DispatchResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`dispatch timed out for GET ${path}`)),
      10_000,
    );
    const chunks: Buffer[] = [];
    const requestSocket = new Socket();
    const request = Object.assign(Readable.from(Buffer.alloc(0)), {
      method: "GET",
      url: path,
      headers: { host: "localhost" },
      rawHeaders: ["host", "localhost"],
      socket: requestSocket,
      connection: requestSocket,
      complete: true,
      aborted: false,
      trailers: {},
      rawTrailers: [],
    }) as IncomingMessage;
    const response = new ServerResponse(request);
    const responseSocket = new PassThrough() as unknown as Socket;
    responseSocket.resume();
    response.assignSocket(responseSocket);

    const cleanup = () => {
      clearTimeout(timeout);
      requestSocket.destroy();
      responseSocket.destroy();
    };
    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    (response as any).write = (chunk: unknown, ...args: any[]) => {
      if (chunk !== undefined && chunk !== null)
        chunks.push(Buffer.from(chunk as any));
      return originalWrite(chunk as any, ...args);
    };
    (response as any).end = (chunk?: unknown, ...args: any[]) => {
      if (chunk !== undefined && chunk !== null)
        chunks.push(Buffer.from(chunk as any));
      const result = originalEnd(chunk as any, ...args);
      queueMicrotask(() => {
        void (async () => {
          await getHandlerDone(response);
          const headers = Object.fromEntries(
            response
              .getHeaderNames()
              .map((name) => [
                name,
                response.getHeader(name) as string | string[],
              ]),
          );
          cleanup();
          resolve({
            status: response.statusCode,
            headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        })().catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      });
      return result;
    };

    try {
      handler(request, response);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function dispatchStreamSettlement(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  path: string,
  options: StreamSettlementOptions = {},
): Promise<StreamSettlementResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`stream settlement timed out for GET ${path}`)),
      10_000,
    );
    const chunks: Buffer[] = [];
    const requestSocket = new Socket();
    const request = Object.assign(Readable.from(Buffer.alloc(0)), {
      method: "GET",
      url: path,
      headers: { host: "localhost" },
      rawHeaders: ["host", "localhost"],
      socket: requestSocket,
      connection: requestSocket,
      complete: true,
      aborted: false,
      trailers: {},
      rawTrailers: [],
    }) as IncomingMessage;
    const response = new ServerResponse(request);
    const responseSocket = new PassThrough() as unknown as Socket;
    responseSocket.resume();
    response.assignSocket(responseSocket);

    let settled = false;
    let writeCount = 0;
    let drainObserved = !options.forceBackpressureOnFirstWrite;
    let backpressureViolated = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (
      settlement: StreamSettlementResult["settlement"],
      error?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      requestSocket.destroy();
      responseSocket.destroy();
      resolve({
        backpressureViolated,
        error,
        settlement,
        text: Buffer.concat(chunks).toString("utf8"),
      });
    };

    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    const originalDestroy = response.destroy.bind(response);
    (response as any).write = (chunk: unknown, ...args: any[]) => {
      writeCount += 1;
      if (writeCount > 1 && !drainObserved) backpressureViolated = true;
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.from(chunk as any));
      }
      const result = originalWrite(chunk as any, ...args);
      if (writeCount === 1 && options.closeAfterFirstWrite) {
        queueMicrotask(() => response.destroy());
      }
      if (writeCount === 1 && options.forceBackpressureOnFirstWrite) {
        response.once("drain", () => {
          drainObserved = true;
        });
        drainTimer = setTimeout(() => response.emit("drain"), 10);
        return false;
      }
      return result;
    };
    (response as any).end = (chunk?: unknown, ...args: any[]) => {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.from(chunk as any));
      }
      const result = originalEnd(chunk as any, ...args);
      settle("ended");
      return result;
    };
    (response as any).destroy = (error?: Error) => {
      const result = originalDestroy();
      settle("destroyed", error);
      return result;
    };

    try {
      handler(request, response);
    } catch (error) {
      clearTimeout(timeout);
      requestSocket.destroy();
      responseSocket.destroy();
      reject(error);
    }
  });
}

async function measureHttpStream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  path: string,
): Promise<{ firstByteMs: number; completedMs: number; text: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    return await new Promise((resolve, reject) => {
      const startedAt = performance.now();
      let firstByteAt: number | undefined;
      const chunks: Buffer[] = [];
      const request = get(`http://127.0.0.1:${port}${path}`, (response) => {
        response.on("data", (chunk) => {
          firstByteAt ??= performance.now();
          chunks.push(Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => {
          if (firstByteAt === undefined) {
            reject(new Error("stream response did not emit a body chunk"));
            return;
          }
          resolve({
            firstByteMs: firstByteAt - startedAt,
            completedMs: performance.now() - startedAt,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      request.once("error", reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("Hono adapter stream responses", () => {
  it("writes Node readable streams through the Web Response bridge", async () => {
    const adapter = createAdapter();
    registerGet(adapter, "/stream", async (req, res) => {
      req.requestId = "req-1";
      res
        .status(206)
        .setHeader("x-stream", "yes")
        .stream(Readable.from(["hello", "-hono"]), "text/plain");
    });

    const response = await dispatch(adapter.buildHandler(), "/stream");

    expect(response.status).toBe(206);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.headers["x-stream"]).toBe("yes");
    expect(response.text).toBe("hello-hono");
  });

  it("emits the first HTTP body chunk before a delayed stream boundary", async () => {
    const adapter = createAdapter();
    registerGet(adapter, "/stream-timing", async (req, res) => {
      req.requestId = "req-1";
      const stream = new PassThrough();
      stream.write("shell");
      res.stream(stream, "text/plain");
      setTimeout(() => stream.end("-complete"), 120).unref();
    });

    const response = await measureHttpStream(
      adapter.buildHandler(),
      "/stream-timing",
    );

    expect(response.text).toBe("shell-complete");
    expect(response.completedMs - response.firstByteMs).toBeGreaterThanOrEqual(
      60,
    );
  });

  it("pipes slow downloads through the Node response bridge", async () => {
    const adapter = createAdapter();
    registerGet(adapter, "/download-timing", async (req, res) => {
      req.requestId = "req-1";
      async function* chunks() {
        yield "download";
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        yield "-complete";
      }
      res.download(Readable.from(chunks()), "report.txt", "text/plain");
    });

    const response = await measureHttpStream(
      adapter.buildHandler(),
      "/download-timing",
    );

    expect(response.text).toBe("download-complete");
    expect(response.completedMs - response.firstByteMs).toBeGreaterThanOrEqual(
      60,
    );
  });

  it("settles Node readable errors without hanging the Hono bridge", async () => {
    const adapter = createAdapter();
    registerGet(adapter, "/stream-error", async (req, res) => {
      req.requestId = "req-1";
      res.stream(
        new Readable({
          read() {
            this.destroy(new Error("stream failed"));
          },
        }),
        "text/plain",
      );
    });

    const response = await dispatch(adapter.buildHandler(), "/stream-error");

    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(JSON.parse(response.text)).toEqual({
      code: 500,
      message: "Internal Server Error",
    });
  });

  it("exposes Node readable error details only when hideInternalErrors is false", async () => {
    const adapter = createAdapter(false);
    registerGet(adapter, "/stream-error-exposed", async (req, res) => {
      req.requestId = "req-1";
      res.stream(
        new Readable({
          read() {
            this.destroy(new Error("stream failed"));
          },
        }),
        "text/plain",
      );
    });

    const response = await dispatch(
      adapter.buildHandler(),
      "/stream-error-exposed",
    );

    expect(response.status).toBe(500);
    expect(JSON.parse(response.text)).toEqual({
      code: 500,
      message: "stream failed",
    });
  });

  it("destroys the connection when a Web Response body fails after bytes were sent", async () => {
    const bodyDescriptor = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "body",
    );
    if (!bodyDescriptor?.get) {
      throw new Error("Response.prototype.body getter is unavailable");
    }

    const streamError = new Error("stream failed after first chunk");
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        setTimeout(() => controller.error(streamError), 5);
      },
    });
    Object.defineProperty(Response.prototype, "body", {
      ...bodyDescriptor,
      get(this: Response) {
        if (this.headers.get("x-vext-test-stream-error") === "1") {
          return failingBody;
        }
        return bodyDescriptor.get!.call(this);
      },
    });

    try {
      const adapter = createAdapter();
      registerGet(adapter, "/web-stream-partial-error", async (req, res) => {
        req.requestId = "req-1";
        res.setHeader("x-vext-test-stream-error", "1").text("complete-body");
      });

      const response = await dispatchStreamSettlement(
        adapter.buildHandler(),
        "/web-stream-partial-error",
      );

      expect(response.text).toBe("partial");
      expect(response.settlement).toBe("destroyed");
      expect(response.error).toBeUndefined();
    } finally {
      Object.defineProperty(Response.prototype, "body", bodyDescriptor);
    }
  });

  it("honors Node response backpressure while bridging a Web Response body", async () => {
    const bodyDescriptor = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "body",
    );
    if (!bodyDescriptor?.get) {
      throw new Error("Response.prototype.body getter is unavailable");
    }
    const streamingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      },
    });
    Object.defineProperty(Response.prototype, "body", {
      ...bodyDescriptor,
      get(this: Response) {
        if (this.headers.get("x-vext-test-backpressure") === "1") {
          return streamingBody;
        }
        return bodyDescriptor.get!.call(this);
      },
    });

    try {
      const adapter = createAdapter();
      registerGet(adapter, "/web-stream-backpressure", async (req, res) => {
        req.requestId = "req-1";
        res.setHeader("x-vext-test-backpressure", "1").text("unused");
      });

      const response = await dispatchStreamSettlement(
        adapter.buildHandler(),
        "/web-stream-backpressure",
        { forceBackpressureOnFirstWrite: true },
      );

      expect(response.settlement).toBe("ended");
      expect(response.text).toBe("firstsecond");
      expect(response.backpressureViolated).toBe(false);
    } finally {
      Object.defineProperty(Response.prototype, "body", bodyDescriptor);
    }
  });

  it("cancels a Web Response body when the downstream connection closes", async () => {
    const bodyDescriptor = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "body",
    );
    if (!bodyDescriptor?.get) {
      throw new Error("Response.prototype.body getter is unavailable");
    }
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const streamingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel,
    });
    Object.defineProperty(Response.prototype, "body", {
      ...bodyDescriptor,
      get(this: Response) {
        if (this.headers.get("x-vext-test-downstream-close") === "1") {
          return streamingBody;
        }
        return bodyDescriptor.get!.call(this);
      },
    });

    try {
      const adapter = createAdapter();
      registerGet(adapter, "/web-stream-downstream-close", async (req, res) => {
        req.requestId = "req-1";
        res.setHeader("x-vext-test-downstream-close", "1").text("unused");
      });

      const response = await dispatchStreamSettlement(
        adapter.buildHandler(),
        "/web-stream-downstream-close",
        { closeAfterFirstWrite: true },
      );

      expect(response.settlement).toBe("destroyed");
      expect(response.text).toBe("partial");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally {
      streamController.error(new Error("test cleanup"));
      Object.defineProperty(Response.prototype, "body", bodyDescriptor);
    }
  });
});
