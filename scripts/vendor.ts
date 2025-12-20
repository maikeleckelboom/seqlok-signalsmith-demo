#!/usr/bin/env node
// Robust vendoring for public GitHub repos without git credentials.
// - Reads ./scripts/vendor.sources.json (above)
// - Downloads tarballs from codeload/GitHub archive endpoints
// - Verifies Content-Length and gzip magic
// - Extracts to .cache/vendor/<name>/<ref>/…
// - Copies include/ and extra root headers into ./vendor/<name>/…
// - Mirrors LICENSE files to third_party/licenses/<name>/
// - Writes vendor/<name>/.vendor-meta.json and package-level THIRD_PARTY_NOTICES.md

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const VENDOR_ROOT = path.join(PKG_ROOT, "vendor");
const CACHE_ROOT = path.join(PKG_ROOT, ".cache", "vendor");
const NOTICES = path.join(PKG_ROOT, "THIRD_PARTY_NOTICES.md");
const TP_LICENSE_DIR = path.join(PKG_ROOT, "third_party", "licenses");

const SOURCES_PATH = path.join(__dirname, "vendor.sources.json");

interface RepoSpec {
  readonly name: string;
  readonly repo: string;
  readonly ref: string;
  readonly includeDir?: string;
  readonly extraFiles?: readonly string[];
  readonly licenseFiles?: readonly string[];
}

interface VendorSummary {
  readonly name: string;
  readonly source: string;
  readonly ref: string;
}

const exists = (p: string): boolean => fs.existsSync(p);
const mkdirp = (p: string): Promise<string | undefined> =>
  fsPromises.mkdir(p, { recursive: true });

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
  const match = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:$|[#?])/i.exec(
    repoUrl,
  );
  if (!match) {
    throw new Error(`Cannot parse owner/repo from: ${repoUrl}`);
  }
  const [, owner, repo] = match;
  return { owner, repo };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function download(
  url: string,
  dest: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (res) => {
      const { statusCode } = res;

      if (
        statusCode !== undefined &&
        statusCode >= 300 &&
        statusCode < 400 &&
        res.headers.location
      ) {
        // Follow redirects
        res.resume();
        const redirectLocation = Array.isArray(res.headers.location)
          ? res.headers.location[0]
          : res.headers.location;
        return resolve(download(redirectLocation, dest, headers));
      }

      if (statusCode !== 200) {
        reject(new Error(`HTTP ${statusCode ?? "UNKNOWN"} for ${url}`));
        return;
      }

      const lenHeader = res.headers["content-length"];
      const expectedLength =
        typeof lenHeader === "string" ? Number(lenHeader) : 0;

      const out = fs.createWriteStream(dest);
      res.pipe(out);

      out.on("finish", async () => {
        try {
          const buf = await fsPromises.readFile(dest);
          if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
            throw new Error("Not a gzip (bad magic)");
          }
          if (expectedLength && buf.length !== expectedLength) {
            throw new Error(
              `Size mismatch (got ${buf.length}, expected ${expectedLength})`,
            );
          }
          resolve(dest);
        } catch (error) {
          reject(error);
        }
      });

      out.on("error", reject);
    });

    request.on("error", reject);
  });
}

async function downloadTarball(
  owner: string,
  repo: string,
  ref: string,
  outFile: string,
): Promise<string> {
  // Try stable codeload first, then archive/refs
  const candidates: readonly string[] = [
    `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`,
    `https://github.com/${owner}/${repo}/archive/${ref}.tar.gz`,
    `https://github.com/${owner}/${repo}/archive/refs/heads/${ref}.tar.gz`,
  ];

  const hdr: Record<string, string> = {};
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const url of candidates) {
      try {
        await download(url, outFile, hdr);
        return outFile;
      } catch (error) {
        lastErr = error;
      }
    }
    await sleep(300 * attempt);
  }

  if (lastErr instanceof Error) {
    throw lastErr;
  }

  throw new Error(`Failed to download tarball for ${owner}/${repo}@${ref}`);
}

async function untar(tarGz: string, outDir: string): Promise<void> {
  await mkdirp(outDir);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarGz, "-C", outDir], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar -xzf failed (${String(code)})`));
      }
    });
  });
}

async function copyTree(src: string, dst: string): Promise<void> {
  await mkdirp(dst);

  // Node 16.7+ has fs.promises.cp; older nodes fall back to shell `cp -R`.
  if (typeof fsPromises.cp === "function") {
    await fsPromises.cp(src, dst, { recursive: true });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", `cp -R "${src}/." "${dst}/"`], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cp -R failed (${String(code)})`));
      }
    });
  });
}

async function vendorOne(spec: RepoSpec): Promise<VendorSummary> {
  const { owner, repo } = parseOwnerRepo(spec.repo);
  const cacheDir = path.join(CACHE_ROOT, spec.name, spec.ref);
  const tarGz = path.join(cacheDir, `${repo}-${spec.ref}.tar.gz`);
  const extractDir = path.join(cacheDir, "extract");
  const dest = path.join(VENDOR_ROOT, spec.name);

  await mkdirp(cacheDir);

  if (!exists(tarGz)) {
    console.log(`→ Downloading ${owner}/${repo}@${spec.ref}`);
    await downloadTarball(owner, repo, spec.ref, tarGz);
  } else {
    console.log(`→ Using cached tarball ${path.relative(PKG_ROOT, tarGz)}`);
  }

  // Extract
  await fsPromises.rm(extractDir, { recursive: true, force: true });
  await mkdirp(extractDir);
  await untar(tarGz, extractDir);

  // Find top dir
  const entries = await fsPromises.readdir(extractDir, {
    withFileTypes: true,
  });
  const top = entries.find((entry) => entry.isDirectory());
  if (!top) {
    throw new Error("Unexpected tarball layout");
  }
  const root = path.join(extractDir, top.name);

  // Copy include tree
  const includeRoot = spec.includeDir ?? "include";
  const includeDir = path.join(root, includeRoot);
  if (!exists(includeDir)) {
    throw new Error(`Missing include dir: ${path.relative(root, includeDir)}`);
  }
  await fsPromises.rm(dest, { recursive: true, force: true });
  await mkdirp(dest);
  await copyTree(includeDir, path.join(dest, "include"));

  // Copy extra root headers (e.g. signalsmith-stretch.h) so relative
  // #includes like "../../signalsmith-stretch.h" work.
  if (Array.isArray(spec.extraFiles)) {
    for (const rel of spec.extraFiles) {
      const from = path.join(root, rel);
      if (exists(from)) {
        await mkdirp(dest);
        await fsPromises.copyFile(from, path.join(dest, rel));
      }
    }
  }

  // Write meta
  const meta = {
    source: spec.repo,
    requestedRef: spec.ref,
    actualCommit: spec.ref, // tarball pin
    syncedAt: new Date().toISOString(),
  } as const;

  await fsPromises.writeFile(
    path.join(dest, ".vendor-meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );

  // Mirror license(s) for packaging
  const licDest = path.join(TP_LICENSE_DIR, spec.name);
  await mkdirp(licDest);
  const licList = spec.licenseFiles ?? [];
  for (const rel of licList) {
    const from = path.join(root, rel);
    if (exists(from)) {
      const target = path.join(licDest, rel);
      await mkdirp(path.dirname(target));
      await fsPromises.copyFile(from, target);
    }
  }

  // README mirrors help downstream compliance
  const readmePath = path.join(root, "README.md");
  if (exists(readmePath)) {
    await fsPromises.copyFile(readmePath, path.join(licDest, "README.md"));
  }

  return { name: spec.name, source: spec.repo, ref: spec.ref };
}

async function writeNotices(summary: readonly VendorSummary[]): Promise<void> {
  await mkdirp(path.dirname(NOTICES));

  const lines: string[] = [
    "# Third-Party Notices",
    "",
    "This package includes third-party code. Full license texts are mirrored under `third_party/licenses/`.",
    "",
  ];

  for (const item of summary) {
    lines.push(`- **${item.name}** — ${item.source}@${item.ref}`);
  }

  lines.push("");

  await fsPromises.writeFile(NOTICES, `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  console.log("== Vendor sync ==");

  await mkdirp(VENDOR_ROOT);
  await mkdirp(CACHE_ROOT);

  let catalog: RepoSpec[];
  try {
    const raw = await fsPromises.readFile(SOURCES_PATH, "utf8");
    catalog = JSON.parse(raw) as RepoSpec[];
  } catch {
    throw new Error("Missing scripts/vendor.sources.json");
  }

  const summary: VendorSummary[] = [];

  for (const spec of catalog) {
    console.log(`\n• ${spec.name}`);
    const info = await vendorOne(spec);
    summary.push(info);
  }

  await writeNotices(summary);
  console.log("\n✅ Vendor sync complete.");
}

void main().catch((err: unknown) => {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
});
