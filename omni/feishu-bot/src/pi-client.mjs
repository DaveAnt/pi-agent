import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

let nextId = 0;

/**
 * Resolve the pi CLI to spawn: explicit PI_BIN, the built CLI in this repo
 * checkout (node <repo>/packages/coding-agent/dist/bundle/cli.js), or `pi`
 * from PATH — in that order.
 */
export function resolvePiCommand() {
	const bin = env("PI_BIN");
	if (bin) return { command: bin, args: [], label: `PI_BIN=${bin}` };
	const repoCli = join(REPO_ROOT, "packages", "coding-agent", "dist", "bundle", "cli.js");
	if (existsSync(repoCli)) return { command: process.execPath, args: [repoCli], label: repoCli };
	return { command: "pi", args: [], label: "pi (PATH)" };
}

/**
 * Thin client for `pi --mode rpc`: JSONL commands on stdin, JSONL responses +
 * events on stdout. See packages/coding-agent/docs/rpc.md.
 */
export class PiClient extends EventEmitter {
	constructor({ provider, model, sessionDir, name, debug = false }) {
		super();
		this.provider = provider;
		this.model = model;
		this.sessionDir = sessionDir;
		this.name = name;
		this.debug = debug;
		this.proc = null;
		this.lineBuf = "";
		this.pending = new Map();
		this.stderrTail = [];
		this.exited = false;
	}

	start() {
		const { command, args, label } = resolvePiCommand();
		const rpcArgs = ["--mode", "rpc"];
		if (this.provider) rpcArgs.push("--provider", this.provider);
		if (this.model) rpcArgs.push("--model", this.model);
		if (this.sessionDir) rpcArgs.push("--session-dir", this.sessionDir);
		if (this.name) rpcArgs.push("--name", this.name);
		this.debug && console.log(`[pi] spawn ${command} ${[...rpcArgs, ...args].join(" ")} (${label})`);
		this.proc = spawn(command, [...args, ...rpcArgs], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.proc.stdin.on("error", () => {});
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", (chunk) => this._onData(chunk));
		this.proc.stderr.setEncoding("utf8");
		this.proc.stderr.on("data", (chunk) => {
			if (this.debug) process.stderr.write(`[pi:stderr] ${chunk}`);
			this.stderrTail = [...this.stderrTail, chunk].slice(-10);
		});
		this.proc.on("exit", (code, signal) => {
			this.exited = true;
			this.emit("exit", code, signal);
			this._failAll(`pi exited (${code ?? signal})`);
		});
	}

	_onData(chunk) {
		this.lineBuf += chunk;
		let idx;
		while ((idx = this.lineBuf.indexOf("\n")) !== -1) {
			const line = this.lineBuf.slice(0, idx).trim();
			this.lineBuf = this.lineBuf.slice(idx + 1);
			if (!line) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.type === "response") {
					const entry = this.pending.get(msg.id);
					if (entry) {
						this.pending.delete(msg.id);
						entry.resolve(msg);
					}
					continue;
				}
				this.emit("event", msg);
			} catch {
				this.debug && console.error(`[pi] non-JSON line: ${line.slice(0, 200)}`);
			}
		}
	}

	command(type, payload = {}) {
		if (this.exited) return Promise.reject(new Error("pi process is not running"));
		const id = `req-${++nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
			setTimeout(() => {
				const entry = this.pending.get(id);
				if (entry) {
					this.pending.delete(id);
					reject(new Error(`timeout waiting for response to ${type}`));
				}
			}, 30_000);
		});
	}

	prompt(message, { streamingBehavior } = {}) {
		const payload = { message };
		if (streamingBehavior) payload.streamingBehavior = streamingBehavior;
		return this.command("prompt", payload);
	}

	newSession() {
		return this.command("new_session");
	}

	getState() {
		return this.command("get_state");
	}

	abort() {
		return this.command("abort").catch(() => {});
	}

	close() {
		if (this.proc && !this.exited) {
			this.proc.stdin.end();
			const proc = this.proc;
			setTimeout(() => proc.kill(), 2000).unref?.();
		}
	}

	_failAll(message) {
		for (const [id, entry] of this.pending) {
			entry.reject(new Error(message));
			this.pending.delete(id);
		}
	}
}