# ADR-015: Signalsmith Stretch Lane Conformance Gates (Audit, Tests, and Fail-Loud Rules)

Status: **Accepted (binding; must be wired into CI)**
Date: **2025-12-19**

## Relationship

This ADR operationalizes **ADR-014 (Signalsmith Stretch Lane Contract and Seqlok Integration Invariants)** by defining:

* a **conformance matrix** (what we must preserve vs what we forbid),
* **hard audit gates** (lint + tests + runtime checks),
* **fail-loud behaviors** (what happens when reality disagrees with our assumptions).

If ADR-014 is the constitution, ADR-015 is the police, courts, and extremely annoyed auditor.

## Context

Signalsmith Stretch’s official docs define the **DSP timing contract**:

* time-stretch is achieved by passing different integer `inputSamples`/`outputSamples` to `.process()`, and **the caller** must ensure those integers average to the intended ratio over time, ([Signalsmith Audio][1])
* latency is reported in two halves (`inputLatency()` / `outputLatency()`), with automation centered on **processing time**, ([Signalsmith Audio][1])
* `splitComputation` exists specifically to trade extra latency for smoother CPU scheduling, ([GitHub][2])
* pitch-shifting can use a tonality limit via a non-linear frequency map, ([GitHub][3])
* the design article explains the algorithmic foundations (STFT amplitude mapping + phase prediction strategy + uneven/nonlinear mapping rationale). ([Signalsmith Audio][4])

The reference WebAudio wrapper (and many forks) are **demo harnesses**: mutable JS objects, dynamic RPC, seconds-based scheduling. That is explicitly *not* what we ship as a Seqlok lane.

So we need CI-level proof that:

* we preserve the DSP contract,
* we do not regress into “JS science project” patterns,
* structural changes are applied only via Seqlok hot-swap,
* the audio thread stays bounded and boring.

## Decision

### D1. Conformance matrix (keep vs forbid) is normative

#### Must preserve (Signalsmith contract)

1. **Integer sample accounting for stretch ratio**
   `.process(inputSamples, outputSamples)` is the ground truth mechanism; ratios emerge from the long-run average of those integers. ([Signalsmith Audio][1])

2. **Latency halves and processing-time semantics**
   Automation is sampled at **processing time**: `.outputLatency()` ahead of output; input is fed `.inputLatency()` ahead of processing time. ([Signalsmith Audio][1])

3. **Split computation’s meaning**
   Enabling split computation adds one interval of output latency and spreads compute more evenly (to reduce burstiness). ([GitHub][2])

4. **Pitch/tonality map semantics (if exposed)**
   Tonality limit uses a non-linear frequency map; custom freq map maps normalized frequencies. ([GitHub][3])

5. **Algorithmic intent**
   We do not reinterpret the algorithm; we host it. The design article describes the phase prediction + weighting + uneven mapping context that informs why it behaves like it does. ([Signalsmith Audio][4])

#### Must forbid (demo-harness behaviors)

* seconds-based timeline authority (`currentTime`/float seconds as “truth”)
* mutable JS schedule objects in the render path (`Array.shift()`, unbounded lists)
* dynamic RPC dispatch tables on the audio thread
* per-block `postMessage` telemetry
* live reconfigure/reset on the active engine (structural mutation)

These are not “style preferences”. They are determinism leaks.

---

## D2. Audit gates (CI must fail if violated)

### Gate A — “No dynamic nonsense in the render path” (lint, enforced)

In the audio-thread render codepaths (kernel render function + worklet `process`), CI MUST fail if any of the following appear **inside the render hot path**:

* allocation forms: `new`, `Array(...)`, object literals `{}` (except in clearly marked init-only blocks)
* variable-length array ops: `.push`, `.pop`, `.shift`, `.unshift`, `.splice`, `.sort`
* dynamic dispatch: indexing a method table, `eval`, `Function`, `Object.assign`
* messaging: `port.postMessage`

**Mechanism:** ESLint overrides using AST selectors on a named function boundary (example: `renderSegment()`), plus `no-restricted-syntax` rules scoped to that file/function.

(Yes, this is aggressive. That’s the point. The audio thread is not your arts-and-crafts corner.)

### Gate B — “Frame clock only” (type + runtime assertions)

* The kernel API MUST be frame-based (`u32`/`i32` frames), never seconds.
* Any conversion from seconds to frames is UI-side only.
* Runtime asserts MUST exist (dev builds) to ensure:

  * segment frames > 0
  * frame counters are monotonic
  * schedule segments are monotonic and cover the processing frame

### Gate C — “Structural changes require hot-swap” (protocol + tests)

Any change affecting:

* preset / configure block & interval geometry,
* `splitComputation`,
* channel count / sample rate coupling,
* any parameter that changes latency halves,

MUST be applied via Seqlok hot-swap (spawn → prime → preWarm → crossFade → retire). This is non-negotiable.

**CI check:** unit tests that attempt “live reconfigure” MUST fail (compile-time if possible, otherwise runtime invariant failure).

### Gate D — “Telemetry is SAB ring only” (lint + runtime)

* No per-block postMessage telemetry.
* Telemetry snapshots MUST be written into a preallocated SAB ring at segment boundaries.
* UI reads at 30–60Hz.

**CI check:** lint ban on `postMessage` usage in render path; integration test asserts that telemetry advances without port messaging.

---

## D3. Conformance test suite (must exist, not aspirational)

### Suite 1 — Timing contract tests (pure, deterministic)

1. **Processing-time alignment test**
   Given:

* `outputLatencyFrames`, `inputLatencyFrames`
* a segment start frame `F`

Assert:

* `processingFrame = F + outputLatencyFrames`
* parameters sampled at `processingFrame`
* input window is pulled for `(processingFrame + inputLatencyFrames)` (or equivalent mapping rule defined in ADR-014)

Rationale: matches upstream automation semantics. ([Signalsmith Audio][1])

2. **Integer ratio accumulator test**
   For a desired stretch ratio `r`, generate many segments and assert:

* chosen integer `inputSamples` produce long-run average `input/output ≈ r`
* bounded instantaneous error (no drift explosion)

This directly enforces the upstream “integers must average out” clause. ([Signalsmith Audio][1])

### Suite 2 — Hot-swap invariants (protocol correctness)

Property-based or exhaustive small-state tests:

* reject overlapping swaps (“reject-while-busy”)
* at-most-two-engines invariant is never violated
* crossFade geometry is sample-accurate and bounded
* retire does not click: retirement happens only after fade completes and active kind is committed

### Suite 3 — Determinism tests (bitwise-ish, within tolerance)

Run the lane kernel in a deterministic harness:

* fixed input signal
* fixed schedule stream
* fixed config

Assert:

* output matches a stored baseline within tolerance
* telemetry sequences (phase transitions, segment counters) match exactly

### Suite 4 — Soak tests (RT behavior under stress)

In a browser harness (Playwright/Chromium is fine if reproducible):

* random but valid schedule updates at 30–120Hz UI rate
* periodic structural swaps (preset/config) at musically plausible boundaries
* run long enough to flush “rare” paths

Assertions:

* no overruns beyond threshold
* no NaN flags
* schedule coverage remains valid
* swap protocol never overlaps

---

## D4. Fail-loud rules (what we do when something goes wrong)

### Runtime fault in guest/WASM (trap, exception, or guard failure)

The lane MUST:

* immediately transition to a **faulted** engine state,
* output silence (or last-safe output policy, but deterministic),
* publish fault telemetry + a stable error code,
* **not** attempt to continue with partially corrupted state.

No “maybe it’s fine.” DSP corruption is not a vibe.

### Invalid schedule / impossible mapping

* Reject at the controller boundary when possible (range/shape checks).
* If something slips through:

  * clamp only if policy explicitly permits (scalars only per Seqlok rules),
  * otherwise hard-fault that update and keep last-valid schedule segment active.

### Structural config change requested while busy

* Must be rejected via the swap result (policy-level rejection), leaving active engine untouched.

---

## D5. Required telemetry fields (minimum)

At each segment boundary, write one snapshot containing (at least):

* timeline: `frameNow`, `segmentOffsetFrames`, `segmentFrames`
* hotswap: phase enum, fade geometry (start, duration, ramps), active/next engine kind, ticket id
* latency: `inputLatencyFrames`, `outputLatencyFrames`, plus any pad
* input-cache: hash/guard, “pulled once” flags
* output health: RMS/peak, NaN/Inf flags
* timing: overrun/underrun counters (or worst-case processing time)

This makes the system inspectable *without* port spam.

---

## Consequences

* We get a lane that is **firmware-grade**: deterministic, bounded, auditable.
* The cost is deliberate rigidity: the render path becomes a “no fun allowed” zone.
* That rigidity is the feature: it prevents accidental regressions into demo-harness entropy.

## References

* Signalsmith Stretch usage docs (time-stretch integer accounting, latency halves, automation timing). ([Signalsmith Audio][1])
* Signalsmith Stretch README (split computation tradeoff and motivation). ([GitHub][2])
* Signalsmith Stretch design article (phase prediction + weighting + uneven mapping rationale). ([Signalsmith Audio][4])

---

If you want to go even more “Seqlok-core strict”, the next bolt-on is an **“RT Forbidden List”** file that’s shared across all lanes (a single ESLint config fragment) so every future lane inherits the same “audio thread is lava” ruleset.

[1]: https://signalsmith-audio.co.uk/code/stretch/ "Signalsmith Stretch  :  Open-source code  :  Signalsmith Audio"
[2]: https://github.com/maikeleckelboom/signalsmith-stretch/blob/main "GitHub - maikeleckelboom/signalsmith-stretch: C++ polyphonic pitch/time library (GitHub mirror)"
[3]: https://github.com/Signalsmith-Audio/signalsmith-stretch "GitHub - Signalsmith-Audio/signalsmith-stretch: C++ polyphonic pitch/time library (GitHub mirror)"
[4]: https://signalsmith-audio.co.uk/writing/2023/stretch-design/ "The Design of Signalsmith Stretch  :  Blog  :  Signalsmith Audio"
