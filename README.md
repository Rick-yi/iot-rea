# iot-rea

[![ci](https://github.com/Rick-yi/iot-rea/actions/workflows/ci.yml/badge.svg)](https://github.com/Rick-yi/iot-rea/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](package.json)

面向物联网设备的**证据优先**协议逆向框架。它读取已经录制的数据——抓包、串口日志、逻辑分析仪录制、固件容器——把结论拆成"观察 / 推导 / 推断 / 未知"，并给出可复核的证据。

结构借鉴了 [REA](https://github.com/morluto/rea) 的骨架（能力与提供者分离、自带外部工具、资源边界失败即停），补齐 REA 明确不做的事：采集归一化、私有字段差分推断、固件容器静态解析。

> 边界：本项目只处理已有录制数据。不打开网卡、不连接设备、不执行提取出的程序、不安装任何外部工具。请仅对自己拥有或获授权测试的设备与数据使用。

## 快速开始

```bash
npm ci
npm run build

# 主机与工具就绪情况
node dist/cli.js doctor

# 从抓包里选字段（需要 tshark）
node dist/cli.js inspect-capture device.pcapng \
  --fields frame.number,ip.src,udp.dstport,data.data \
  --filter 'udp.port == 5683'

# 单变量差分 → 字段类型草稿（不需要外部工具）
node dist/cli.js diff-frames observations.json

# 固件容器静态解析（不需要外部工具）
node dist/cli.js inspect-firmware firmware.uf2 --extract out/

# 串口录制日志
node dist/cli.js read-serial serial.log

# 以 MCP 服务运行，供 agent 调用
node dist/cli.js mcp
```

所有命令都支持 `--json` 输出完整结果与证据。MCP 客户端配置与工具说明见 [docs/mcp.md](docs/mcp.md)。

## 从抓包生成差分样本

手工拼 `observations.json` 容易出错，`build-observations` 把抓包与标签直接接起来：

```bash
node dist/cli.js build-observations device.pcapng \
  --payload-field data.data \
  --filter 'udp.port == 9999' \
  --labels labels.csv \
  --out observations.json
```

```csv
frame,temperature
3,21.5
5,22.25
6,23.0
```

标签第一列必须是 `frame` / `frameId` / `frame_number`，其余列是变量；数值与 `true`/`false` 自动转类型，其他保持字符串。也接受 JSON 映射（`{"3":{"temperature":21.5}}`）。输出对象包含 `observations`、`stats`、`unknowns` 与 `evidence`，可以直接作为 `diff-frames` 的输入；没有 `--out` 时输出到 stdout。

没有 payload 的帧会被跳过并计入 `stats.skippedNoPayload`，未打标签的样本只参与对齐、不参与字段推断，两者都会写进 `unknowns`。

## BLE / ATT

HCI 或 btsnoop 抓包可以直接归一化成按 handle 分通道的帧：

```bash
node dist/cli.js ble-frames capture.pcapng \
  --peer AA:BB:CC:DD:EE:FF \
  --labels ble-labels.csv \
  --out ble.json
```

- 每个 ATT 帧按 handle 归入 `att:0x0012` 这样的通道；没有 handle 的控制帧归入 `att:control`。
- 方向优先按 HCI 源/目的地址与 `--peer` 比对；没有 `--peer` 时按 ATT opcode 推断（请求视为 tx、通知/响应视为 rx，即假设 central 是主机），并在 `limitations` 里写明这个前提。
- `btatt.value` 的重复段会拼接；没有 value 的帧跳过并计数；未知方向也会计数。
- 带 `--labels` 时输出 `observations`，可直接交给 `diff-frames`，标签按帧号匹配。

## 差分输入格式

`diff-frames` 的输入是一组**只改变一个业务值**的样本：

```json
[
  { "frameId": "f1", "vars": { "temperature": 21.5 }, "hex": "a1030000000ac16b" },
  { "frameId": "f2", "vars": { "temperature": 22.25 }, "hex": "a10300000000b241d6" },
  { "frameId": "f3", "vars": { "temperature": 23.0 }, "hex": "a10300000000b841dc" }
]
```

输出包含四类东西，互不混淆：

| 类别 | 内容 |
|---|---|
| 观察 | 每个字节位置的变异率、连续可变区段、对齐长度与被排除的帧 |
| 推断 | 字段候选（偏移、宽度、类型、字节序、置信度、匹配样本数） |
| 推断 | 校验候选（算法、位置、覆盖范围、反例帧） |
| 未知 | 未对齐的尾部、未达阈值的变量、无法验证的语义 |

识别出的校验字段会从变异分析中屏蔽（`maskedOffsets`），不再冒充可变业务字段；总长/剩余长度这类字段作为**派生字段**单独输出，并说明是"描述帧本身"而不是载荷语义。恒定帧长不会被算作证据。检测到长度字段后，变长帧会按"公共 payload 窗口"对齐，而不是把短帧整体排除。

## 导出 Kaitai 草稿

差分结论可以直接落成 `.ksy`：

```bash
node dist/cli.js diff-frames observations.json --ksy sensor.ksy --id sensor
```

导出的布局是严格的顺序结构：没有推断结果的字节变成显式 `reserved_*`，每个字段的 `doc` 记录偏移、置信度和变量，校验字段标注算法与覆盖范围。Kaitai 本身不校验校验和，需要在应用代码里验证；重叠的弱假设会被丢弃并写进注释。`--ksy -` 直接输出到 stdout。

```yaml
seq:
  - id: reserved_0
    size: 4
    doc: "4 byte(s) at 0x0 were not placed by any hypothesis (gap #0)"
  - id: temperature
    type: f4le
    doc: "offset 0x4, width 4, confidence 1.00; variable temperature"
```

## 导出遥测（对接平台）

把分析结果变成平台可消费的**字段契约 + 标准化遥测**，不做发布、不联网：

```bash
node dist/cli.js export-telemetry observations.json \
  --device-id sensor-01 \
  --out ./export \
  --min-confidence 0.9 \
  --ts-base 1763000000000 --ts-step 1000
```

生成两个文件：

- `mapping.json`：字段契约（名称、偏移、宽度、类型、字节序、置信度、缩放）+ 校验/派生字段 + 未知项 + 源证据。
- `telemetry.jsonl`：每帧一行 `{"deviceId","ts","schemaVersion","frameId","values","quality"}`。

校验字段与派生长度字段**永远不会**进入遥测；某个标签变量未能解码时该行 `quality` 为 `partial`，而不是悄悄丢值或编造。时间戳是 `ts-base + 序号 × ts-step` 合成的，接入平台前请替换为真实时间戳。

之后只需一个发布器按平台规范把 jsonl 发出去（如 `devices/{deviceId}/telemetry`、ThingsBoard 的 `v1/devices/me/telemetry`）。

## 发布到 MQTT（显式 opt-in）

导出后的 jsonl 可以用内置的最小 MQTT 3.1.1 客户端发出去，**默认 dry-run**，只有加 `--send` 才联网：

```bash
# 先看会发什么
node dist/cli.js publish-telemetry export/telemetry.jsonl \
  --topic 'devices/{deviceId}/telemetry'

# 确认后真正发送
IOT_REA_MQTT_USERNAME=... IOT_REA_MQTT_PASSWORD=... \
node dist/cli.js publish-telemetry export/telemetry.jsonl \
  --topic 'devices/{deviceId}/telemetry' \
  --broker mqtt://broker.example:1883 --qos 1 --send
```

- 凭据只从 `IOT_REA_MQTT_USERNAME` / `IOT_REA_MQTT_PASSWORD` 读取，不出现在 argv；
- `--payload record`（默认，完整记录）或 `--payload values`（`{"ts","values"}`，适配 ThingsBoard 等）；
- 主题模板支持 `{deviceId}`、`{schemaVersion}`、`{frameId}`、`{quality}`、`{ts}`；
- `mqtts://` 默认校验证书，`--insecure` 仅供实验环境；
- 没有重试/重连/保留会话：这是短生命周期桥接，失败就重跑；`--rate-ms`、`--limit` 用于限速与试发。

发布能力只放在 CLI，不暴露为 MCP 工具——避免 agent 在不明确授权的情况下对外发送数据。

## 会话迁移图（实验性）

把一串帧变成"谁跟在谁后面"的观察图：

```bash
node dist/cli.js infer-transitions frames.json \
  --signature-bytes 2 \
  --mermaid flow.md
```

输入是帧数组：`{"frameId","direction","channel","hex","timestampMs"?}`；`read-serial` / `ble-frames` 输出的行（含 `nativeId`）也可以直接喂进来。输出节点计数、边计数、Mermaid 图，以及 unknowns。

必须明确的边界：它**只统计观察到的相邻迁移**，不是隐藏状态机。签名只取前 N 字节，共享前缀的消息会被合并；只出现一次的边、缺失时间戳（退化为文件顺序）、未知方向都会写进 `unknowns`。

## 外部模型接入缝（实验性）

核心包不调用任何模型。外部提议者（模型或人）通过两个命令与核心交互：

```bash
# 1. 生成紧凑证据包（含可用 verifier 清单）
node dist/cli.js evidence-pack observations.json --max-frames 20 --out pack.json

# 2. 对提议者产出的假设做确定性裁决
node dist/cli.js verify-hypotheses observations.json --hypotheses hypotheses.json
```

裁决只有三种结果：`verified`（所有 check 在每个可用样本上成立）、`rejected`（有反例）、`unverified`（没有可执行的 check，或 verifier 未注册/参数非法）。模型的贡献停留在"提议"，事实仍由代码重算。`ksy_compile` 让生成的 Kaitai 草稿可以被编译器实际校验（只编译、不执行生成代码）。完整契约、示例与 verifier 扩展方式见 [docs/advisor-seam.md](docs/advisor-seam.md)，决策记录见 [ADR 0003](docs/adr/0003-advisor-seam.md)。

## 支持的输入

| 输入 | 提供者 | 说明 |
|---|---|---|
| pcap / pcapng（含 BLE HCI、btsnoop） | TShark 4.x | 选字段、display filter、`decode_as`、输入包上限、分页 |
| 串口录制日志（文本 / JSONL） | 内置 | 方向、时间戳、通道；无法解析的行计入未知 |
| 逻辑信号录制（.sr / .vcd / .csv / .srzip） | sigrok-cli 0.7.2+ | 解码器文本原样返回，附 sample 范围 |
| UF2 | 内置 | 三个 magic 校验；按 family 分组；地址 gap 不填充 |
| Intel HEX（I8/I16/I32） | 内置 | 首行必须完整有效；checksum 校验；区域合并 |
| Motorola S-record（S19/S28/S37） | 内置 | 同上；记录 S0 头与起址记录 |
| DfuSe | 内置 | 校验签名与 16 字节 DFU 1.1a 后缀；目标布局在 v1 保持不透明并记为未知 |

单文件输入上限 32 MiB（`DEFAULT_MAX_INPUT_BYTES`）。外部工具只接受绝对路径配置，执行前后都会复核可执行文件与私有副本的 SHA-256；输出超过 4 MiB 直接失败，不返回截断的"成功"。

## 配置

| 变量 | 作用 |
|---|---|
| `IOT_REA_TSHARK` | tshark 的绝对路径（默认从 PATH 的绝对目录里查找） |
| `IOT_REA_SIGROK` | sigrok-cli 的绝对路径 |

## 架构

```
contracts   证据模型、操作契约、tagged error
   ↑
providers   tshark / sigrok / serial 适配器（统一限额、私有副本、digest 复核）
   ↑
domain      Frame 归一化、差分、类型推断、校验识别、固件容器解析
   ↑
app        工作流（与传输层无关）
   ↑
cli / mcp   参数翻译与协议绑定
```

依赖只向内。CLI 与 MCP 服务都只做参数翻译/协议绑定，分析逻辑只在 `src/app/` 实现一次。

## 开发

```bash
npm run typecheck
npm test          # 缺少 tshark 时集成测试自动跳过，并保留 limitations
npm run build
```

CI 会安装 tshark 与 sigrok-cli，并设置 `IOT_REA_REQUIRE_TOOLS=1`：在 CI 中缺失工具会直接失败，而不是把集成测试静默跳过。UART 的 `.vcd` 录制由 `test/fixtures/uartVcd.ts` 按 9600 8N1 生成，BLE 的 btsnoop 由 `test/fixtures/bleBtsnoop.ts` 按 HCI ACL / L2CAP / ATT 结构生成，都不提交二进制样本。两者都是**合成夹具，不是真机抓包**；CI 另外会拉取公开的真实/试验床抓包（Modbus plant、MQTTset）以及两份真机 BLE ATT 日志（公开 issue 附件）做回归，同样不提交二进制。本地没有工具时保留 skip，方便离线开发。

测试夹具全部由代码生成（`test/helpers.ts`），不提交二进制样本。协议结论请按 `docs/specs/_template/spec.md` 记录，架构决策写 ADR。

## 不在当前范围

实时抓包与网卡控制、设备在环实验台、重放与位翻转、加密载荷破解、binwalk/unblob 深度提取。

## License

MIT，见 [LICENSE](LICENSE)。
