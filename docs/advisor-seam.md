# 外部模型接入缝（Advisor seam）

核心包**不调用任何模型**，也不依赖任何 LLM SDK。模型（或人）在外部，通过两个契约与本项目交互：

```
observations ──► evidence-pack ──► 外部提议者（模型 / 人）
                                        │
                                        ▼
                              hypotheses.json ──► verify-hypotheses ──► verified / rejected / unverified
```

这样模型可以自由地"猜"，但事实仍由确定性代码裁决。

## 为什么是这个形状

- **隐私与供应链**：固件、密钥、设备流量不离开本机；是否外发由调用方决定。
- **可验证性**：模型的每句话都必须翻译成一次可重算的检查，否则停留在 `unverified`。
- **可替换性**：换模型、换提示词、换成人工，都不需要改核心代码。
- **证据链**：裁决结果保留匹配数、反例帧号与限制，和项目其余部分的 `Evidence` 口径一致。

## 第一步：生成证据包

```bash
node dist/cli.js evidence-pack observations.json --max-frames 20 --out pack.json
```

证据包含：样本统计、字段候选、变异区段、校验候选、未知项、截断后的样本帧，以及**当前可用的 verifier 清单**。`framesOmitted` 明确说明帧列表不完整，避免提议者把"没看到"当成"不存在"。

## 第二步（外部）：产出假设

```json
[
  {
    "id": "h1",
    "kind": "field_semantics",
    "claim": "offset 0x04 是 little-endian f32 温度",
    "proposedBy": { "source": "llm", "model": "some-model", "promptSha256": "…" },
    "evidenceRefs": ["frame:f1", "region:4-7"],
    "checks": [
      {
        "verifier": "type_fit",
        "args": { "offset": 4, "width": 4, "type": "f32", "endian": "le", "variable": "temperature" }
      }
    ]
  }
]
```

`proposedBy` 是溯源字段：谁提的、哪个模型、提示词哈希。它不影响裁决，只用于审计。

## 第三步：确定性裁决

```bash
node dist/cli.js verify-hypotheses observations.json --hypotheses hypotheses.json
```

或通过 MCP 调用 `verify_hypotheses`。

裁决语义：

| 结果 | 条件 |
|---|---|
| `verified` | 至少一个 check，全部 `verified`（每个可用样本都匹配） |
| `rejected` | 任一 check `rejected`，并给出反例帧 |
| `unverified` | 没有 check，或存在 `unsupported` / 参数非法的 check |

`unsupported` 不等于"假"，只表示当前无法验证；这条规则防止未知的 verifier 名称被当成通过。

## 现有 verifier

| 名称 | 参数 | 判定 |
|---|---|---|
| `type_fit` | `offset`、`width`、`type`、`endian`、`variable`、可选 `factor` | 解码值与标签逐样本比对；支持 `expected = raw / factor` |
| `checksum_coverage` | `algorithm`、`position`、`width`、`endian`、`coveredFrom`、`coveredTo` | 按覆盖区间重算校验并与存储值比较 |
| `bcd_fit` | `offset`、`width`、`variable`、可选 `byteOffset`、`reverseBytes`、`factor` | 打包 BCD 解码；`byteOffset: 0x33` 表示线上字节曾被 +0x33；支持字节倒序与小数缩放；非法半字节或任一不匹配即拒绝 |
| `byte_transform` | `offset`、`width`、`variable`、`type`、`endian`、`transform{kind, operand}` 或 `transforms[]`、可选 `factor` | 逐字节变换（`xor` / `not` / `add` / `bit-reverse` / `nibble-swap`）后按数值类型解码；`add` 表示线上已加上 operand，验证时减回；`transforms` 按数组顺序依次应用，用于链式编码 |

## 扩展新 verifier

1. 在 `src/domain/verify.ts` 增加一个 `checkXxx`，返回 `CheckResult`（`matched`、`total`、`counterexamples`）。
2. 在 `runCheck` 的 `switch` 里注册名称。
3. 在 `VERIFIERS` 里补充描述与参数 schema，让证据包自动列出它。

未注册的名称会走 `default` 分支返回 `unsupported`，因此旧版本遇到新 verifier 名称也不会误判为通过。

## 边界

- `verified` 只针对**这批样本**，不是对设备的最终结论；证据里始终保留这条 limitation。
- 项目不替调用方判断"要不要把数据发给模型"；这一步必须由使用者明确授权。
- 未授权设备、他人网络上的流量不在适用范围内。
