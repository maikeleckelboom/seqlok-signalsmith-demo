export const EngineKind = {
  None: 0,
  A: 1,
  B: 2,
} as const;

export type EngineKind = (typeof EngineKind)[keyof typeof EngineKind];
