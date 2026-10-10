import { afterEach, describe, expect, it } from "vitest";
import { connect, expose, RemoteError, transfer, type WorkerScope } from "./rpc.ts";

/**
 * The two ends of a MessageChannel stand in for the worker and its scope, so
 * the protocol can be tested without a real worker.
 */
const channels: MessageChannel[] = [];
afterEach(() => {
  for (const { port1, port2 } of channels.splice(0)) {
    port1.close();
    port2.close();
  }
});

const api = {
  async echo<T>(value: T) {
    return value;
  },
  async never() {
    return new Promise<never>(() => {});
  },
  async unsendable() {
    return () => {};
  },
  async bytes() {
    return new Uint8Array([1, 2, 3]);
  },
};

/** For calling a method the API doesn't have. */
type Untyped = Record<string, () => Promise<unknown>>;

function setup() {
  const channel = new MessageChannel();
  channels.push(channel);
  expose(api, channel.port2 as unknown as WorkerScope);
  channel.port2.start();
  const { remote, close } = connect<typeof api>(channel.port1 as unknown as Worker);
  channel.port1.start();
  return { port: channel.port1, remote, close };
}

/** Settles with "pending" if the promise hasn't settled after a while. */
function settled(promise: Promise<unknown>, ms = 200) {
  return Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

describe("rpc", () => {
  it("returns the method's result", async () => {
    const { remote } = setup();

    expect(await remote.echo({ a: 1 })).toEqual({ a: 1 });
  });

  it("rejects with the method's error", async () => {
    const { remote } = setup();

    await expect((remote as unknown as Untyped).missing!()).rejects.toThrow(
      "Unknown method missing",
    );
  });

  it("rejects a result that can't be sent instead of never answering", async () => {
    const { remote } = setup();

    expect(await settled(remote.unsendable())).toBe("rejected");
  });

  it("rejects in-flight calls when the worker fails", async () => {
    const { port, remote } = setup();
    const call = remote.never();

    port.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    await expect(call).rejects.toThrow("boom");
  });

  it("rejects calls made after the worker failed", async () => {
    const { port, remote } = setup();
    port.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(await settled(remote.echo(1))).toBe("rejected");
  });

  it("rejects in-flight calls when a reply can't be deserialized", async () => {
    const { port, remote } = setup();
    const call = remote.never();

    port.dispatchEvent(new MessageEvent("messageerror"));

    expect(await settled(call)).toBe("rejected");
  });

  it("leaves the caller's byte arrays intact", async () => {
    const { remote } = setup();
    const bytes = new Uint8Array([1, 2, 3]);

    await remote.echo(bytes);

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("moves byte arrays marked for transfer", async () => {
    const { remote } = setup();
    const bytes = transfer(new Uint8Array([1, 2, 3]));

    expect(await remote.echo(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytes.byteLength).toBe(0);
  });

  it("rejects in-flight calls when closed", async () => {
    const { remote, close } = setup();
    const call = remote.never();

    close();

    await expect(call).rejects.toThrow("The connection is closed");
  });

  it("rejects calls made after it was closed", async () => {
    const { remote, close } = setup();

    close();

    await expect(remote.echo(1)).rejects.toThrow("The connection is closed");
  });

  it("rejects an argument that can't be sent", async () => {
    const { remote } = setup();

    await expect(remote.echo(() => {})).rejects.toThrow();
  });

  it("can be awaited without calling the worker", async () => {
    const { remote } = setup();

    expect(await settled(Promise.resolve(remote))).toBe("resolved");
  });

  it("rebuilds errors as RemoteError with their name", async () => {
    const { remote } = setup();

    const error = await (remote as unknown as Untyped).missing!().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).name).toBe("Error");
  });
});
