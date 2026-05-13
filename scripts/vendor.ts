#!/usr/bin/env node
// Robust vendoring for public GitHub repos without git credentials.
// - Reads ./scripts/vendor.sources.json
// - Downloads tarballs from GitHub archive endpoints
// - Validates gzip magic, content length, redirects, and timeouts
// - Extracts to .cache/vendor/<name>/<ref>/…
// - Copies include/ and extra root files into ./vendor/<name>/…
// - Mirrors LICENSE files to third_party/licenses/<name>/
// - Writes vendor/<name>/.vendor-meta.json and package-level THIRD_PARTY_NOTICES.md

import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";
import {pipeline} from "node:stream/promises";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const VENDOR_ROOT = path.join(PKG_ROOT, "vendor");
const CACHE_ROOT = path.join(PKG_ROOT, ".cache", "vendor");
const NOTICES_PATH = path.join(PKG_ROOT, "THIRD_PARTY_NOTICES.md");
const THIRD_PARTY_LICENSES_ROOT = path.join(PKG_ROOT, "third_party", "licenses");
const SOURCES_PATH = path.join(__dirname, "vendor.sources.json");

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const GZIP_MAGIC_BYTE_0 = 0x1f;
const GZIP_MAGIC_BYTE_1 = 0x8b;
const GZIP_MAGIC_LENGTH = 2;

interface RepoSpec {
    readonly name: string;
    readonly repo: string;
    readonly ref: string;
    readonly includeDir?: string;
    readonly extraFiles?: readonly string[];
    readonly licenseFiles?: readonly string[];
}

interface VendorMeta {
    readonly source: string;
    readonly requestedRef: string;
    readonly syncedAt: string;
}

interface VendorSummary {
    readonly name: string;
    readonly source: string;
    readonly ref: string;
}

type Result<T> = | { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

function ok<T>(value: T): Result<T> {
    return {ok: true, value};
}

function err<T = never>(error: Error): Result<T> {
    return {ok: false, error};
}

function exists(filePath: string): boolean {
    return fs.existsSync(filePath);
}

async function ensureDir(dirPath: string): Promise<void> {
    await fsPromises.mkdir(dirPath, {recursive: true});
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function logBanner(message: string): void {
    console.log(message);
}

function logStep(message: string): void {
    console.log(`→ ${message}`);
}

function logWarn(message: string): void {
    console.warn(`! ${message}`);
}

function logDone(message: string): void {
    console.log(`✓ ${message}`);
}

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } {
    const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?(?:$|[#?])/i.exec(repoUrl,);

    if (!match) {
        throw new Error(`Cannot parse owner/repo from: ${repoUrl}`);
    }

    const [, owner, repo] = match;
    return {owner, repo};
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function normalizeRelativePath(relPath: string, label: string): string {
    if (path.isAbsolute(relPath)) {
        throw new Error(`${label} must be a relative path: ${relPath}`);
    }

    const normalized = path.normalize(relPath);

    if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`) || normalized.endsWith(`${path.sep}..`)) {
        throw new Error(`${label} must not escape its root: ${relPath}`);
    }

    return normalized;
}

function resolveInside(baseDir: string, relPath: string, label: string): string {
    const normalized = normalizeRelativePath(relPath, label);
    return path.join(baseDir, normalized);
}

async function readJsonFile(filePath: string): Promise<unknown> {
    const raw = await fsPromises.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
}

function assertString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }

    return value;
}

function assertOptionalStringArray(value: unknown, label: string,): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
        throw new Error(`${label} must be an array of non-empty strings`);
    }

    return value;
}

function validateRepoName(name: string, index: number): string {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`vendor.sources.json entry ${index} has invalid name "${name}". Allowed characters: letters, numbers, dot, underscore, hyphen.`,);
    }

    return name;
}

function parseRepoSpecs(value: unknown): RepoSpec[] {
    if (!Array.isArray(value)) {
        throw new Error("vendor.sources.json must contain an array");
    }

    const seenNames = new Set<string>();
    const specs: RepoSpec[] = [];

    for (const [index, item] of value.entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error(`vendor.sources.json entry ${index} must be an object`);
        }

        const record = item as Record<string, unknown>;

        const name = validateRepoName(assertString(record.name, `entry ${index}.name`), index);
        const repo = assertString(record.repo, `entry ${index}.repo`);
        const ref = assertString(record.ref, `entry ${index}.ref`);
        const includeDir = record.includeDir === undefined ? undefined : assertString(record.includeDir, `entry ${index}.includeDir`);
        const extraFiles = assertOptionalStringArray(record.extraFiles, `entry ${index}.extraFiles`);
        const licenseFiles = assertOptionalStringArray(record.licenseFiles, `entry ${index}.licenseFiles`,);

        if (seenNames.has(name)) {
            throw new Error(`vendor.sources.json contains duplicate package name "${name}"`);
        }

        seenNames.add(name);

        if (includeDir !== undefined) {
            normalizeRelativePath(includeDir, `entry ${index}.includeDir`);
        }

        for (const relPath of extraFiles ?? []) {
            normalizeRelativePath(relPath, `entry ${index}.extraFiles item`);
        }

        for (const relPath of licenseFiles ?? []) {
            normalizeRelativePath(relPath, `entry ${index}.licenseFiles item`);
        }

        specs.push({
            name, repo, ref, includeDir, extraFiles, licenseFiles,
        });
    }

    return specs;
}

async function run(cmd: string, args: readonly string[], cwd?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd, stdio: "inherit",
        });

        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`${cmd} ${args.join(" ")} failed (${String(code)})`));
        });
    });
}

async function hasValidGzipMagic(filePath: string): Promise<boolean> {
    const handle = await fsPromises.open(filePath, "r");

    try {
        const buffer = Buffer.allocUnsafe(GZIP_MAGIC_LENGTH);
        const {bytesRead} = await handle.read(buffer, 0, GZIP_MAGIC_LENGTH, 0);

        return (bytesRead >= GZIP_MAGIC_LENGTH && buffer[0] === GZIP_MAGIC_BYTE_0 && buffer[1] === GZIP_MAGIC_BYTE_1);
    } finally {
        await handle.close();
    }
}

async function readCachedTarballValidity(filePath: string): Promise<boolean> {
    try {
        return await hasValidGzipMagic(filePath);
    } catch {
        return false;
    }
}

function buildHttpError(statusCode: number | undefined, url: string): Error {
    return new Error(`HTTP ${statusCode ?? "UNKNOWN"} for ${url}`);
}

function buildTooManyRedirectsError(url: string): Error {
    return new Error(`Too many redirects while downloading ${url}`);
}

function buildInvalidGzipError(url: string): Error {
    return new Error(`Not a gzip archive: ${url}`);
}

function buildSizeMismatchError(url: string, actualLength: number, expectedLength: number,): Error {
    return new Error(`Size mismatch for ${url} (got ${actualLength}, expected ${expectedLength})`);
}

function resolveRedirectUrl(location: string | readonly string[], url: string): string {
    const target = Array.isArray(location) ? location[0] : location;
    return new URL(target, url).toString();
}

async function removeFileIfPresent(filePath: string): Promise<void> {
    await fsPromises.rm(filePath, {force: true});
}

function captureLeadingBytes(target: Buffer, currentLength: number, chunk: Buffer,): number {
    if (currentLength >= target.length || chunk.length === 0) {
        return currentLength;
    }

    const bytesToCopy = Math.min(target.length - currentLength, chunk.length);
    chunk.copy(target, currentLength, 0, bytesToCopy);
    return currentLength + bytesToCopy;
}

async function finalizeDownloadValidation(url: string, tempFile: string, bytesRead: number, expectedLength: number | undefined, leadingBytes: Buffer, leadingBytesLength: number,): Promise<Error | undefined> {
    if (leadingBytesLength < GZIP_MAGIC_LENGTH || leadingBytes[0] !== GZIP_MAGIC_BYTE_0 || leadingBytes[1] !== GZIP_MAGIC_BYTE_1) {
        return buildInvalidGzipError(url);
    }

    if (expectedLength !== undefined && Number.isFinite(expectedLength) && bytesRead !== expectedLength) {
        return buildSizeMismatchError(url, bytesRead, expectedLength);
    }

    const fileLooksValid = await hasValidGzipMagic(tempFile);
    if (!fileLooksValid) {
        return buildInvalidGzipError(url);
    }

    return undefined;
}

async function download(url: string, destFile: string, headers: Readonly<Record<string, string>> = {}, redirectCount = 0,): Promise<Result<string>> {
    if (redirectCount > MAX_REDIRECTS) {
        return err(buildTooManyRedirectsError(url));
    }

    const tempFile = `${destFile}.tmp`;
    await removeFileIfPresent(tempFile);

    return await new Promise<Result<string>>((resolve) => {
        const request = https.get(url, {
            headers: {
                "user-agent": "vendor-sync-script", accept: "application/octet-stream,application/gzip,*/*", ...headers,
            }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        }, (res) => {
            void (async () => {
                const {statusCode} = res;

                if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && res.headers.location) {
                    const redirectUrl = resolveRedirectUrl(res.headers.location, url);
                    res.resume();
                    resolve(await download(redirectUrl, destFile, headers, redirectCount + 1));
                    return;
                }

                if (statusCode !== 200) {
                    res.resume();
                    resolve(err(buildHttpError(statusCode, url)));
                    return;
                }

                const contentLengthHeader = res.headers["content-length"];
                const expectedLength = typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;

                let bytesRead = 0;
                const leadingBytes = Buffer.alloc(GZIP_MAGIC_LENGTH);
                let leadingBytesLength = 0;
                let pipelineFailure: Error | undefined;

                res.on("data", (chunk: Buffer) => {
                    bytesRead += chunk.length;
                    leadingBytesLength = captureLeadingBytes(leadingBytes, leadingBytesLength, chunk);
                });

                try {
                    await pipeline(res, fs.createWriteStream(tempFile));
                } catch (error) {
                    pipelineFailure = toError(error);
                }

                if (pipelineFailure) {
                    await removeFileIfPresent(tempFile).catch(() => {
                    });
                    resolve(err(pipelineFailure));
                    return;
                }

                const validationFailure = await finalizeDownloadValidation(url, tempFile, bytesRead, expectedLength, leadingBytes, leadingBytesLength,);

                if (validationFailure) {
                    await removeFileIfPresent(tempFile).catch(() => {
                    });
                    resolve(err(validationFailure));
                    return;
                }

                let renameFailure: Error | undefined;

                try {
                    await fsPromises.rename(tempFile, destFile);
                } catch (error) {
                    renameFailure = toError(error);
                }

                if (renameFailure) {
                    await removeFileIfPresent(tempFile).catch(() => {
                    });
                    resolve(err(renameFailure));
                    return;
                }

                resolve(ok(destFile));
            })();
        },);

        request.on("error", (error) => {
            void removeFileIfPresent(tempFile).catch(() => {
            });
            resolve(err(toError(error)));
        });
    });
}

async function downloadTarball(owner: string, repo: string, ref: string, outFile: string,): Promise<string> {
    const candidates: readonly string[] = [`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, `https://github.com/${owner}/${repo}/archive/${ref}.tar.gz`, `https://github.com/${owner}/${repo}/archive/refs/heads/${ref}.tar.gz`,];

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
        for (const url of candidates) {
            const result = await download(url, outFile);

            if (result.ok) {
                return result.value;
            }

            lastError = result.error;
        }

        await sleep(300 * attempt);
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error(`Failed to download tarball for ${owner}/${repo}@${ref}`);
}

async function untar(tarGzFile: string, outDir: string): Promise<void> {
    await ensureDir(outDir);
    await run("tar", ["-xzf", tarGzFile, "-C", outDir]);
}

async function copyTree(srcDir: string, destDir: string): Promise<void> {
    await ensureDir(destDir);
    await fsPromises.cp(srcDir, destDir, {recursive: true});
}

async function copyRequiredFile(from: string, to: string, label: string): Promise<void> {
    if (!exists(from)) {
        throw new Error(`Missing ${label}: ${from}`);
    }

    await ensureDir(path.dirname(to));
    await fsPromises.copyFile(from, to);
}

async function writeVendorMeta(destDir: string, spec: RepoSpec): Promise<void> {
    const meta: VendorMeta = {
        source: spec.repo, requestedRef: spec.ref, syncedAt: new Date().toISOString(),
    };

    await fsPromises.writeFile(path.join(destDir, ".vendor-meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8",);
}

async function ensureValidCachedTarball(tarGzFile: string): Promise<boolean> {
    if (!exists(tarGzFile)) {
        return false;
    }

    const valid = await readCachedTarballValidity(tarGzFile);

    if (!valid) {
        logWarn(`Cached tarball is invalid, re-downloading ${path.relative(PKG_ROOT, tarGzFile)}`);
        await removeFileIfPresent(tarGzFile);
        return false;
    }

    logStep(`Using cached tarball ${path.relative(PKG_ROOT, tarGzFile)}`);
    return true;
}

function findSingleTopLevelDirectory(entries: readonly fs.Dirent[]): fs.Dirent {
    const directories = entries.filter((entry) => entry.isDirectory());

    if (directories.length !== 1) {
        throw new Error(`Unexpected tarball layout: expected exactly one top-level directory, found ${directories.length}`,);
    }

    return directories[0];
}

async function vendorOne(spec: RepoSpec): Promise<VendorSummary> {
    const {owner, repo} = parseOwnerRepo(spec.repo);
    const cacheDir = path.join(CACHE_ROOT, spec.name, spec.ref);
    const tarGzFile = path.join(cacheDir, `${repo}-${spec.ref}.tar.gz`);
    const extractDir = path.join(cacheDir, "extract");
    const vendorDestDir = path.join(VENDOR_ROOT, spec.name);
    const licenseDestDir = path.join(THIRD_PARTY_LICENSES_ROOT, spec.name);

    await ensureDir(cacheDir);

    const hasUsableCache = await ensureValidCachedTarball(tarGzFile);

    if (!hasUsableCache) {
        logStep(`Downloading ${owner}/${repo}@${spec.ref}`);
        await downloadTarball(owner, repo, spec.ref, tarGzFile);
    }

    await fsPromises.rm(extractDir, {recursive: true, force: true});
    await ensureDir(extractDir);
    await untar(tarGzFile, extractDir);

    const extractedEntries = await fsPromises.readdir(extractDir, {withFileTypes: true});
    const topLevelDir = findSingleTopLevelDirectory(extractedEntries);

    const extractedRoot = path.join(extractDir, topLevelDir.name);
    const includeDirRelative = spec.includeDir ?? "include";
    const includeSourceDir = resolveInside(extractedRoot, includeDirRelative, "includeDir");

    if (!exists(includeSourceDir)) {
        throw new Error(`Missing include dir for ${spec.name}: ${path.relative(extractedRoot, includeSourceDir)}`,);
    }

    await fsPromises.rm(vendorDestDir, {recursive: true, force: true});
    await ensureDir(vendorDestDir);
    await copyTree(includeSourceDir, path.join(vendorDestDir, "include"));

    for (const relPath of spec.extraFiles ?? []) {
        const sourceFile = resolveInside(extractedRoot, relPath, `extra file for ${spec.name}`);
        const targetFile = resolveInside(vendorDestDir, relPath, `vendor target for ${spec.name}`);
        await copyRequiredFile(sourceFile, targetFile, `extra file "${relPath}"`);
    }

    await writeVendorMeta(vendorDestDir, spec);

    await fsPromises.rm(licenseDestDir, {recursive: true, force: true});
    await ensureDir(licenseDestDir);

    for (const relPath of spec.licenseFiles ?? []) {
        const sourceFile = resolveInside(extractedRoot, relPath, `license file for ${spec.name}`);
        const targetFile = resolveInside(licenseDestDir, relPath, `license target for ${spec.name}`);
        await copyRequiredFile(sourceFile, targetFile, `license file "${relPath}"`);
    }

    const readmeSource = path.join(extractedRoot, "README.md");
    if (exists(readmeSource)) {
        await fsPromises.copyFile(readmeSource, path.join(licenseDestDir, "README.md"));
    }

    return {
        name: spec.name, source: spec.repo, ref: spec.ref,
    };
}

async function writeNotices(summary: readonly VendorSummary[]): Promise<void> {
    await ensureDir(path.dirname(NOTICES_PATH));

    const lines: string[] = ["# Third-Party Notices", "", "This package includes third-party code. Full license texts are mirrored under `third_party/licenses/`.", "",];

    for (const item of summary) {
        lines.push(`- **${item.name}** - ${item.source}@${item.ref}`);
    }

    lines.push("");

    await fsPromises.writeFile(NOTICES_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function loadCatalog(): Promise<RepoSpec[]> {
    let json: unknown;
    let loadFailure: string | undefined;

    try {
        json = await readJsonFile(SOURCES_PATH);
    } catch (error) {
        loadFailure = errorMessage(error);
    }

    if (loadFailure) {
        throw new Error(`Failed to load ${path.relative(PKG_ROOT, SOURCES_PATH)}: ${loadFailure}`);
    }

    return parseRepoSpecs(json);
}

async function main(): Promise<void> {
    logBanner("Vendor sync: third-party sources");

    await ensureDir(VENDOR_ROOT);
    await ensureDir(CACHE_ROOT);
    await ensureDir(THIRD_PARTY_LICENSES_ROOT);

    const catalog = await loadCatalog();
    const summary: VendorSummary[] = [];

    for (const spec of catalog) {
        console.log(`\n• ${spec.name}`);
        const item = await vendorOne(spec);
        summary.push(item);
    }

    await writeNotices(summary);
    logDone("Vendor sync complete");
}

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
});
