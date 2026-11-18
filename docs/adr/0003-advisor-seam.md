# ADR 0003：模型在核心之外，只保留提议/裁决契约

## 状态

已采纳，2026-11-18。

## 背景

大模型在协议逆向里最有价值的角色是提出假设、解释证据、生成代码，而不是产出事实。若把模型直接嵌进分析路径，会带来三类问题：

1. 事实与猜测混在一起，破坏现有的 observation / inference / unknown 分层；
2. 模型与提示词频繁变化，核心包被迫跟着改；
3. 固件、密钥与设备流量可能被外发，调用方失去控制权。

## 决策

- 核心包不引入 LLM 依赖，不读取任何模型服务端点。
- 对外提供两个确定性操作：`evidence-pack`（整理紧凑证据包）与 `verify-hypotheses`（重算并裁决）。
- 假设采用固定 schema：`id`、`kind`、`claim`、`proposedBy`、`evidenceRefs`、`checks[]`。
- 每个 check 必须指名一个已注册 verifier；未注册或参数非法一律 `unsupported`，最终状态记为 `unverified`，绝不当作通过。
- 裁决结果带 `matched/total`、反例帧与 limitations；`verified` 只表达"在该批样本上成立"。
- MCP 暴露 `evidence_pack` 与 `verify_hypotheses`，让 agent 在外部完成提议，核心只做裁决。

## 后果

- 模型、提示词、本地/云端部署都可以独立演进，核心代码不受影响。
- 模型输出必须可翻译成检查，不能只给结论；这提高了单次交互成本，但换来了可复核性。
- 新增 verifier 是显式扩展点（`src/domain/verify.ts` 的 `runCheck` + `VERIFIERS`），旧调用方不会因未知 verifier 名称被误判。
- 若未来需要内置调用（例如本地推理），应新增一个独立的 adapter，而不是把模型调用塞进 `domain` 或 `app` 层。
