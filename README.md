# seqlok-signalsmith-stretch

A minimal, deterministic, glitch-free demo lane that runs **Signalsmith Stretch** inside an `AudioWorkletProcessor`,
using a Seqlok-style hot-swap protocol:

**spawn → prime → preWarm → crossFade → retire**

This repo is meant to be "show, don't tell" for:
- RT-safe hotswapping (reject-while-busy, no overlapping swaps)
- segment-correct rendering (respecting offsets inside an audio block)
- input segment caching (both engines see identical samples during prewarm/crossfade)
- per-sample crossfade ramps derived from fade geometry (not UI progress)
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
src/                    — Vue app, worklet, lane runtime, DSP wrappers
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
- **em++** (Emscripten) — optional, only needed for real WASM compilation

---

## Setup

### Fast path (no Emscripten required)

```bash
pnpm install
pnpm run vendor
pnpm run dev          # or: pnpm run build
```

The build script auto-detects whether `em++` is available. If not, it writes a dev shim
that provides stub implementations of the WASM bridge functions — enough for
TypeScript to typecheck and Vite to bundle the app.

### Full path (with WASM compilation)

Install Emscripten (e.g. via `emsdk`), then:

```bash
pnpm install
pnpm run vendor
pnpm run build:wasm   # compiles real WASM module via em++
pnpm run dev          # or: pnpm run build
```

---

## Scripts

| Script | Purpose |
|---|---|
| `pnpm run dev` | Generate module (or shim), then start Vite dev server |
| `pnpm run build` | Generate module (or shim), typecheck, and bundle |
| `pnpm run vendor` | Download vendored Signalsmith C++ headers |
| `pnpm run build:wasm` | Compile WASM module via em++ (requires Emscripten) |
| `pnpm run build:all` | vendor + build:wasm + build |
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
