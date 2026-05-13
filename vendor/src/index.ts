import createModuleFactory, {
  type SignalsmithStretchModule,
} from "../dist/emscripten/module";

export type {
  SignalsmithStretchModule,
  CBool,
} from "../dist/emscripten/module";

type CryptoLike = Pick<Crypto, "getRandomValues">;

function ensureCrypto(): void {
  const globalWithCrypto = globalThis as typeof globalThis & {
    crypto?: CryptoLike;
  };

  if (globalWithCrypto.crypto !== undefined) {
    return;
  }

  const cryptoPolyfill: CryptoLike = {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array === null) {
        return array;
      }

      const view = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
      );

      for (let i = 0; i < view.length; i += 1) {
        view[i] = Math.floor(Math.random() * 256);
      }

      return array;
    },
  };

  // Cast to full Crypto – we only implement getRandomValues,
  // which is all the Emscripten runtime needs here.
  (globalWithCrypto as typeof globalThis & { crypto: Crypto }).crypto =
    cryptoPolyfill as Crypto;
}

/**
 * Create a fresh Signalsmith stretch module instance.
 *
 * Important: do NOT cache across calls. The lane expects separate module
 * instances for A/B engines and later swaps.
 */
export async function createModule(): Promise<SignalsmithStretchModule> {
  // Make sure `crypto.getRandomValues` exists before we enter the Emscripten factory.
  ensureCrypto();

  const instanceOrPromise = createModuleFactory() as
    | SignalsmithStretchModule
    | Promise<SignalsmithStretchModule>;

  if (instanceOrPromise instanceof Promise) {
    return instanceOrPromise;
  }

  return instanceOrPromise;
}
