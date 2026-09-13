# pi-agent 飞书机器人桥（omni 分支）

把 [pi coding agent](https://github.com/earendil-works/pi) 接入飞书机器人：每个飞书会话对应一个独立且持久化的 pi 会话（隔离 `--session-dir`），消息通过 pi 的 RPC 模式处理，回复以流式分段的方式回到原消息线程。

## 整体结构

```
Agents/pi-agent                  # earendil-works/pi 的 fork（omni 分支）
├── omni/feishu-bot/
│   ├── feishu.env.example       # 凭据模板（复制为 feishu.env 使用）
│   ├── main.mjs                 # 入口；--self-test 离线自检
│   └── src/
│       ├── env.mjs              # feishu.env 加载
│       ├── pi-client.mjs        # pi --mode rpc 的 JSONL 客户端
│       ├── lark.mjs             # 飞书 WS 长连接 + 消息回复
│       └── bot.mjs              # 编排：消息 → pi → 流式回复；控制命令
```

## 快速开始

1. **构建 pi 本体**（一次）：仓库根目录执行

   ```bash
   npm install --ignore-scripts
   npm run build
   ```

2. **配置飞书应用**：
   - 到 <https://open.feishu.cn/app> 创建**企业自建应用**；
   - 「应用能力 → 机器人」开启机器人；
   - 「权限管理」开通：`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_msg:readonly`；
   - 发布版本上线（企业内可用）；
   - 把 App ID / App Secret 填入 `omni/feishu-bot/feishu.env`（复制自 `feishu.env.example`）。长连接模式不需要公网回调地址。

3. **配置模型**：在 `feishu.env` 里设 `PI_PROVIDER` / `PI_MODEL`（如 `openai` / `deepseek` / `claude-sonnet-4-5:high`），并配置对应 LLM API Key（`feishu.env` 或 `~/.pi/agent/auth.json`，支持 Anthropic/OpenAI/DeepSeek/Kimi/Google 等，见上游 `packages/coding-agent/docs/providers.md`）。

4. **自检 + 启动**：

   ```bash
   cd omni/feishu-bot
   npm install
   node main.mjs --self-test   # 离线检查管线（无需飞书凭据）
   node main.mjs               # 连接飞书长连接，等待消息
   ```

5. **使用**：私聊直接发消息；群聊 @机器人 后发送任务。机器人以「回复原消息」的方式推送，任务进行中的 1200 字符就会先分段送达。

## 机器人命令

| 命令 | 作用 |
|------|------|
| `/new` | 开始新会话（清空上下文） |
| `/status` | 当前模型 / provider / token 用量 |
| `/model <pattern>` | 切换模型（`/model deepseek`、`/model claude-sonnet-4-5:high`） |
| `/thinking <level>` | 设置思考强度（off/minimal/low/medium/high/xhigh/max） |
| `/stop` | 中断当前任务 |
| `/help` | 帮助 |

## 环境变量（feishu.env）

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭据（必填才能连飞书） |
| `PI_BIN` | pi 可执行入口（缺省自动探测仓库内构建产物 / PATH 中的 pi） |
| `PI_PROVIDER` / `PI_MODEL` | 模型 provider 与模型 |
| `PI_SESSION_DIR` | 会话持久化目录（缺省 `~/.pi/feishu`） |
| `ANTHROPIC_API_KEY` 等 | LLM 凭据（或 `~/.pi/agent/auth.json`） |
| `PI_FEISHU_DEBUG=1` | 打印飞书事件与 pi RPC 流量 |

## 注意事项

- 每个会话一个 pi 进程：低资源占用，但长时间不用建议手动重启桥以回收空闲进程。
- 群聊只回应 @机器人的消息；私聊全部回应。
- pi 本体首次对话会下载/确认模型数据（`npm run build` 已生成），缺网时用 `npm run build:offline` 重建。
- 本桥与上游无关，仅存在于 omni 分支，合入上游 main 时不会冲突（独立目录）。