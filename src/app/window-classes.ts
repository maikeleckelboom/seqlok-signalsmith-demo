export type DensityKey = "compact" | "medium" | "expanded";

export type WindowClassKey =
  | "compact-compact"
  | "compact-medium"
  | "compact-expanded"
  | "medium-compact"
  | "medium-medium"
  | "medium-expanded"
  | "expanded-compact"
  | "expanded-medium"
  | "expanded-expanded";

export const WINDOW_CLASS_KEYS: readonly WindowClassKey[] = [
  "compact-compact",
  "compact-medium",
  "compact-expanded",
  "medium-compact",
  "medium-medium",
  "medium-expanded",
  "expanded-compact",
  "expanded-medium",
  "expanded-expanded",
];

function classifyAxis(value: number): DensityKey {
  if (value < 768) return "compact";
  if (value < 1280) return "medium";
  return "expanded";
}

/**
 * Rough Material-ish window classifier based on width and height.
 */
export function classifyWindow(width: number, height: number): WindowClassKey {
  const horiz = classifyAxis(width);
  const vert = classifyAxis(height);
  return `${horiz}-${vert}` as WindowClassKey;
}
