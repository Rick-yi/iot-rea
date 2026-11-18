# iot-rea

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
```

所有命令都支持 `--json` 输出完整结果与证据。

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
app / cli   工作流与参数翻译
```

依赖只向内。CLI 只做参数翻译与格式化；`src/contracts/operations.ts` 是未来 MCP 适配器的绑定点，工作流本身不感知传输层。

## 开发

```bash
npm run typecheck
npm test          # 缺少 tshark 时集成测试自动跳过，并保留 limitations
npm run build
```

测试夹具全部由代码生成（`test/helpers.ts`），不提交二进制样本。协议结论请按 `docs/specs/_template/spec.md` 记录，架构决策写 ADR。

## 不在 v1 范围

MCP server、实时抓包、设备在环实验台、重放与位翻转、加密载荷破解、binwalk/unblob 深度提取。

## License

MIT，见 [LICENSE](LICENSE)。
