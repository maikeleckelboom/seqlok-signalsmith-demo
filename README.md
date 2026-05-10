# seqlok-signalsmith-stretch

A minimal, deterministic, glitch-free demo lane that runs **Signalsmith Stretch** inside an `AudioWorkletProcessor`,
using a Seqlok-style hot-swap protocol:

**spawn → prime → preWarm → crossFade → retire**

Transport, seek, and time-stretch are owned by the worklet runtime via a
**SAB-backed planar PCM asset**. The main thread only decodes files, builds the
asset, and dispatches commands (`play`, `pause`, `seekToFrame`). The worklet
computes fixed-output / variable-input frame economics, maintains the single
source frame cursor, and performs explicit pre-roll before steady-state
rendering.

For fixed-length source assets, the runtime implements a deterministic
end-of-input lifecycle:

1. **EOF detection** — once the source cursor reaches the asset length, the
   runtime does not cut off abruptly.
2. **Input-latency drain** — the active engine(s) continue receiving
   silence-backed input for their `inputLatency()` window, allowing analysis
   windows to empty naturally.
3. **Output tail flush** — after drain completes, `_flush(outputSamples)` is
   called explicitly through the engine adapter to synthesize the remaining
   output latency tail.
4. **Deterministic idle transition** — when flush is exhausted, the runtime
   returns to `idle` cleanly, preserving timeline sanity and hotswap invariants.

This lifecycle is respected even during active hotswap crossfades: both engines
receive identical silence input during drain and both are flushed, so the
fade-out tail remains continuous.

This repo is meant to be "show, don't tell" for:
- RT-safe hotswapping (reject-while-busy, no overlapping swaps)
- segment-correct rendering (respecting offsets inside an audio block)
- canonical input segments (both engines see identical samples during prewarm/crossfade)
- per-sample crossfade ramps derived from fade geometry (not UI progress)
- worklet-owned transport with explicit seek/start pre-roll lifecycle
- a path toward a Debug Lab UI with "time travel" via SAB telemetry snapshots

---

## What this demo proves

When the invariants are respected, you can swap structural DSP configurations during playback without:
- clicks at boundaries
- metallic combing during fades
- zipper noise
- random crackles from GC / message spam

---

## Repository layout

```
src/                    — Vue app, worklet, lane runtime, DSP wrappers, transport substrate
vendor/                 — Vendored Signalsmith C++ headers and WASM bridge
  src/                  —   Emscripten bindings (main.cpp, module.d.ts)
  dist/emscripten/      —   Generated WASM module (or dev shim)
  signalsmith-stretch/  —   Vendored stretch library headers
  signalsmith-linear/   —   Vendored linear algebra library headers
packages/               — Frozen local Seqlok workspace packages
  base/                 —   @seqlok/base: error algebra, invariants
  primitives/           —   @seqlok/primitives: SWSR rings, atomics, planes
  core/                 —   @seqlok/core: spec definitions, bindings, handoff
  commands/             —   @seqlok/commands: typed command transport
  hotswap/              —   @seqlok/hotswap: engine lifecycle and swap protocol
  integration/          —   @seqlok/integration: lane runtime, timeline, slot driver
scripts/                — Build and vendor tooling
```

---

## Prerequisites

- **Node.js** >= 22.12.0 (see `.node-version`)
- **pnpm** >= 9 (the `packageManager` field in `package.json` takes effect with Corepack)
- **em++** (Emscripten) — required for a real audio build

---

## Setup

### Real demo path

This repo's actual audio demo requires a real Emscripten build.

```bash
pnpm install
pnpm run vendor
pnpm run build:wasm
pnpm run dev
```

### Shim smoke path

This is only for bundle/typecheck smoke work. It is not the real DSP runtime.

```bash
pnpm install
pnpm run vendor
pnpm run build:shim
```

---

## Scripts

| Script | Purpose |
|---|---|---|
| `pnpm run dev` | Compile WASM module, then start Vite dev server |
| `pnpm run build` | Compile WASM module, typecheck, and bundle |
| `pnpm run vendor` | Download vendored Signalsmith C++ headers |
| `pnpm run build:wasm` | Compile WASM module via em++ (requires Emscripten) |
| `pnpm run dev:shim` | Shim-only smoke build, then dev server |
| `pnpm run build:shim` | Shim-only smoke build, typecheck, and bundle |
| `pnpm run build:all` | vendor + build |
| `pnpm run preview` | Preview production build |

---

## What's in `packages/`

The six `@seqlok/*` packages under `packages/` are **frozen snapshots** of the
Seqlok library at commit `db14ee0`. Each contains a `UPSTREAM.md` with provenance
metadata. These packages exist so the demo is self-contained and does not require
access to the private Seqlok repository or any global pnpm links. They will
eventually be replaced by published versions of `@seqlok/*` from npm.

---

## License / third-party

See `THIRD_PARTY_NOTICES.md` and `third_party/licenses/*` for Signalsmith licensing.
The Seqlok packages under `packages/` are MIT-licensed (see individual `UPSTREAM.md`).
