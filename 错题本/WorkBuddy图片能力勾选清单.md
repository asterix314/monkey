# WorkBuddy 模型图片能力勾选清单

> 依据：逐家厂商官方文档核实（非平台标记）。平台给全部 52 个模型都标了 `supportsImages: true`，该标记不可信。
> 生成时间：2026-11-26

---

## 操作路径

左下角头像「萝卜」→ **Settings** → 左侧导航 **WorkBuddy** → 顶部切 tab（国内版 / 国际版）→「模型」分栏 → 勾选图片框 → 点保存

---

## 国际版（workbuddy-global）—— 当前 0 个，请勾这 29 个

| 模型 ID | 倍率 | 上下文/输出 | 依据 |
|---|---|---|---|
| `hy4-preview` | ×0.29 | 1M / 64K | 腾讯官方：Hy4 首次引入视觉理解能力 |
| `hy4std` | ×0.29 | 960K / 64K | 同上 |
| `hy4flash` | ×0.03 | 960K / 64K | 同上 |
| `hy4flash-free` | ×0.00 | 960K / 64K | 同上 |
| `hy4free` | ×0.29 | 960K / 64K | 同上 |
| `deepseek-v4.1-flash` | ×0.00 | 1M / 128K | DeepSeek 官方：原生多模态视觉理解 |
| `deepseek-v4.1-flash-sg` | ×0.03 | 1M / 128K | 同上 |
| `gpt-6-astra` | ×6.67 | 1M / 128K | OpenAI 官方：Input modalities: text, image |
| `gpt-6.1-sol` | ×1.33 | 1M / 128K | 同上 |
| `gpt-6-sol` | ×1.33 | 1M / 128K | 同上 |
| `gpt-6-luna` | ×0.07 | 1M / 128K | 同上 |
| `gpt-6.2-astra` | ×4.34 | 1M / 128K | 同上 |
| `gpt-6.2-sol` | ×1.09 | 1M / 128K | 同上 |
| `gpt-6.1-terra` | ×0.54 | 1M / 128K | 同上 |
| `gpt-5.6-sol` | ×3.47 | 1M / 128K | 同上 |
| `gpt-5.6-terra` | ×1.39 | 1M / 128K | 同上 |
| `gpt-5.6-luna` | ×0.14 | 1M / 128K | 同上 |
| `gpt-5.5` | ×3.31 | 1M / 128K | 同上 |
| `gpt-5.4` | ×1.65 | 272K / 72K | 同上 |
| `grok-4.7` | ×1.90 | 500K / 128K | xAI 文档有 Image Understanding |
| `gemini-3.8-flash` | ×0.95 | 1M / 65K | Google 官方：Inputs Text, Image, Video, Audio, PDF |
| `gemini-4-carbon` | ×2.04 | 1M / 65K | 同上 |
| `gemini-4-argon` | ×2.04 | 1M / 65K | 同上 |
| `glm-5.4` | ×0.69 | 1M / 32K | 智谱官方：输入模态 视频、图像、文本、文件 |
| `glm-5.3-flash` | ×0.08 | 1M / 32K | 智谱官方：GLM-5 系列首个原生多模态模型（vlm/） |
| `minimax-m3.1-flash` | ×0.08 | 1M / 128K | MiniMax 官方：M3 支持多模态 Chat 输入 |
| `kimi-k3.1-pro` | ×0.97 | 1M / 32K | Kimi 官方：support text, image, and video input |
| `kimi-k3.1-pro-highspeed` | ×1.56 | 1M / 32K | 同上 |
| `kimi-k3` | ×1.62 | 1M / 32K | 同上 |

---

## 国内版（workbuddy）—— 已勾 5 个，请补这 5 个

**已勾（保持）**：`hy4std`、`deepseek-v4.1-flash`、`glm-5.3-flash`、`minimax-m3.1-flash`、`kimi-k3-1`

**需补勾**：

| 模型 ID | 倍率 | 上下文/输出 | 依据 |
|---|---|---|---|
| `hy4flash-free` | ×0.00 | 960K / 64K | 腾讯官方：Hy4 引入视觉理解 |
| `hy4flash` | ×0.03 | 960K / 64K | 同上 |
| `glm-5.4` | ×0.69 | 1M / 32K | 智谱官方：输入模态含图像 |
| `kimi-k3.1-pro` | ×0.97 | 1M / 32K | Kimi 官方：支持 image 输入 |
| `step-5-preview` | ×0.33 | 1M / 64K | 阶跃官方文档有「图片理解」章节 |

---

## ⚠️ 不要勾（官方明确仅文本）

| 模型 | 依据 |
|---|---|
| `glm-5.3` | 智谱官方原文：「GLM-5.3 目前仅支持处理文本模态信息」 |
| `glm-5.2` | 同系列 `text/` 路径，同样仅文本 |

---

## ⚠️ 未核实（建议保持不勾）

`fast-model`、`balanced-model`、`primary-model`、`max-model` —— 这些是 WorkBuddy 的**路由别名**，不是真实模型，勾了没意义。

`hy3`、`deepseek-v4-pro`、`space-bunny`、`kimi-k2.8-preview`、`mimo-v2.6-pro` —— 厂商文档没查到明确的图像输入说明。想稳妥用就先别勾；如果你确定某个能看图，手动勾上即可。

---

## 附：tri-model 流水线选型建议

| 层 | 推荐 | 倍率 | 理由 |
|---|---|---|---|
| 规划 | `kimi-k3.1-pro` | ×0.97 | Terminal-Bench 4.0 得 65.7%（超 GPT-6 Astra 58.2%），强项是长程规划 |
| 执行 | `deepseek-v4.1-flash` | ×0.00 | 帕累托最优、384K 输出、擅长从零建项目，当前免费 |
| 审查 | `glm-5.3` | ×0.69 | 代码审查与漏洞发现是明确强项（CyberGym 84.5%） |

**备选**：
- 更强审查 → `glm-5.4`（同价 ×0.69，Loop 架构，但发布仅 4 天）
- 要视觉能力 → 执行层用 `glm-5.3-flash`（×0.08，原生多模态）或 `deepseek-v4.1-flash`（也支持视觉）
- 省钱 → 审查层用 `glm-5.3-flash`（×0.08，但输出上限 32K）

**注意**：`deepseek-v4.1-flash` 国际区 ×0.00 是动态价格（有「夜间折扣」等活动），活动结束会变。
