import { homedir } from "node:os";
import { join } from "node:path";
import { PiClient } from "./pi-client.mjs";
import { env } from "./env.mjs";

const CONTROL_COMMANDS = new Set(["/help", "/new", "/status", "/model", "/thinking", "/stop"]);

/**
 * Per-chat pi session orchestration: each Feishu chat maps to its own pi RPC
 * process with an isolated --session-dir, so memory/skills persist per chat
 * and one busy agent never blocks another.
 */
export class Bot {
	constructor(feishu) {
		this.feishu = feishu;
		this.sessions = new Map();
		this.feishu.onMessage = (event) => this._onMessage(event);
	}

	_getPi(chatKey) {
		let session = this.sessions.get(chatKey);
		if (session) return session;
		const base = env("PI_SESSION_DIR") || join(homedir(), ".pi", "feishu");
		const safe = chatKey.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
		const provider = env("PI_PROVIDER") || undefined;
		const model = env("PI_MODEL") || undefined;
		const client = new PiClient({
			provider,
			model,
			sessionDir: join(base, safe),
			name: `feishu-${safe.slice(0, 16)}`,
			debug: env("PI_FEISHU_DEBUG") === "1",
		});
		client.start();
		client.on("exit", () => {
			// A crashed agent drops its chat session so the next message respawns it.
			if (this.sessions.get(chatKey)?.client === client) this.sessions.delete(chatKey);
		});
		session = { client, busy: false, buffer: "", messageId: null };
		this.sessions.set(chatKey, session);
		return session;
	}

	async _onMessage(event) {
		const message = event.message;
		const sender = message.sender || {};
		if (sender.sender_type === "app") return; // never answer our own messages

		const text = extractText(message);
		if (!text) return;

		// Group chats only respond to @-mentions of the bot.
		if (message.chat_type === "group" && !isMentioned(event, this.feishu.appId)) return;

		const chatKey = message.chat_id || message.message_id;
		const messageId = message.message_id;
		const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

		if (CONTROL_COMMANDS.has(first)) {
			return this._runCommand(chatKey, messageId, text);
		}

		const session = this._getPi(chatKey);
		if (session.busy) {
			return this.feishu.reply(messageId, "⏳ 上一条任务还在进行中，请稍候；发送 /stop 可中断。");
		}
		session.busy = true;
		session.buffer = "";
		session.messageId = messageId;
		const pi = session.client;
		const flush = () => {
			if (session.buffer.length > 0) {
				const out = session.buffer;
				session.buffer = "";
				this.feishu.reply(messageId, out).catch(() => {});
			}
		};
		const onEvent = (msg) => {
			if (msg.type === "message_update") {
				const delta = msg.assistantMessageEvent?.delta;
				if (typeof delta === "string" && delta) {
					session.buffer += delta;
					if (session.buffer.length >= 1100) flush();
				}
			}
		};
		pi.on("event", onEvent);
		try {
			await pi.prompt(text);
			// turn_end carries the finished assistant message; agent_settled is
			// the final "nothing left queued" point — flush on the latter.
			await new Promise((resolve) => pi.once("agent_settled", resolve));
			flush();
		} catch (err) {
			await this.feishu.reply(messageId, `❌ 处理失败：${shortError(err)}`);
		} finally {
			pi.off("event", onEvent);
			session.busy = false;
		}
	}

	async _runCommand(chatKey, messageId, text) {
		const session = this._getPi(chatKey);
		const pi = session.client;
		const [cmd, ...rest] = text.trim().split(/\s+/);
		try {
			switch (cmd.toLowerCase()) {
				case "/help":
					return this.feishu.reply(messageId, [
						"pi 飞书机器人使用说明",
						"· 直接发消息：让 pi 处理任务",
						"· /new：开始新会话（清空上下文记忆）",
						"· /status：查看当前模型与用量",
						"· /model <模式>：切换模型（如 /model deepseek，/model claude-sonnet-4-5:high）",
						"· /thinking <off|low|medium|high>：设置思考强度",
						"· /stop：中断当前任务",
					].join("\n"));
				case "/new": {
					await pi.newSession();
					return this.feishu.reply(messageId, "🆕 已开始新会话。");
				}
				case "/status": {
					const state = await pi.getState();
					const summary = summarizeState(state);
					return this.feishu.reply(messageId, summary);
				}
				case "/model": {
					const pattern = rest.join(" ");
					if (!pattern) return this.feishu.reply(messageId, "用法：/model <provider/模型 或 模型ID>");
					const res = await pi.command("set_model", { pattern });
					return this.feishu.reply(messageId, `✅ 已切换：${res?.model ?? pattern}`);
				}
				case "/thinking": {
					const level = rest[0];
					if (!level) return this.feishu.reply(messageId, "用法：/thinking <off|minimal|low|medium|high|xhigh|max>");
					const res = await pi.command("set_thinking_level", { level });
					return this.feishu.reply(messageId, `✅ 思考强度已设为 ${res?.level ?? level}`);
				}
				case "/stop":
					await pi.abort();
					return this.feishu.reply(messageId, "🛑 已发送中断指令。");
			}
		} catch (err) {
			return this.feishu.reply(messageId, `❌ 命令失败：${shortError(err)}`);
		}
	}
}

/** Plain text from text / post (rich text) messages. */
function extractText(message) {
	const content = message.content;
	if (typeof content !== "string") return "";
	try {
		const parsed = JSON.parse(content);
		if (message.message_type === "text") return String(parsed.text ?? "");
		if (message.message_type === "post") {
			const lines = [];
			for (const paragraph of parsed?.content ?? []) {
				lines.push((paragraph ?? []).map((run) => run?.text ?? "").join(""));
			}
			return lines.join("\n");
		}
		return "";
	} catch {
		return "";
	}
}

function isMentioned(event, appId) {
	const mentions = event?.message?.mentions ?? [];
	return mentions.some((m) => m?.id?.open_id || m?.id?.user_id);
}

function summarizeState(state) {
	const s = state?.state ?? state ?? {};
	const lines = [];
	if (s.model) lines.push(`模型：${s.model}`);
	if (s.provider) lines.push(`Provider：${s.provider}`);
	const usage = s.usage ?? state?.usage;
	if (usage) {
		lines.push(
			`用量：input ${usage.input ?? 0} · output ${usage.output ?? 0} · cacheRead ${usage.cacheRead ?? 0} · cacheWrite ${usage.cacheWrite ?? 0}`,
		);
	}
	if (s.sessionName) lines.push(`会话：${s.sessionName}`);
	if (!lines.length) lines.push("（当前会话暂无状态信息）");
	return lines.join("\n");
}

function shortError(err) {
	const message = String(err?.message ?? err);
	return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}