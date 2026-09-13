import { loadEnv } from "./src/env.mjs";
import { FeishuClient } from "./src/lark.mjs";
import { Bot } from "./src/bot.mjs";
import { PiClient, resolvePiCommand } from "./src/pi-client.mjs";
import { env } from "./src/env.mjs";

loadEnv();

const args = process.argv.slice(2);

if (args.includes("--self-test")) {
	await selfTest();
} else {
	const feishu = new FeishuClient();
	try {
		feishu.connect();
	} catch (err) {
		console.error(err.message);
		console.error("提示：请复制 omni/feishu-bot/feishu.env.example 为 feishu.env 并填写凭据。");
		process.exit(1);
	}
	const bot = new Bot(feishu);
	// Hold a reference so the orchestrator is never GC'd; also exposes the Zap:
	// the bot instance drives per-chat pi sessions.
	globalThis.__bot = bot;
	console.log("[feishu-bot] 已连接飞书长连接，等待消息……（Ctrl+C 退出）");
}

/**
 * Offline plumbing verification: env presence, pi binary resolution, and a
 * real pi RPC handshake. No Feishu connection and no LLM call is made, so it
 * works without credentials (LLM keys are only needed for actual chats).
 */
async function selfTest() {
	console.log("== pi-agent 飞书桥自检 ==");
	const checks = [];

	// 1. Feishu credentials (informational — the bridge runs without them being
	// present, it simply cannot connect to Feishu yet).
	if (env("FEISHU_APP_ID") && env("FEISHU_APP_SECRET")) {
		checks.push(["✔ 飞书凭据", "FEISHU_APP_ID / FEISHU_APP_SECRET 已配置"]);
	} else {
		checks.push(["⚠ 飞书凭据", "未配置；编辑 feishu.env 后可连飞书（自检其余部分不受影响）"]);
	}
	// 2. LLM credentials (informational).
	const llmKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "GEMINI_API_KEY",
		"OPENROUTER_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "MINIMAX_CN_API_KEY", "ZAI_CODING_CN_API_KEY"];
	const found = llmKeys.filter((k) => env(k));
	checks.push(found.length
		? [`✔ LLM 凭据`, `已配置：${found.join("、")}`]
		: ["⚠ LLM 凭据", "未配置任何 LLM API Key（或 ~/.pi/agent/auth.json）；真实对话需要其一"]);

	// 3. pi binary resolution.
	const cmd = resolvePiCommand();
	checks.push(["✔ pi 可执行入口", `${cmd.command} ${cmd.args.join(" ")} （${cmd.label}）`]);

	// 4. Real RPC handshake with the built CLI.
	try {
		const pi = new PiClient({ provider: env("PI_PROVIDER") || undefined, model: env("PI_MODEL") || undefined });
		pi.start();
		const state = await Promise.race([
			pi.getState(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("RPC get_state 超时")), 20_000)),
		]);
		const s = state?.state ?? state ?? {};
		checks.push([`✔ pi RPC 通道`, `握手成功；模型=${s.model ?? "(未设置)"} provider=${s.provider ?? "(未设置)"}`]);
		pi.close();
		await new Promise((r) => setTimeout(r, 300));
	} catch (err) {
		checks.push(["✘ pi RPC 通道", `${short(err)}`]);
		checks.push(["   原因排查", "确认已执行 npm install && npm run build（仓库根），且 LLM 凭据在 feishu.env 或 ~/.pi/agent/auth.json"]);
	}

	const width = Math.max(...checks.map((c) => c[0].length));
	for (const [label, detail] of checks) {
		console.log(`${label.padEnd(width)}  ${detail}`);
	}
	const failed = checks.some((c) => c[0].startsWith("✘"));
	console.log(failed ? "\n自检未通过（见上）" : "\n自检完成：管线可用，填入凭据即可接入飞书机器人。");
	process.exit(failed ? 1 : 0);
}

function short(err) {
	return String(err?.message ?? err).split("\n")[0].slice(0, 200);
}