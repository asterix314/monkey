# 错题本 DSH 插件 — 项目交接文档

> 用途：新会话的起点。读完这份就能接上之前的全部讨论，不必重问。
> 最后更新：2026-11-25

---

## 1. 项目目标

用 **DeepSeek Harness (DSH)** 开发一款**小学生错题本应用**，形态是 **DSH 插件**，先给自己用。

原始构想（用户原话）：
> 想用AI结对开发，比如把我的笼统问题描述丢给kimi 3.1 pro，让它做细化，然后指挥ds v4.1 flash去做具体编码和执行，并负责检查和验收。两个AI互相驱动吗？然后我和kimi对话，进行最高层级的控制和验收。

**当前阶段：讨论项目构想、设计架构。不着急写代码。**

---

## 2. 走过的弯路（已排除，不要重走）

### 2.1 dsh-tri-model 插件 —— 已放弃

- 插件本身工作正常，配置为 `plan(Kimi) → draft(DeepSeek) → review(GLM)`，FAIL 门禁回 draft ×2。
- **放弃原因**：它是独立进程直接发 HTTP 到写死的端点，**够不着 WorkBuddy 的额度**。
- 用户手上只有 WorkBuddy 额度 + 一个 `DEEPSEEK_API_KEY`，没有火山方舟/Moonshot/智谱的 Key。
- 结论：tri-model 需要真实厂商 API Key，与本项目的资源条件不匹配。

### 2.2 WorkBuddy 额度无法"反向导出"成 API Key —— 已确认

查过 `dsh-connect-workbuddy` 源码：

```
DSH 主 agent → 本机回环 shim(127.0.0.1:随机端口) → WorkBuddy 上游(SSE)
```

- shim 的 apiKey 是**进程内随机生成的临时 secret**（`resolveApiKey: () => shim.token()`），重启即变，只接受回环 + 校验 Host/Origin。
- 额度绑定在 WorkBuddy 账号 token 上（加密信封），不是开放平台 Key。
- 把账号 JSON 导出也没用：tri-model 只会发标准 `/chat/completions`，不走 WorkBuddy 那套 SSE + 渠道指纹。
- **不要再尝试这条路**，也不要尝试提取 token 去调非官方接口（违反服务条款 + 封号风险）。

### 2.3 dsh-subagent-routes 等第三方插件 —— 不适用

| 插件 | 机制 | 为什么不行 |
|---|---|---|
| [dsh-subagent-routes](https://github.com/zdt3476/dsh-subagent-routes) | 按**工作区目录**路由模型 | 本项目单工作区三角色，目录区分不了 |
| [dsh-subagent-model-switcher](https://github.com/star-kz/dsh-subagent-model-switcher) | 子会话输入框里手动切换 | 要先建会话再切，不能按角色预设 |
| [dsh-model-switch](https://github.com/lincong1987/dsh-model-switch) | 单个全局默认值 | 满足不了三角色 |

---

## 3. 正确方案（已确认可行）

### 3.1 关键机制：DSH 原生「子智能体模型选择」

**位置**：左侧栏 `Plugins` → `Built-in plugin settings` → 第一项 **`Subagent`** → 页内 **`Model selection`**

- 开关：`Allow agents to choose models for Subagents`
- 列表：`Models agents may choose`（**多选**，不是只能一个）
- 说明文字明确写：*"agents can choose a provider, model, and reasoning effort for each Subagent from the authorized models below. **Applies only to new sessions**"*

**状态：用户已于 2026-11-25 勾选并保存完毕。**

源码依据：`@deepseek-ai/dsh-tool-subagent/lib/model-selection-settings.js`
```js
static Config = z.object({
  enabled: z.boolean().default(false),
  allowedModels: z.array(AllowedModelRouteSchema).default([])   // ← 数组
})
```

未配置时（`policy === undefined`），只允许父会话那一个模型——这就是之前 `child LLM route "..." is not allowed for this Session` 报错的来源。

**注意**：策略在 `agent/created` 时采样，**只对新会话生效**。老会话永远是 `val: null`，改设置也不会追溯。

### 3.2 执行方式：`workflow` 工具

`workflow` 支持每个子代理独立指定 `provider` / `model`，能写 JS 编排脚本：

```
planner(Kimi) → coder(DeepSeek) → reviewer(GLM) → 不通过则回 coder 改
```

这正好实现 tri-model 的 plan → draft → review → 返工，但**模型全走 WorkBuddy 额度，零 API Key**，而且每步过程都在会话里可见。

> 备选：`subagent` / `subagent_fork` 也支持 provider/model 参数。
> **注意**：`spawn_teammate`（agent-team）**不支持**按角色指定模型——它只传 provider(spawn/fork)，源码在 `dsh-experimental-tool-agent-team`。

---

## 4. 可用模型清单（实测数据，含积分倍率）

从设置页实际抓取，`workbuddy-global` 分组（节选，按倍率升序）：

| 倍率 | 模型 ID | 上下文/最大输出 |
|---|---|---|
| ×0.00 | `deepseek-v4.1-flash` | 1M / 128K |
| ×0.03 | `deepseek-v4.1-flash-sg` | — |
| ×0.07 | `gpt-6-luna` | — |
| ×0.08 | `glm-5.3-flash` / `minimax-m3.1-flash` | — |
| ×0.14 | `gpt-5.6-luna` | 1M / 128K |
| **×0.69** | **`glm-5.3`** / **`glm-5.4`** | 1M / 48K |
| ×0.95 | `gemini-3.8-flash` | 1M / 65K |
| **×0.97** | **`kimi-k3.1-pro`** | 1M / 32K |
| ×1.33 | `gpt-6-sol` / `gpt-6.1-sol` | 1M / 128K |
| ×1.62 | `kimi-k3` | — |
| ×1.90 | `grok-4.7` | — |
| ×3.47 | `gpt-5.6-sol` | 1M / 128K |
| ×6.67 | `gpt-6-astra` | 1M / 128K |

`workbuddy`（国内区）分组另有：`hy4std` ×0.29、`hy4flash-free` ×0.00、`hy4flash` ×0.03、`deepseek-v4.1-flash` ×0.11、`deepseek-v4-pro` ×0.51。

> ⚠️ `fast-model` / `balanced-model` / `primary-model` / `deep-model` / `max-model` 是 WorkBuddy 的路由别名，不是具体模型，不建议用于流水线。

### 推荐组合（「稳妥档」）

| 层 | 模型 | 倍率 | 依据 |
|---|---|---|---|
| 规划 | `workbuddy-global/kimi-k3.1-pro` | ×0.97 | 厂商称 Terminal-Bench 4.0 得 65.7%（超 GPT-6 Astra 58.2%），强项是长程 Agent 与任务规划 |
| 执行 | `workbuddy-global/deepseek-v4.1-flash` | ×0.00 | 552B MoE、384K 输出、"性能–费用帕累托最优"、擅长从零建项目 |
| 审查 | `workbuddy-global/glm-5.3` | ×0.69 | 厂商称"编程能力最强开源模型"，**白盒代码审查与漏洞发现**是明确强项（CyberGym 84.5%） |

备选：`glm-5.4`（Loop Transformer，11-22 发布，太新，先用 5.3 稳妥）。

**选型逻辑**：执行层 token 消耗最大 → 要便宜且强；规划/审查 token 少 → 要聪明。

---

## 5. 待设计的问题（架构讨论的起点）

以下是本项目**尚未决定**的事项，适合与 Kimi 一起讨论：

### 5.1 功能范围
- 错题录入：题干、我的答案、正确答案、科目、年级、错因标签
- 复习：按科目/错因筛选、错题重做、掌握度标记
- 数据：本地持久化（不联网）
- 界面：简洁、适合小学生操作

### 5.2 待定的架构问题
1. **插件形态**：纯工具（agent 调用）？还是带 Web UI（client 半边 + sidebar 面板）？还是两者？
2. **数据存储**：JSON 文件？SQLite？放在工作区还是 `~/.dsh/`？如何做备份/迁移？
3. **录入方式**：手动表单？拍照 OCR？还是让 agent 从对话里提取？小学生用的话交互要极简。
4. **复习算法**：简单筛选？还是间隔重复（SRS，类似 Anki）？
5. **多用户**：只给自己用 → 是否需要区分孩子？要不要家长视角/孩子视角两套界面？
6. **错因分类**：固定标签（粗心/概念不清/计算错误/审题错误…）还是自由输入？
7. **与 DSH 的关系**：错题本数据要不要能被 agent 读取分析（比如"帮我分析这周错得最多的知识点"）？

### 5.3 技术约束（已知）
- DSH 插件规范：`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- 纯工具插件只需 Host 半边；要 UI 需加 `dsh.client` + `./client` export + `ctx.slots.register`
- 参考现成插件：`dsh-tutorabc-lesson`（本地 link 安装，纯工具 + 自带 web 页）
- 沙箱限制：`~/.dsh` 对沙箱 shell 只读，改 profile 配置需提权

---

## 6. 下一步

1. **新会话**（必须新开，白名单才生效）里，主会话选 **Kimi-K3.1-Pro**
2. 读这份文档，然后和 Kimi 讨论第 5 节的架构问题
3. 架构定稿后，再决定用 `workflow` 编排三模型流水线开始实现

---

## 7. 相关文件

- `dsh-subagent-settings-截图.png` — 设置页位置截图
- `dsh-subagent模型列表-截图.png` — 模型候选列表截图
- `.dsh-tmp/` — 本次调查的临时脚本（CDP 截图工具等，可删）
