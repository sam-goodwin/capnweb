// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { Stream } from "effect/Stream";

/**
 * Converts a ReadableStream received from Cap'n Web into an Effect Stream.
 * Requires the `effect` package to be installed.
 */
export async function readableToStream<A>(
  readable: ReadableStream<A>
): Promise<Stream<A, Error, never>> {
  let mod: typeof import("effect");
  try {
    mod = await import("effect");
  } catch {
    throw new Error(
      "readableToStream requires the 'effect' package to be installed. " +
      "Install it with: npm install effect"
    );
  }
  return mod.Stream.fromReadableStream({
    evaluate: () => readable,
    onError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  });
}
