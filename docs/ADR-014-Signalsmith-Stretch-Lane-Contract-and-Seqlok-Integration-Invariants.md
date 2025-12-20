# ADR-014: Signalsmith Stretch Lane Contract and Seqlok Integration Invariants

Status: **Accepted (binding; implementation MUST conform)**
Date: **2025-12-19**

## Context

We are integrating **Signalsmith Stretch** (pitch-shift + time-stretch) into a Seqlok lane, compiled to WebAssembly and
executed on the audio thread.

Signalsmith ships two very different things:

1. **The DSP contract** (C++ library semantics): what `.process()`, latency reporting, automation timing, and split
   computation *mean*. ([GitHub][1])
2. **A WebAudio demo harness** (Worklet wrapper patterns used in community wrappers/forks): mutable JS schedules,
   dynamic RPC, seconds-based timeline decisions.

Seqlok’s goals are the opposite of “easy demo glue”:

* sample-accurate scheduling in **frames**,
* bounded audio-thread work (no surprise O(n) behavior),
* no GC/alloc churn in the render path,
* hard-fail compatibility (no silent drift),
* inspectability via shared-memory telemetry (not per-block messaging).

So we **adopt** the upstream DSP semantics *exactly*, and we **replace** the demo harness entirely with Seqlok-grade
lane architecture.

## Decision

### D1. We treat the Signalsmith library semantics as the source of truth

We MUST preserve these upstream meanings:

* **Time-stretch is integer sample accounting**: stretch ratio is realized by giving `.process()` different integer
  `inputSamples` vs `outputSamples`, and the caller must ensure those integers average to the intended ratio over
  time. ([GitHub][1])
* **Latency is two-halves**: `inputLatency()` and `outputLatency()` are distinct and define a *processing time*
  reference. Input must be fed ahead of processing time; output emerges behind it. ([GitHub][1])
* **Automation timing is defined at processing time**: pitch/stretch controls should be provided at the current
  processing time (`outputLatency()` ahead of output), while input is fed `inputLatency()` ahead of processing
  time. ([GitHub][1])
* **Split computation is a real-time stability knob**: enabling it introduces extra output latency and uses it to spread
  computation more evenly (reducing spectral “burstiness”). ([GitHub][1])
* **Quality-critical algorithmic structure remains untouched**: we do not reinterpret the algorithm; we host it. The
  design article explains the multi-stage prediction approach and the non-linear frequency map near strong harmonics
  used to avoid aliasing and preserve timbre. ([Signalsmith Audio][2])

**Interpretation:** We are not “re-implementing Stretch in TS”. We are building a deterministic host for the existing
DSP contract.

### D2. We intentionally diverge from demo-harness patterns

The following patterns are explicitly NOT adopted in the shipped lane:

* seconds-based timeline authority (`currentTime`/float seconds as “truth”),
* mutable JS schedule objects in the render path (`Array.shift()` / unbounded lists),
* dynamic RPC dispatch tables on the audio thread,
* per-block `postMessage` telemetry,
* live reconfigure/reset on the active engine (structural mutation).

**Why:** these optimize for convenience and demos, not for deterministic timing, bounded runtime, inspectability, and
testability.

### D3. Structural changes are performed by Seqlok hot-swap (never live mutation)

Any change that can affect internal buffering, latency, block/interval geometry, or split-computation behavior is *
*structural** and MUST be applied via:

**spawn → prime → preWarm → crossFade → retire**

We never call a live “reconfigure” on the active instance.

## Glossary

* **Frame**: one sample per channel on the audio thread timeline (integer-indexed).
* **Processing frame**: the point where parameter changes are centered (defined by latency halves). ([GitHub][1])
* **Output frame**: the time the worklet must deliver audio to the graph.
* **Segment**: a deterministic render slice (Seqlok lane boundary) with known `segmentOffsetFrames` and `segmentFrames`.

## Hard invariants (non-negotiable)

The implementation MUST satisfy all of the following:

1. **No live configure on the active engine. Ever.**
   Any structural change MUST be applied by hot-swap (spawn/prime/preWarm/crossFade/retire).

2. **At most two engines exist at once**: `active` and `next`.
   Overlapping swaps are rejected. No “swap pyramids”.

3. **Frame-based scheduling only.**
   All scheduling, mapping, and swap decisions are expressed in integer frames. Seconds are UI-only.

4. **Bounded audio-thread work per segment.**
   No unbounded loops over variable-length queues. No O(n) array shifting. No dynamic dispatch tables.

5. **No per-block postMessage telemetry.**
   Telemetry is written into a preallocated SAB ring. UI polls at 30–60Hz.

6. **Coherent parameter reads; coherent meter writes.**
   Parameters are read only inside `params.within(...)`. Meters are written only inside `meters.publish(...)`.

7. **Input is pulled once per segment, cached, and guarded.**
   The kernel pulls input exactly once per segment boundary, records/caches it, and detects overwrites (hash/guard).

8. **Automation is sampled at processing time, not “now”.**
   Parameter evaluation is keyed off the processing frame implied by latency halves. ([GitHub][1])

9. **Split computation is a configuration axis, not a runtime toggle.**
   Changing split computation MUST trigger a swap (because it changes latency behavior). ([GitHub][1])

## What we keep vs what we replace (explicit)

### Kept (Signalsmith’s “sacred DSP contract”)

* `.process(inputSamples, outputSamples)` semantics for time-stretch ratio control. ([GitHub][1])
* `inputLatency()` / `outputLatency()` meaning and processing-time alignment. ([GitHub][1])
* Automation timing rules relative to processing time. ([GitHub][1])
* `splitComputation` meaning and its latency tradeoff. ([GitHub][1])
* Algorithmic intent and quality rationale (multi-stage prediction, non-linear frequency map around strong
  harmonics). ([Signalsmith Audio][2])

### Replaced (demo harness)

* JS schedule objects → Seqlok schedule data (fixed-capacity, frame-based, no allocations).
* dynamic RPC → typed command ring + seqlock’d param blocks.
* `currentTime` seconds → Seqlok kernel frame clock.
* in-worklet unbounded audio queues → deterministic segment input cache / reservoir model.
* per-block messaging telemetry → SAB ring snapshots + UI polling.

## Implementation shape (normative constraints, not code)

### Processing-time alignment rule

For each render segment:

* Let `outputFrameNow` be the segment start on the output timeline.
* Let `processingFrame = outputFrameNow + outputLatencyFrames`.
* Parameters used for this segment MUST be evaluated at `processingFrame`.
* Input consumed MUST be pulled relative to processing time consistent with `inputLatencyFrames`
  semantics. ([GitHub][1])

### Time-stretch accounting rule

* Segment output length is fixed: `outputSamples = segmentFrames`.
* The kernel computes/accumulates a precise ratio accumulator so chosen integer `inputSamples` values average correctly
  over time (no drift hand-waving). ([GitHub][1])
* The DSP engine is driven only by these integers; Seqlok owns the policy.

### Structural config rule

* Any change that can alter latency halves, block/interval structure, or split computation is a swap-triggering
  change. ([GitHub][1])
* The active engine is never mutated to apply these.

## Consequences and benefits

* **Determinism**: schedule + input → reproducible output (within FP tolerance).
* **Real-time safety**: bounded work, no GC churn, no O(n) queue ops.
* **Correct automation**: parameter timing matches the DSP’s defined processing time. ([GitHub][1])
* **Glitch-free reconfiguration**: structural changes occur via crossFade swaps, not mid-stream reset.
* **Inspectability**: telemetry and time-travel debugging are first-class (SAB ring), not an afterthought.

## References

* Signalsmith Stretch official README (time-stretch integers, latency halves, split computation, automation
  timing). ([GitHub][1])
* “The Design of Signalsmith Stretch” (multi-stage prediction + non-linear frequency map
  rationale). ([Signalsmith Audio][2])

---

# ADR-015: Signalsmith Stretch Lane Conformance Gates (Audit, Tests, and Fail-Loud Rules)

Status: **Accepted (binding; must be wired into CI)**
Date: **2025-12-19**

## Relationship

This ADR operationalizes **ADR-014** by defining:

* a **conformance matrix** (what we preserve vs forbid),
* **audit gates** (lint + tests + runtime checks),
* **fail-loud behaviors** (what happens when reality disagrees with assumptions).

If ADR-014 is the constitution, ADR-015 is the enforcement mechanism.

## Context

The upstream contract explicitly defines:

* integer sample accounting for time-stretch ratios, ([GitHub][1])
* latency halves and processing-time alignment for automation, ([GitHub][1])
* split computation as an RT trade (extra latency for less bursty CPU), ([GitHub][1])
* design rationale for prediction + harmonic-preserving frequency mapping. ([Signalsmith Audio][2])

The demo-style WebAudio wrappers in the wild often rely on mutable JS schedules, dynamic RPC, and seconds-based logic.
Those are incompatible with Seqlok’s RT/determinism constraints.

So we require CI-level proof that:

* we preserve the DSP contract,
* we do not regress into demo-harness patterns,
* structural changes occur only via hot-swap,
* the audio thread stays bounded and boring.

## Decision

### D1. Conformance matrix is normative

#### Must preserve (Signalsmith contract)

1. **Integer sample accounting for stretch ratio** (`inputSamples`/`outputSamples` average to desired
   ratio). ([GitHub][1])
2. **Latency halves and processing-time semantics** (`inputLatency()` / `outputLatency()`, automation aligned to
   processing time). ([GitHub][1])
3. **Split computation semantics** (adds one interval of output latency, spreads compute). ([GitHub][1])
4. **Algorithmic intent** (multi-stage prediction, harmonic-safe non-linear map). ([Signalsmith Audio][2])

#### Must forbid (demo-harness behaviors)

* seconds-based timeline authority,
* mutable variable-length schedule objects in render path,
* dynamic RPC dispatch on audio thread,
* per-block postMessage telemetry,
* live reconfigure/reset on the active engine.

These are determinism leaks, not “stylistic differences”.

## D2. Audit gates (CI must fail if violated)

### Gate A — No dynamic nonsense in the render path (lint, enforced)

In audio-thread render codepaths (kernel render + worklet `process`), CI MUST fail if any appear inside the render hot
path:

* allocations: `new` / object literals `{}` (except clearly marked init-only)
* variable-length ops: `.push`, `.pop`, `.shift`, `.unshift`, `.splice`, `.sort`
* dynamic dispatch: method tables, `eval`, `Function`, `Object.assign`
* messaging: `port.postMessage`

### Gate B — Frame clock only (type + runtime)

* Kernel APIs are frame-based (`u32`/`i32` frames), never seconds.
* Runtime asserts (dev builds) enforce:

    * `segmentFrames > 0`
    * monotonic frame counters
    * schedule monotonicity and processing-frame coverage

### Gate C — Structural changes require hot-swap (protocol + tests)

Any change affecting latency halves, block/interval geometry, channel/sample-rate coupling, or split computation MUST be
applied via hot-swap. ([GitHub][1])

CI MUST include tests attempting “live reconfigure” which fail loudly (compile-time if possible, otherwise invariant
failure).

### Gate D — Telemetry is SAB ring only (lint + runtime)

* No per-block postMessage telemetry.
* Telemetry snapshots written to SAB ring at segment boundaries.
* UI reads at 30–60Hz.

## D3. Conformance test suite (required)

### Suite 1 — Timing contract tests (pure)

1. **Processing-time alignment test**
   Asserts parameter sampling at `processingFrame = outputFrame + outputLatencyFrames` and input alignment consistent
   with `inputLatencyFrames`. ([GitHub][1])

2. **Integer ratio accumulator test**
   Over many segments, asserts long-run average `input/output ≈ desiredRatio` and bounded instantaneous error (no drift
   explosion). ([GitHub][1])

### Suite 2 — Hot-swap invariants (protocol)

* reject overlapping swaps
* at-most-two-engines invariant
* sample-accurate crossFade geometry
* retire click-prevention (retire only after fade completion)

### Suite 3 — Determinism harness

* fixed input, fixed schedule, fixed config
* output matches baseline within tolerance
* telemetry sequence matches exactly

### Suite 4 — Soak / stress (integration)

* schedule updates at 30–120Hz
* periodic structural swaps on boundaries
* asserts: no overruns beyond threshold, no NaNs, schedule coverage valid, no overlap

## D4. Fail-loud rules

### Guest/WASM runtime fault (trap/exception/guard failure)

Lane MUST:

* transition to **faulted** state,
* output silence (or deterministic last-safe policy),
* publish fault telemetry + stable error code,
* never continue with corrupted state.

### Invalid schedule / impossible mapping

* reject at controller boundary where possible,
* otherwise hard-fault the update and keep last-valid segment active.

### Structural config change requested while busy

* reject via swap result; active engine remains untouched.

## D5. Required telemetry fields (minimum)

Per segment boundary snapshot includes:

* timeline: `frameNow`, `segmentOffsetFrames`, `segmentFrames`
* hotswap: phase enum, fade geometry, active/next kinds, ticket id
* latency: `inputLatencyFrames`, `outputLatencyFrames`
* input cache: hash/guard, pull-once flags
* output health: RMS/peak, NaN/Inf flags
* timing: overrun counters / worst-case segment cost

## Consequences

* The lane becomes **firmware-grade**: deterministic, bounded, auditable.
* Rigidity is intentional: it prevents regressions into demo-harness entropy.

## References

* Signalsmith Stretch official README (time-stretch integers, latency halves, split computation, automation
  timing). ([GitHub][1])
* “The Design of Signalsmith Stretch” (multi-stage prediction + harmonic-safe non-linear map). ([Signalsmith Audio][2])
