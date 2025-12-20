#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root (where package.json lives)
const REPO_ROOT = path.resolve(__dirname, "..");

// Vendor package root (where C++ and d.ts live)
const VENDOR_ROOT = path.join(REPO_ROOT, "vendor");

// Emscripten source + output directories
const SRC_DIR = path.join(VENDOR_ROOT, "src", "emscripten");
const OUT_DIR = path.join(VENDOR_ROOT, "dist", "emscripten");

const MAIN_CPP = path.join(SRC_DIR, "main.cpp");
const DTS_SRC = path.join(SRC_DIR, "module.d.ts");
const MODULE_JS = path.join(OUT_DIR, "module.js");
const DTS_DST = path.join(OUT_DIR, "module.d.ts");

type EmccScalarValue = string | number | boolean;

interface EmccConfig {
  readonly ENVIRONMENT?: EmccScalarValue;
  readonly MODULARIZE?: EmccScalarValue;
  readonly EXPORT_ES6?: EmccScalarValue;
  readonly ALLOW_MEMORY_GROWTH?: EmccScalarValue;
  readonly INITIAL_MEMORY?: EmccScalarValue;
  readonly STACK_SIZE?: EmccScalarValue;
  readonly ABORTING_MALLOC?: EmccScalarValue;
  readonly MALLOC?: EmccScalarValue;
  readonly ASSERTIONS?: EmccScalarValue;
  readonly FILESYSTEM?: EmccScalarValue;
  readonly DYNAMIC_EXECUTION?: EmccScalarValue;
  readonly STRICT?: EmccScalarValue;
  readonly WASM_ASYNC_COMPILATION?: EmccScalarValue;
  readonly SINGLE_FILE?: EmccScalarValue;

  readonly EXPORTED_FUNCTIONS?: readonly string[];
  readonly EXPORTED_RUNTIME_METHODS?: readonly string[];
  readonly CFLAGS?: readonly string[];
  readonly LDFLAGS?: readonly string[];
  readonly PRE_JS?: readonly string[];
  readonly include?: readonly string[];

  // Allow unknown extra keys without caring about them
  readonly [key: string]: EmccScalarValue | readonly string[] | undefined;
}

type ScalarKey =
  | "ENVIRONMENT"
  | "MODULARIZE"
  | "EXPORT_ES6"
  | "ALLOW_MEMORY_GROWTH"
  | "INITIAL_MEMORY"
  | "STACK_SIZE"
  | "ABORTING_MALLOC"
  | "MALLOC"
  | "ASSERTIONS"
  | "FILESYSTEM"
  | "DYNAMIC_EXECUTION"
  | "STRICT"
  | "WASM_ASYNC_COMPILATION"
  | "SINGLE_FILE";

const SCALAR_KEYS: readonly ScalarKey[] = [
  "ENVIRONMENT",
  "MODULARIZE",
  "EXPORT_ES6",
  "ALLOW_MEMORY_GROWTH",
  "INITIAL_MEMORY",
  "STACK_SIZE",
  "ABORTING_MALLOC",
  "MALLOC",
  "ASSERTIONS",
  "FILESYSTEM",
  "DYNAMIC_EXECUTION",
  "STRICT",
  "WASM_ASYNC_COMPILATION",
  "SINGLE_FILE",
];

async function pickConfig(): Promise<string | null> {
  const candidates: readonly string[] = [
    // optional override at repo level
    path.join(REPO_ROOT, "scripts", "emcc.config.json"),
    // canonical location for now
    path.join(SRC_DIR, "emcc.config.json"),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

const setVal = (key: string, value: EmccScalarValue): string[] => [
  "-s",
  `${key}=${value}`,
];

const toList = (key: string, arr: readonly string[]): string[] => [
  "-s",
  `${key}=[${arr.map((x) => `'${x}'`).join(",")}]`,
];

const toPreJs = (
  entries: readonly string[] | undefined,
  baseDir: string,
): string[] =>
  (entries ?? []).flatMap((rel) => ["--pre-js", path.resolve(baseDir, rel)]);

const toIncludes = (
  entries: readonly string[] | undefined,
  baseDir: string,
): string[] =>
  (entries ?? []).flatMap((rel) => ["-I", path.resolve(baseDir, rel)]);

async function haveEmcc(): Promise<boolean> {
  try {
    await execa("em++", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// Development shim for when em++ is not available
async function writeShim(): Promise<void> {
  await ensureDir(OUT_DIR);

  const shimSource = [
    "export default async function create() {",
    "  return {",
    "    HEAPF32: new Float32Array(1024),",
    "    _bng_init() { return 1; },",
    "    _bng_setBuffers() { return 0; },",
    "    _bng_process() { return 0; },",
    "    _bng_latency() { return 0; },",
    "    _bng_output_position() { return 0; },",
    "    _bng_dispose() {},",
    "  };",
    "}",
    "",
  ].join("\n");

  await fs.writeFile(MODULE_JS, shimSource, "utf8");

  try {
    await fs.copyFile(DTS_SRC, DTS_DST);
  } catch {
    // best-effort
  }

  // eslint-disable-next-line no-console
  console.log("[build] wrote dev shim:", path.relative(REPO_ROOT, MODULE_JS));
}

async function build(): Promise<void> {
  const cfgPath = await pickConfig();
  const cfg: EmccConfig =
    cfgPath !== null
      ? (JSON.parse(await fs.readFile(cfgPath, "utf8")) as EmccConfig)
      : {};

  const cfgDir = cfgPath !== null ? path.dirname(cfgPath) : SRC_DIR;

  const useShim = process.env.DEV_SHIM === "1" || !(await haveEmcc());
  if (useShim) {
    await writeShim();
    return;
  }

  const args: string[] = [];

  // Scalar -s KEY=VALUE flags driven by SCALAR_KEYS
  for (const key of SCALAR_KEYS) {
    const rawValue = cfg[key];
    if (rawValue !== undefined) {
      args.push(...setVal(key, rawValue));
    }
  }

  if (cfg.EXPORTED_FUNCTIONS && cfg.EXPORTED_FUNCTIONS.length > 0) {
    args.push(...toList("EXPORTED_FUNCTIONS", cfg.EXPORTED_FUNCTIONS));
  }

  if (cfg.EXPORTED_RUNTIME_METHODS && cfg.EXPORTED_RUNTIME_METHODS.length > 0) {
    args.push(
      ...toList("EXPORTED_RUNTIME_METHODS", cfg.EXPORTED_RUNTIME_METHODS),
    );
  }

  if (cfg.CFLAGS && cfg.CFLAGS.length > 0) {
    args.push(...cfg.CFLAGS);
  }

  if (cfg.LDFLAGS && cfg.LDFLAGS.length > 0) {
    args.push(...cfg.LDFLAGS);
  }

  args.push(...toPreJs(cfg.PRE_JS, cfgDir));
  args.push(...toIncludes(cfg.include, cfgDir));

  await ensureDir(OUT_DIR);

  args.push(MAIN_CPP);
  args.push("-o", MODULE_JS);

  if (process.env.DEBUG) {
    const pretty = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    // eslint-disable-next-line no-console
    console.log("[em++]", pretty);
  }

  // eslint-disable-next-line no-console
  console.log("[build] em++ compiling", path.relative(REPO_ROOT, MAIN_CPP));

  await execa("em++", args, { stdio: "inherit" });

  // eslint-disable-next-line no-console
  console.log("[build] wrote", path.relative(REPO_ROOT, MODULE_JS));

  try {
    await fs.copyFile(DTS_SRC, DTS_DST);
    // eslint-disable-next-line no-console
    console.log("[build] types →", path.relative(REPO_ROOT, DTS_DST));
  } catch {
    // best-effort
  }
}

void build().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("❌ build failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
