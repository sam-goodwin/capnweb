import { RpcPromise, RpcStub, RpcTarget, type RpcCompatible } from "../src/index.js"
import { Effect } from "effect/Effect"
import { Stream } from "effect/Stream"
import { expectAssignable, expectType, type Equal, type Expect } from "./helpers.js"

// ===========================================================================
// Server-side interface declarations using Effect types

class EffectCounter extends RpcTarget {
  increment(by: number): number {
    return by
  }

  get value(): number {
    return 0
  }
}

interface EffectApi {
  // Returns a plain value (baseline)
  ping(): number

  // Returns an Effect that resolves to a primitive
  greet(name: string): Effect<string>

  // Returns an Effect that resolves to a number
  square(n: number): Effect<number>

  // Returns an Effect wrapping an RpcTarget
  getCounter(): Effect<EffectCounter>

  // Returns a Promise for comparison
  asyncPing(): Promise<number>

  // Returns an Effect with a typed error
  riskyOp(input: string): Effect<string, Error>

  // Returns an Effect Stream, which should become ReadableStream
  getNumbers(count: number): Stream<number>

  // Returns an Effect Stream of objects
  getUsers(): Stream<{ id: number; name: string }>
}

declare const api: RpcStub<EffectApi>

// ===========================================================================
// Effect-returning methods produce pipelineable results

const greetResult = api.greet("World")
const squareResult = api.square(5)
const counterResult = api.getCounter()
const pingResult = api.ping()
const asyncPingResult = api.asyncPing()
const riskyResult = api.riskyOp("test")

// All results should be assignable to Promise of their resolved type
expectAssignable<Promise<string>>(greetResult)
expectAssignable<Promise<number>>(squareResult)
expectAssignable<Promise<RpcStub<EffectCounter>>>(counterResult)
expectAssignable<Promise<number>>(pingResult)
expectAssignable<Promise<number>>(asyncPingResult)
expectAssignable<Promise<string>>(riskyResult)

// Effect results should be RpcPromise (pipelineable), just like Promise results
expectType<RpcPromise<string>>(greetResult)
expectType<RpcPromise<number>>(squareResult)
expectType<RpcPromise<EffectCounter>>(counterResult)
expectType<RpcPromise<number>>(pingResult)
expectType<RpcPromise<number>>(asyncPingResult)
expectType<RpcPromise<string>>(riskyResult)

// Pipelining through Effect-returned RpcTarget should work
const incrementResult = counterResult.increment(5)
const valueResult = counterResult.value
expectAssignable<Promise<number>>(incrementResult)
expectAssignable<Promise<number>>(valueResult)

// Can access stub lifecycle methods on Effect-returned values
greetResult.onRpcBroken((_error) => {})
counterResult.onRpcBroken((_error) => {})

// ===========================================================================
// Stream-returning methods produce pipelineable results that resolve to ReadableStream

const numbersResult = api.getNumbers(5)
const usersResult = api.getUsers()

// ===========================================================================
// Awaited shapes are correct

async function assertEffectAwaitedShapes() {
  const greeting = await greetResult
  const squared = await squareResult
  const counter = await counterResult
  const pong = await pingResult

  expectType<string>(greeting)
  expectType<number>(squared)
  expectType<RpcStub<EffectCounter>>(counter)
  expectType<number>(pong)
}

void assertEffectAwaitedShapes

// ===========================================================================
// RpcCompatible accepts Effect and Stream types

type _EffectCompatible = [
  Expect<Effect<string> extends RpcCompatible<Effect<string>> ? true : false>,
  Expect<Effect<number, Error> extends RpcCompatible<Effect<number, Error>> ? true : false>,
  Expect<Stream<number> extends RpcCompatible<Stream<number>> ? true : false>,
  Expect<Stream<string, Error> extends RpcCompatible<Stream<string, Error>> ? true : false>,
]

// ===========================================================================
// Mixed interfaces work: Effect + Promise + plain returns

interface MixedApi {
  effectMethod(): Effect<string>
  promiseMethod(): Promise<string>
  syncMethod(): string
  streamMethod(): Stream<number>
}

declare const mixed: RpcStub<MixedApi>

const effectCall = mixed.effectMethod()
const promiseCall = mixed.promiseMethod()
const syncCall = mixed.syncMethod()
const streamCall = mixed.streamMethod()

expectType<RpcPromise<string>>(effectCall)
expectType<RpcPromise<string>>(promiseCall)
expectType<RpcPromise<string>>(syncCall)

// Stream methods produce a pipelineable result. At the type level the awaited
// value is a ReadableStream whose methods have been stubified (Provider).
// This mirrors how Cap'n Web handles ReadableStream<Uint8Array> today.
void streamCall
