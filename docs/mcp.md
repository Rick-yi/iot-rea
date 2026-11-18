# 作为 MCP 服务运行

`iot-rea mcp` 在 stdio 上启动 MCP 服务，把同一套工作流暴露给 agent。分析逻辑与 CLI 完全共用，不存在第二份实现。

## 启动

```bash
npm run build
node /absolute/path/to/dist/cli.js mcp
```

stdout 只属于 MCP 协议；诊断信息只写 stderr。服务是只读的（工具声明 `readOnlyHint: true`，`openWorldHint: false`）。

## 客户端配置

Claude Code：

```bash
claude mcp add iot-rea -- node /absolute/path/to/iot-rea/dist/cli.js mcp
```

通用 `mcpServers` 配置（Cursor / Claude Desktop / 其他兼容客户端）：

```json
{
  "mcpServers": {
    "iot-rea": {
      "command": "node",
      "args": ["/absolute/path/to/iot-rea/dist/cli.js", "mcp"],
      "env": {
        "IOT_REA_TSHARK": "/usr/bin/tshark",
        "IOT_REA_SIGROK": "/usr/bin/sigrok-cli"
      }
    }
  }
}
```

`env` 里的两个变量都是可选的；缺失时对应工具返回 `missing_tool`，`doctor` 会明确列出。

## 工具

| 工具 | 输入要点 | 返回 |
|---|---|---|
| `doctor` | 无 | Node 支持情况、tshark / sigrok-cli 可用性与版本 |
| `inspect_capture` | `path`、`fields[]`、`display_filter`、`decode_as[]`、`packet_limit`、分页参数 | 行、`output_window`、Evidence |
| `diff_frames` | `path`（观测 JSON）、`min_samples` | 变异区段、字段候选、派生字段、校验候选、未知项 |
| `inspect_firmware` | `path`、可选 `extract_to` | 容器清单与区域，或提取结果 |
| `decode_signals` | `path`、`decoders[]`、`input_format`、`annotations[]` | 解码文本行 + 分页窗口 |
| `read_serial` | `path` | 归一化帧、跳过行数 |
| `build_observations` | `path`、`payload_field`、`labels_path`、`labels_format`、`display_filter`、`decode_as[]`、`packet_limit` | 可直接给 `diff_frames` 的观测、stats、未知项 |
| `ble_frames` | `path`、`peer_address`、`display_filter`、`packet_limit`、`labels_path` | `att:0xhhhh` 通道帧、方向统计、未知项；带标签时含观测 |
| `evidence_pack` | `path`、`max_frames` | 证据包：样本、字段候选、变异区段、校验候选、未知项、样本帧、可用 verifier |
| `verify_hypotheses` | `path`、`hypotheses[]` | 每条假设的 `verified` / `rejected` / `unverified` 与反例 |
| `infer_transitions` | `path`（帧 JSON）、`signature_bytes`、`channel` | 节点/边计数、Mermaid 图、未知项 |
| `export_ksy` | `path`（观测 JSON）、`id` | 草稿 `.ksy` 文本、被丢弃的重叠假设、未知项（不写文件） |

## 约定

- 每个成功结果都包含 `evidence`：源文件路径 / SHA-256 / 大小、工具路径 / 版本 banner / 可执行文件 digest、argv、stderr、分页窗口与 limitations。
- 失败不会伪装成空结果：结构化错误带 `code`（如 `missing_tool`、`output_limit`、`integrity_failure`），并保留已捕获的生产者输出。
- `output_window` 的 `total` 只描述所选过滤器 / 读入范围内的匹配数；空页不证明范围外不存在。
- 输入路径按调用方本地路径解析；服务不下载、不安装、不连接设备。
- 工具默认声明 `readOnlyHint: true`；只有 `inspect_firmware` 可为 `false`，因为它的 `extract_to` 会写文件。`export_ksy` 只返回文本，落在调用方手里。

## 给 agent 的提示词示例

```text
用 iot-rea 的 inspect_capture 读取 device.pcapng 的 udp 载荷，
再用 diff_frames 比较这组只改变温度的样本，给出字段偏移与置信度。
不确定的部分明确列成 unknown，不要补全。
```
