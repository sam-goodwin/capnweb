// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, describe } from "vitest"
import { RpcSession, type RpcSessionOptions, RpcTransport, RpcTarget,
         RpcStub, readableToStream, streamToReadable } from "../src/index.js"
import { Effect, Stream, Exit } from "effect"

// =======================================================================================
// Test infrastructure (duplicated from index.test.ts for isolation)

class TestTransport implements RpcTransport {
  constructor(public name: string, private partner?: TestTransport) {
    if (partner) {
      partner.partner = this;
    }
  }

  private queue: string[] = [];
  private waiter?: () => void;
  private aborter?: (err: any) => void;
  public log = false;

  async send(message: string): Promise<void> {
    if (this.log) console.log(`${this.name}: ${message}`);
    this.partner!.queue.push(message);
    if (this.partner!.waiter) {
      this.partner!.waiter();
      this.partner!.waiter = undefined;
      this.partner!.aborter = undefined;
    }
  }

  async receive(): Promise<string> {
    while (this.queue.length == 0) {
      await new Promise<void>((resolve, reject) => {
        this.waiter = resolve;
        this.aborter = reject;
      });
    }
    return this.queue.shift()!;
  }

  forceReceiveError(error: any) {
    this.aborter!(error);
  }
}

async function pumpMicrotasks() {
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
  }
}

class TestHarness<T extends RpcTarget> {
  clientTransport: TestTransport;
  serverTransport: TestTransport;
  client: RpcSession<T>;
  server: RpcSession;
  stub: RpcStub<T>;

  constructor(target: T, serverOptions?: RpcSessionOptions) {
    this.clientTransport = new TestTransport("client");
    this.serverTransport = new TestTransport("server", this.clientTransport);
    this.client = new RpcSession<T>(this.clientTransport);
    this.server = new RpcSession<undefined>(this.serverTransport, target, serverOptions);
    this.stub = this.client.getRemoteMain();
  }

  enableLogging() {
    this.clientTransport.log = true;
    this.serverTransport.log = true;
  }

  checkAllDisposed() {
    expect(this.client.getStats(), "client").toStrictEqual({imports: 1, exports: 1});
    expect(this.server.getStats(), "server").toStrictEqual({imports: 1, exports: 1});
  }

  async [Symbol.asyncDispose]() {
    try {
      await pumpMicrotasks();
      this.checkAllDisposed();
    } catch (err) {
      let message: string;
      if (err instanceof Error) {
        message = err.stack || err.message;
      } else {
        message = `${err}`;
      }
      expect.soft(true, message).toBe(false);
    }
  }
}

// =======================================================================================
// Server implementations that return Effect values

class EffectCounter extends RpcTarget {
  #count = 0;

  increment(amount: number = 1): number {
    this.#count += amount;
    return this.#count;
  }

  get value(): number {
    return this.#count;
  }
}

class EffectApiServer extends RpcTarget {
  // Returns an Effect that resolves to a plain value
  greet(name: string) {
    return Effect.succeed(`Hello, ${name}!`);
  }

  // Returns an Effect that resolves to a number
  square(n: number) {
    return Effect.succeed(n * n);
  }

  // Returns a failing Effect
  failWith(message: string) {
    return Effect.fail(new Error(message));
  }

  // Returns a failing Effect with a typed non-Error failure
  failTyped(code: number) {
    return Effect.fail(`error-code-${code}`);
  }

  // Returns an Effect wrapping async work
  asyncCompute(n: number) {
    return Effect.promise(() =>
      new Promise<number>(resolve => setTimeout(() => resolve(n * 2), 10))
    );
  }

  // Returns an Effect that produces an RpcTarget
  makeCounter(initial: number) {
    return Effect.succeed(new EffectCounter());
  }

  // Returns a plain value (for mixed API surfaces)
  plainValue(n: number) {
    return n + 1;
  }

  // Returns a Promise (for interop testing)
  promiseValue(n: number) {
    return Promise.resolve(n + 2);
  }

  // Returns an Effect.Stream as a value stream
  valueStream(count: number) {
    return Stream.fromIterable(Array.from({length: count}, (_, i) => i));
  }

  // Returns an Effect.Stream of typed objects
  objectStream() {
    return Stream.make(
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Charlie" }
    );
  }

  // Returns an Effect that dies (defect, not typed failure)
  defect() {
    return Effect.die(new TypeError("intentional defect"));
  }
}

// =======================================================================================
// Tests

describe("Effect over RPC", () => {
  it("can return an Effect that resolves to a string", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    let result = await harness.stub.greet("World");
    expect(result).toBe("Hello, World!");
  });

  it("can return an Effect that resolves to a number", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    let result = await harness.stub.square(5);
    expect(result).toBe(25);
  });

  it("propagates Effect failures as RPC errors", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    try {
      await harness.stub.failWith("test failure");
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("test failure");
    }
    await pumpMicrotasks();
  });

  it("propagates typed non-Error failures", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    try {
      await harness.stub.failTyped(42);
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("error-code-42");
    }
    await pumpMicrotasks();
  });

  it("propagates Effect defects", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    try {
      await harness.stub.defect();
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("intentional defect");
    }
    await pumpMicrotasks();
  });

  it("supports async Effects", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    let result = await harness.stub.asyncCompute(21);
    expect(result).toBe(42);
  });

  it("coexists with plain return values", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    let result = await harness.stub.plainValue(5);
    expect(result).toBe(6);
  });

  it("coexists with Promise return values", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    let result = await harness.stub.promiseValue(5);
    expect(result).toBe(7);
  });

  it("supports returning an RpcTarget from an Effect", async () => {
    await using harness = new TestHarness(new EffectApiServer());
    using counter = await harness.stub.makeCounter(0);
    expect(await counter.increment(5)).toBe(5);
    expect(await counter.increment(3)).toBe(8);
    expect(await counter.value).toBe(8);
  });
});

describe("Effect pipelining over RPC", () => {
  it("can pipeline through an Effect-returned RpcTarget", async () => {
    await using harness = new TestHarness(new EffectApiServer());

    // Create counter via Effect and immediately pipeline a call through it
    using counter = await harness.stub.makeCounter(0);
    let result = await counter.increment(10);
    expect(result).toBe(10);

    let result2 = await counter.increment(5);
    expect(result2).toBe(15);
  });
});

describe("Effect Stream over RPC", () => {
  it("can send a value stream and read all chunks", async () => {
    class StreamApi extends RpcTarget {
      getNumbers(count: number) {
        return Stream.fromIterable(Array.from({length: count}, (_, i) => i));
      }
    }

    await using harness = new TestHarness(new StreamApi());
    let stream: any = await harness.stub.getNumbers(5);

    let reader = stream.getReader();
    let chunks: number[] = [];
    while (true) {
      let {value, done} = await reader.read();
      if (done) break;
      chunks.push(value as number);
    }

    expect(chunks).toStrictEqual([0, 1, 2, 3, 4]);
  });

  it("can send an object stream and read all chunks", async () => {
    class StreamApi extends RpcTarget {
      getUsers() {
        return Stream.make(
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
          { id: 3, name: "Charlie" }
        );
      }
    }

    await using harness = new TestHarness(new StreamApi());
    let stream: any = await harness.stub.getUsers();

    let reader = stream.getReader();
    let chunks: any[] = [];
    while (true) {
      let {value, done} = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(chunks).toStrictEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Charlie" }
    ]);
  });
});

describe("Effect Stream helpers", () => {
  it("streamToReadable converts Effect Stream to ReadableStream", async () => {
    let stream = Stream.make("hello", "world");
    let readable = streamToReadable(stream);
    expect(readable).toBeInstanceOf(ReadableStream);

    let reader = readable.getReader();
    let {value: v1} = await reader.read();
    let {value: v2} = await reader.read();
    let {done} = await reader.read();

    expect(v1).toBe("hello");
    expect(v2).toBe("world");
    expect(done).toBe(true);
  });

  it("readableToStream converts ReadableStream to Effect Stream", async () => {
    let readable = new ReadableStream({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      }
    });

    let stream = await readableToStream(readable);
    let result = await Effect.runPromise(Stream.runCollect(stream));
    expect([...result]).toStrictEqual([1, 2, 3]);
  });
});
