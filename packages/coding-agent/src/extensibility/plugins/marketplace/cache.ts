/**
 * Plugin cache management.
 *
 * Cache layout: `<cacheDir>/<marketplace>___<pluginName>___<version>/`
 *
 * All three components are validated before any filesystem operation:
 *   - marketplace / pluginName: isValidNameSegment (alnum + . - , max 64)
 *   - version: isValidVersionForCache (alnum + ._+-, max 128)
 *
 * This ensures cache paths cannot be crafted to escape the cache directory.
 */

import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@oh-my-pi/pi-utils";

import { isValidNameSegment } from "./types";

// Reject anything that could be used for path traversal or shell injection in
// version strings. Only printable, unambiguous characters are allowed.
const VERSION_RE = /^[a-zA-Z0-9._+-]+$/;
const SUPERSEDED_MARKER = ".orphaned_at";
const SUPERSEDED_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Return true when `version` is safe for use as a cache path component. */
export function isValidVersionForCache(version: string): boolean {
	// prevent path-traversal sequences like ".." or "1..2"
	return version.length > 0 && version.length <= 128 && VERSION_RE.test(version) && !version.includes("..");
}

function validateCacheComponents(marketplace: string, pluginName: string, version: string): void {
	if (!isValidNameSegment(marketplace)) {
		throw new Error(`Invalid marketplace name for cache: "${marketplace}"`);
	}
	if (!isValidNameSegment(pluginName)) {
		throw new Error(`Invalid plugin name for cache: "${pluginName}"`);
	}
	if (!isValidVersionForCache(version)) {
		throw new Error(`Invalid version for cache: "${version}"`);
	}
}

/**
 * Return the absolute path for a cached plugin directory.
 * Throws if any component fails validation.
 */
export function getCachedPluginPath(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): string {
	validateCacheComponents(marketplace, pluginName, version);
	return path.join(cacheDir, `${marketplace}___${pluginName}___${version}`);
}

/**
 * Copy `sourcePath` into the cache, returning the absolute cache path.
 *
 * Idempotent: if the target already exists it is removed before copying,
 * so a partial previous cache is never silently reused.
 */
export async function cachePlugin(
	sourcePath: string,
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<string> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);

	// Ensure cache directory exists before writing into it
	await fs.mkdir(cacheDir, { recursive: true });

	// Copy to a staging directory first, then atomically rename into place.
	// This prevents destroying an active install if fs.cp fails mid-copy.
	const stagingPath = `${targetPath}.staging-${Date.now()}`;
	try {
		await fs.cp(sourcePath, stagingPath, { recursive: true });
		await fs.rm(targetPath, { recursive: true, force: true });
		await fs.rename(stagingPath, targetPath);
	} catch (err) {
		// Clean up staging dir on any failure; leave existing targetPath intact
		await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	return targetPath;
}

/** Keep a superseded install available to extensions already loaded in another session. */
export async function markSupersededPlugin(installPath: string): Promise<void> {
	const marker = path.join(installPath, SUPERSEDED_MARKER);
	await fs.rm(marker, { force: true });
	try {
		await fs.writeFile(marker, new Date().toISOString(), { flag: "wx" });
	} catch (err) {
		// A cache removed outside the manager need not block its replacement.
		if (isEnoent(err)) return;
		throw err;
	}
}

/** Remove superseded installs after the grace period, unless a registry still references them. */
export async function pruneSupersededPlugins(cacheDir: string, installedPaths: Set<string>): Promise<void> {
	let entries;
	try {
		entries = await fs.readdir(cacheDir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}

	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const installPath = path.join(cacheDir, entry.name);
		if (installedPaths.has(installPath)) continue;
		let markedAt: string;
		try {
			markedAt = await Bun.file(path.join(installPath, SUPERSEDED_MARKER)).text();
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		const timestamp = Date.parse(markedAt);
		if (Number.isNaN(timestamp) || now - timestamp < SUPERSEDED_GRACE_MS) continue;
		await fs.rm(installPath, { recursive: true, force: true });
	}
}

/**
 * Synchronous check — true when the cache directory exists on disk.
 * Uses `existsSync` because callers may need to run this check inline without async.
 */
export function isCached(cacheDir: string, marketplace: string, pluginName: string, version: string): boolean {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	return nodeFs.existsSync(targetPath);
}

/** Remove a single cached plugin directory. No-op if it does not exist. */
export async function removeCachedPlugin(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<void> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	await fs.rm(targetPath, { recursive: true, force: true });
}

/**
 * Remove all cache entries whose full path is not in `installedPaths`.
 *
 * Returns the count of removed directories. If `cacheDir` does not exist,
 * returns `{ removed: 0 }` rather than throwing.
 */
export async function cleanOrphanedCache(cacheDir: string, installedPaths: Set<string>): Promise<{ removed: number }> {
	let entries: string[];
	try {
		entries = await fs.readdir(cacheDir);
	} catch (err) {
		if (isEnoent(err)) return { removed: 0 };
		throw err;
	}

	let removed = 0;
	for (const entry of entries) {
		const fullPath = path.join(cacheDir, entry);
		if (!installedPaths.has(fullPath)) {
			await fs.rm(fullPath, { recursive: true, force: true });
			removed++;
		}
	}

	return { removed };
}
