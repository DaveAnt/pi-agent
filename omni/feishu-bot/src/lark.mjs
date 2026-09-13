import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { env } from "./env.mjs";

/**
 * Minimal Feishu (飞书) long-connection client: subscribes to im.message
 * events over WebSocket (no public callback URL needed) and can reply to a
 * message thread. Requires an enterprise self-built app with bot capability.
 */
export class FeishuClient {
	constructor() {
		this.appId = env("FEISHU_APP_ID");
		this.appSecret = env("FEISHU_APP_SECRET");
		this.client = null;
		this.ws = null;
		this.onMessage = null;
	}

	connect() {
		if (!this.appId || !this.appSecret) {
			throw new Error(
				"FEISHU_APP_ID / FEISHU_APP_SECRET 缺失：请复制 feishu.env.example 为 feishu.env 并填写飞书自建应用凭据",
			);
		}
		// A local-only config file is the only storage for the peer credentials:
		// anything else would leak the app secret into process listings/logs.
		this.client = new Client({ appId: this.appId, appSecret: this.appSecret });
		const dispatcher = new EventDispatcher({}).register({
			"im.message.receive_v1": (data) => {
				const results = this._handleMessage(data).catch((err) => {
					console.error("[feishu] message handling error:", err);
				});
				return Promise.resolve(results);
			},
		});
		this.ws = new WSClient({ eventDispatcher: dispatcher, credentials: { appId: this.appId, appSecret: this.appSecret } });
		this.ws.start();
		this.ws.on?.("error", (err) => console.error("[feishu] ws error:", err?.message ?? err));
	}

	/**
	 * Reply to a message thread. `chunks` may contain several text segments —
	 * each is sent as its own reply so streaming output lands incrementally on
	 * the same thread.
	 */
	async reply(messageId, text) {
		for (const chunk of splitChunks(text)) {
			await this.client.im.message.reply({
				path: { message_id: messageId },
				data: { content: JSON.stringify({ text: chunk }), msg_type: "text" },
			});
		}
	}

	async sendProgress(messageId, text) {
		await this.client.im.message.reply({
			path: { message_id: messageId },
			data: { content: JSON.stringify({ text }), msg_type: "text" },
		});
	}

	async _handleMessage(data) {
		const event = data?.event ?? data;
		if (!event?.message || !this.onMessage) return;
		await this.onMessage(event);
	}
}

/** Split long replies into Feishu-safe text messages (hard cap 30 KB). */
export function splitChunks(text, limit = 1200) {
	const chunks = [];
	while (text.length > limit) {
		let cut = text.lastIndexOf("\n", limit);
		if (cut < limit * 0.5) cut = text.lastIndexOf(" ", limit);
		if (cut < limit * 0.5) cut = limit;
		chunks.push(text.slice(0, cut).trimEnd());
		text = text.slice(cut).trimStart();
	}
	if (text) chunks.push(text);
	return chunks;
}