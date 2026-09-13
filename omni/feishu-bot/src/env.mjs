import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Load feishu.env (next to this file) into process.env, plus any legacy .env,
 * without overriding already-set environment variables.
 */
export function loadEnv() {
	for (const file of [join(HERE, "feishu.env"), join(HERE, ".env")]) {
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
			let [key, ...rest] = trimmed.split("=");
			key = key.trim();
			const value = rest.join("=").trim().replace(/^["']|["']$/g, "");
			if (key && !(key in process.env)) process.env[key] = value;
		}
	}
}

export function env(name, fallback = "") {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}