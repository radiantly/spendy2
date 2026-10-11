/**
 * A minimal typed request/response protocol over postMessage. The worker
 * `expose`s an object of async methods, the main thread `connect`s to get a
 * proxy with the same signatures.
 *
 * Errors don't survive structured cloning with their custom fields, so they
 * are sent as `{ name, message, code }` and rejected as a `RemoteError`.
 */

// oxlint-disable-next-line typescript/no-explicit-any -- any method signature
type Api = Record<string, (...args: any[]) => unknown>;

export type Remote<T extends Api> = {
  [K in keyof T]: (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>>;
};

export type Connection<T extends Api> = {
  remote: Remote<T>;
  /** Rejects calls still waiting for a reply, and every later call, with a ClosedError. */
  close(): void;
};

type Request = { id: number; method: string; args: unknown[] };
type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedError };
type SerializedError = { name: string; message: string; code?: string };

/**
 * The parts of a worker's global scope that `expose` uses. The app's
 * tsconfig only has the DOM lib, where `self` is typed as a Window.
 */
export type WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

export class RemoteError extends Error {
  readonly code?: string;

  constructor({ name, message, code }: SerializedError) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

/**
 * A call rejected because this side closed the connection. Not a failure of
 * the call itself: whoever closed it no longer wants the answer.
 */
export class ClosedError extends Error {
  constructor() {
    super("The connection is closed");
    this.name = "ClosedError";
  }
}

const toTransfer = new WeakSet<Uint8Array>();

/**
 * Marks a byte array to be moved to the other side instead of copied, for
 * large values the sender hands off. The sender's array is left empty.
 * Only applies to arguments and results themselves, not to nested values.
 */
export function transfer<T extends Uint8Array<ArrayBuffer>>(bytes: T): T {
  toTransfer.add(bytes);
  return bytes;
}

function transferablesOf(values: unknown[]): Transferable[] {
  return values.flatMap((value) =>
    value instanceof Uint8Array && toTransfer.has(value) ? [value.buffer] : [],
  );
}

/** Runs in the worker: answers requests by calling `api`. */
export function expose(api: Api, scope: WorkerScope) {
  scope.addEventListener("message", async (event) => {
    const { id, method, args } = event.data as Request;
    let response: Response;
    try {
      const fn = api[method];
      if (fn === undefined) throw new Error(`Unknown method ${method}`);
      response = { id, ok: true, value: await fn(...args) };
    } catch (error) {
      response = { id, ok: false, error: serializeError(error) };
    }

    try {
      scope.postMessage(response, transferablesOf(response.ok ? [response.value] : []));
    } catch (error) {
      // The result can't be cloned; the error itself always can.
      scope.postMessage({ id, ok: false, error: serializeError(error) } satisfies Response, []);
    }
  });
}

/** Runs on the main thread: returns a proxy that forwards calls to `worker`. */
export function connect<T extends Api>(worker: Worker): Connection<T> {
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  /** Set once no reply can arrive any more; later calls reject with it. */
  let closedWith: Error | undefined;

  function rejectPending(error: Error) {
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  }

  function closeWith(error: Error) {
    closedWith ??= error;
    rejectPending(error);
  }

  worker.addEventListener("message", (event: MessageEvent<Response>) => {
    const response = event.data;
    const call = pending.get(response.id);
    if (call === undefined) return;
    pending.delete(response.id);
    if (response.ok) call.resolve(response.value);
    else call.reject(new RemoteError(response.error));
  });

  // A reply was lost, and there's no telling whose. The worker itself still
  // works, so only the calls waiting now are rejected.
  worker.addEventListener("messageerror", () => {
    rejectPending(
      new RemoteError({ name: "MessageError", message: "A reply from the worker was unreadable" }),
    );
  });

  // The worker failed to load or threw at the top level; it won't answer.
  worker.addEventListener("error", (event) => {
    closeWith(
      new RemoteError({
        name: "WorkerError",
        message: event.message || "The database worker failed",
      }),
    );
  });

  const remote = new Proxy({} as Remote<T>, {
    get(_, method) {
      // Not a promise: `await remote` must not become a call named "then".
      if (typeof method !== "string" || method === "then") return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          if (closedWith !== undefined) return reject(closedWith);
          const id = nextId++;
          pending.set(id, { resolve, reject });
          try {
            worker.postMessage({ id, method, args } satisfies Request, transferablesOf(args));
          } catch (error) {
            pending.delete(id);
            reject(error);
          }
        });
    },
  });

  return {
    remote,
    close: () => closeWith(new ClosedError()),
  };
}

function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name, message: error.message, code };
}
