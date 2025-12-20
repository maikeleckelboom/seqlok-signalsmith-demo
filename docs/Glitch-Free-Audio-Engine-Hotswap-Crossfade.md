# Glitch-Free Audio Engine Hotswap & Crossfade

## Overview

This is the **no-compromises checklist** for swapping DSP engines (presets / structural configs) **without clicks,
crackles, metallic combing, loudness dips, or surprise clipping**.

A glitch-free hotswap system means:

* Engines are **already instantiated and hot**.
* Swaps are **scheduled deterministically** (control side), then **executed RT-safe** (audio side).
* Both engines see **identical input samples** during prewarm/crossFade.
* Outputs are **latency-aligned** before mixing.
* crossFade uses **per-sample ramps** (no “one gain per block” nonsense).
* The audio thread does **zero allocation** and **no WASM instantiation**.

---

## The Lifecycle (the only one that counts)

**spawn → prime → preWarm → crossFade → retire**

Never “configure the live engine”. That’s how you summon the crackle demons.

---

## Terminology (be precise or suffer)

* **Audio callback (block):** The Worklet `process()` quantum (often 128 frames).
* **Segment:** A sub-slice of a block created by timeline scheduling. Segments may be smaller than the block.
* **segmentOffset:** Start index of the segment within the *block buffers*. If you ignore this, you will create periodic
  clicks.
* **fadeFrames:** Fade duration in **frames** (not blocks). Can span many segments.
* **preWarmBlocks:** Historical name. In practice this is **preWarmSteps**: how many render steps you run next-engine
  output-discarded *before* mixing. (If your lane steps per segment, this counts segments.)
* **processingFrame:** The time reference at which parameters are sampled for DSP (latency-derived), not “now”.

---

## Structural vs Runtime Changes (hard line)

If you don’t classify changes, consumers will accidentally reintroduce crackles “from the outside”.

### Structural (swap required)

Any change that can affect buffering, latency, memory layout, or compute scheduling:

* sampleRate, channelCount
* block/interval geometry (FFT/window sizes, internal hop/interval if exposed)
* `splitComputation`
* anything that changes `inputLatencyFrames` or `outputLatencyFrames`
* anything that changes required buffer sizing / max frames assumptions
* changing `laneDelayFrames` (if used) mid-session

### Runtime (no swap)

Safe to apply on the active engine (must still be RT-safe and bounded):

* time-map style controls: rate, transpose semitones, tonalityHz, formant controls
* loop region (if implemented purely as mapping and not DSP reinit)
* gains/trims and non-structural scalars

---

## Core Invariants (non-negotiable)

1. **Never reconfigure the live engine.** Only spawn a new one and swap via the protocol.
2. **Audio thread does not allocate.** No `new`, no closures, no view churn, no “tiny object, it’s fine”.
3. **Audio thread does not instantiate WASM.** No `createModule()`, no Emscripten init, no dynamic linking.
4. **WASM memory is fixed in RT.** No `memory.grow`, no heap growth, no realloc that invalidates pointers/views.
   Any attempt is a fault → lane enters faulted state and outputs silence deterministically.
5. **Input is segment-cached.** Per segment: **pull input exactly once** into a scratch buffer, then feed *that same
   scratch* to active + next.

    * If you “pull” twice during crossFade/prewarm, you’re crossfading two different timelines. Expect phasing, level
      weirdness, crackles.
6. **segmentOffset is respected everywhere.**
7. **Range discipline:** every RT loop operates on `[base, base + frames)` only.

    * Reads/writes for a segment must use `base = segmentOffset`.
    * Mixing from index 0 when `segmentOffset > 0` leaks stale samples and makes periodic ticks.
    * Touching outside the segment range is a correctness bug (detectable via prefix/suffix hash guards in debug).
8. **Output is finite.** Replace `NaN/Inf` with 0 immediately (RT-safe). Do this *before* delay lines and mixing.
9. **Parameters are sampled at processingFrame.** During preWarm and crossFade, parameters must be sampled at the same
   processing-time reference as normal rendering (latency-derived), not “message arrival time”.

---

## Architecture Contract (who does what)

### Control side (non-RT)

Owns **policy** and heavy work:

* choose configs/presets
* instantiate WASM modules
* build/prime/prewarm candidates if you do offline prep
* compute and schedule tickets (`atFrame`, `fadeFrames`, `preWarmSteps`)
* enforce “reject while busy”

> Seqlok mantra: **kernel owns time; driver owns policy; engines stay pure DSP.**

### Audio side (RT)

Owns **execution** only:

* step the state machine per render step
* render active engine
* optionally render next engine (discard during preWarm, mix during crossFade)
* apply latency alignment + crossFade ramps + safety
* commit at retire boundary

No allocations. No async. No “just this once”.

---

## Fade Geometry (the DSP-grade truth)

**Never use `status.progress` for DSP.** It is telemetry/UI only.

Your RT decision/status must provide **fade geometry**:

* `fadeTotalFrames`
* `fadeDoneFramesAtStepStart`
* `fadeDoneFramesAtStepEnd`

### Segment-correct ramp

If you render in **segments**, you must incorporate `segmentOffsetWithinStep` (usually 0 because the step *is* the
segment; if your step is the full block and you subsegment inside it, then the offset matters).

Per sample:

```js
const doneStart = fadeDoneFramesAtStepStart + segmentOffsetWithinStep;
t = clamp01((doneStart + i) / fadeTotalFrames);
```

If you do `t = status.progress` once per segment/block, you created a **stepped fade** (zipper noise + end-of-fade
crackle).

### RT cost rule

Per-sample ramps are mandatory, but per-sample `sin/cos` is expensive.
Prefer smoothstep or precomputed ramp tables over trig-heavy equal-power curves in the hot path.

---

## Retire Boundary (the classic “end crackle”)

The boundary must be internally consistent:

* On `retireNow`, **rendering and status must agree** which engine is “active output” for that step/segment.
* A common safe rule: **during `retireNow`, treat the committed (next) engine as active output** to avoid a one-segment
  discontinuity.

If you render the old engine for the “retire” step and only flip after output, you can get a click exactly at the end of
the crossFade.

---

## Input Segment Cache (the #1 “why does it sum weird” cause)

For each segment:

1. `pullInput(scratchIn, frames, segmentOffset)` exactly once.
2. active.render consumes `scratchIn`
3. next.render consumes **the same `scratchIn`** (during preWarm/crossFade)

Do **not** implement engines as “they call pullInput internally” in a way that advances a shared cursor twice when two
engines run in the same segment. If your engine wrapper pulls, then your lane must provide a cache so every pull returns
the same samples for that segment.

---

## Prime vs Prewarm (don’t mix them up)

### Prime

One-time “make the new engine sane for the current stream” (state reset, seek, history alignment).

* Must be **non-RT** if it involves allocations, copying, long loops, or WASM calls you can’t guarantee are RT-safe.
* If prime is RT-safe in your environment, it still must be **bounded** and allocation-free.

### preWarm (RT)

Render the next engine for some steps, **discard output**, to let internal state converge.

* Required for phase-based/spectral DSP (phase vocoders, stretchers).
* `preWarmSteps` must be > 0 for this class of engine.
* preWarm must run through the **same latency compensation path** you’ll use during the fade (see below).
* preWarm must sample parameters at **processingFrame** (latency-derived), consistent with normal rendering.

#### Deterministic minimum

At a minimum, preWarm must be long enough to advance the engine’s effective latency history through the same alignment
path:

```
minPreWarmSteps >= ceil(laneDelayFrames / stepFrames)
```

If you do not use a constant `laneDelayFrames`, use `ceil(outputLatencyFrames / stepFrames)` as the minimum baseline.

Then add a spectral safety margin (engine-dependent).

Rule of thumb start for Signalsmith-ish spectral engines: **32–64 steps**. Tune.

---

## Latency Alignment (ALC) – eliminate comb filtering

Comb filtering during a fade is almost always **latency mismatch** between engines.

### Required

Each engine exposes:

* `totalLatencyFrames` (input + output)
* integer, stable per structural config
* same timebase as `fadeFrames`

### Recommended: constant lane delay

Pick a **constant** session target:

```
laneDelayFrames = max(totalLatencyFrames across the entire preloaded pool)
pad = laneDelayFrames - engine.totalLatencyFrames
```

Then delay the faster engine more using **pre-allocated per-channel ring buffers**.

### Critical: preWarm advances the same delay path

If you only apply delay compensation during the fade, you start the fade with misaligned delay histories.

* During preWarm, run the next engine output through its delay line too (even if you discard the final output).

> If your pool is not closed (you don’t know max latency up front), you don’t have “no compromises.” Changing
> `laneDelayFrames` mid-session is audible unless you treat it as a structural change and transition it intentionally
> (mute/crossFade).

---

## crossFade Law (prevent dips *and* “why is it louder?”)

Two goals fight:

* loudness constancy
* peak safety

### Demo-safe default (start here)

Use a smooth linear ramp (sum to 1), optionally smoothed:

```
s(t) = t * t * (3 - 2 * t) // smoothstep
ga = 1 - s(t)
gb = s(t)
```

This avoids the classic +3 dB bump when the two signals are strongly correlated (which they should be after correct
preWarm + ALC).

### Equal-power (only after you’re aligned)

`sin/cos` / `sqrt` can be perceptually nicer with uncorrelated signals, but **can exceed 1.0 peak** with correlated
content.

If you use equal-power, you **must** add an output ceiling/limiter (allocation-free).

### The diagnostic that saves time

If you hear an RMS dip with linear: **assume misalignment**, not “wrong fade law”.
Check input cache + ALC + retire boundary first.

---

## Output Safety (RT-safe)

1. **NaN/Inf quarantine** (per sample; branchless if you care)
2. **Optional peak safety**

    * Debug: block peak → scale down if > 0.999 (catches mistakes fast)
    * Ship: avoid frequent scaling (it pumps). Prefer correct alignment and/or a tiny soft ceiling if needed.
3. Never let NaNs into delay lines (they smear forever).

---

## Hot Path Allocation Audit (JS/TS)

### Forbidden (in any RT-reachable path)

* `new Float32Array`, `new Array`, object literals in per-step loops
* `subarray()` / `slice()` / `map()` / `filter()` / `concat()` / spread

    * `subarray()` does not copy, but it **does** allocate a view object → GC pressure
* string building, logging, JSON stringify, error creation
* per-step `postMessage`
* per-step callback object creation passed into your lane runtime

### Allowed

* fully preallocated scratch buffers (input cache, engine outs, mix out, delay lines)
* plain `for` loops with explicit indices
* only touch the `[base, base + frames)` range for the segment

---

## Scheduling Rules (deterministic)

* Scheduling is **control-side**. Audio thread consumes already-installed tickets.
* Align `atFrame` to your step quantum boundary:

```js
atFrame = ceil((nowFrame + leadInFrames) / quantum) * quantum
```

* Reject while busy. Overlapping swaps do not stack.
* Never schedule in the past relative to lane time.

### Ticket installation timing (pick one model, don’t half-do both)

* **Model A (install immediately):** `atFrame` is informational; runway is provided by `preWarmSteps`.
* **Model B (gate installation; recommended default):** ticket becomes visible to RT only once `now >= atFrame`.

Be explicit; ambiguity here creates “sometimes it starts mid-block” artifacts.

---

## Observability Without Sabotage

* Telemetry must be allocation-free and rate-limited (20–60 Hz), or go to SAB meters.
* Offline trace/simulation can be as object-happy as it wants. RT cannot.

---

## Fault Policy (firmware rules)

If any RT invariant is violated (NaN storm, guard/hash mismatch, unexpected overwrite, unexpected memory change):

* Transition the lane to **faulted** state
* Output silence deterministically (or a documented last-safe policy)
* Emit a fault snapshot/telemetry record
* Do not attempt partial recovery on the audio thread

Undefined behavior is forbidden.

---

## Consumer Contract (what users of your API must provide)

A consumer-facing API must clearly specify:

* `fadeFrames` and `leadInFrames` (frames, not seconds/blocks)
* structural config boundaries (“this requires a new engine instance”)
* maximum shapes (max channels, max block samples) for preallocation
* an input provider contract that guarantees segment caching **or** accepts cached input passed in
* how latency is reported (`totalLatencyFrames`)
* which ticket installation model is used (A vs B) and how `atFrame` is interpreted

If you don’t define this contract, consumers will accidentally reintroduce crackles “from the outside”.

---

## Verification (tests that actually certify “glitch-free”)

* **Stress:** schedule swaps at 2–5 Hz for 60s while audio plays. Zero crackles.
* **Transparency:** swap between identical configs → inaudible.
* **Mismatch:** swap across latency differences → no metallic hollowing (ALC works).
* **Boundary:** specifically assert no discontinuity at retire boundary.
* **Memory:** assert no RT heap growth / no `memory.grow` and no pointer/view invalidation.

---

## Top Crackle Offenders (90% of bugs)

1. WASM instantiation on the audio thread (`createModule`, Emscripten init)
2. per-step `postMessage` / logging / string formatting
3. hidden allocation churn (typed-array views, callback objects, closures)
4. **double-pull input** within one segment (active/next see different samples)
5. **segmentOffset ignored** (reading/writing from index 0 for non-zero offset)
6. retire boundary mismatch (status vs rendering disagree)
7. latent WASM memory growth / realloc invalidating pointers/views

---

## Quick “symptom → cause” map

* **Crackle exactly at end of fade:** retire boundary mismatch, or stepped ramp, or offset bug.
* **Sometimes louder than normal:** equal-power without a limiter, or ramp math not clamped, or accidentally summing
  with ga + gb > 1, or double-pull input causing partial correlation spikes.
* **Metallic/phasey during fade:** latency mismatch (ALC), or input mismatch (segment cache), or preWarm not advancing
  the delay path.

---

## Success Criteria

If you can spam toggles and swaps sound **boringly normal**, you’re done:

* no metallic fade
* no clicks
* no pumping
* no surprise clipping
* no RT allocations / no RT WASM instantiation

At that point, the universe stops crackling back at you.
