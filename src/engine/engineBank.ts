import type { EngineKind } from "./engineKind";
import type { StretchEngine } from "./stretchEngine";

export interface EngineBank {
  register(engine: StretchEngine): void;
  get(kind: EngineKind): StretchEngine | null;
  unregister(kind: EngineKind): void;
}

export class SimpleEngineBank implements EngineBank {
  private readonly map = new Map<EngineKind, StretchEngine>();

  register(engine: StretchEngine): void {
    this.map.set(engine.kind, engine);
  }

  get(kind: EngineKind): StretchEngine | null {
    return this.map.get(kind) ?? null;
  }

  unregister(kind: EngineKind): void {
    this.map.delete(kind);
  }
}
