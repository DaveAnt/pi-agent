/**
 * OmniTeam provider 桥（pi extension）。
 *
 * 把 OmniHub 中转站注册为 pi 的 OpenAI 兼容 provider（complete form ——
 * 官方推荐形态，legacy provider-config form 在部分版本存在 user content
 * 序列化问题）：
 *   OMNI_LLM_BASE_URL  中转站地址（默认 http://127.0.0.1:8686/omni/v1，
 *                       即 OmniHub 的 /{映射slug}/v1 通道，slug=omni）
 *   OMNI_LLM_API_KEY   中转站 API key（默认占位；OMNIHUB_REQUIRE_AUTH=1 时必填）
 *   OMNI_LLM_MODEL     默认模型 id（默认 omni-default）
 *
 * 由 OmniHub 的 pi-rpc 适配器经 omni.framework.json 的 launch.args 加载
 * （-e omni/omni-provider.mjs）；也可手动 `pi -e omni/omni-provider.mjs` 使用。
 */
import { createProvider, envApiKeyAuth, openAICompletionsApi } from "@earendil-works/pi-ai";

export default function omniProvider(pi) {
  const env = process.env;
  const baseUrl = (env.OMNI_LLM_BASE_URL || "http://127.0.0.1:8686/omni/v1").replace(/\/+$/, "");
  const modelId = env.OMNI_LLM_MODEL || "omni-default";

  pi.registerProvider(
    createProvider({
      id: "omni",
      name: "OmniHub Relay",
      baseUrl,
      auth: { apiKey: envApiKeyAuth("OmniHub relay key", ["OMNI_LLM_API_KEY"]) },
      models: [
        {
          id: modelId,
          name: "OmniHub Relay Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
}
