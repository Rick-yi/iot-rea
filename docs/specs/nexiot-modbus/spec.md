# NexIoT Modbus RTU（读保持寄存器 / 写单寄存器）

> 第三个开源项目协议用例，用于验证 iot-rea 的差分、校验识别、假设裁决与 Kaitai 导出流程。
> 协议定义来自上游源码，不复制其代码、不执行其程序。

## 元信息

| 项 | 值 |
|---|---|
| 上游项目 | https://gitee.com/NexIoT/nexiot |
| 协议定义 | `cn-universal-framework/cn-universal-core/src/main/java/cn/universal/core/engine/extend/ModbusFunctions.java` |
| 核对提交 | `22072417fb51e6baa33ec0b895dddedbfac7b55d` |
| 采集方式 | 无抓包；按上游帧构建规则生成观测样本（见 `test/fixtures/nexiotModbus.ts`） |
| 测试 | `test/nexiot-modbus.test.ts`（11 条） |
| 分析日期 | 2026-11-18 |

## 上游定义的帧结构

- 读保持寄存器请求：`%02X 03 %04X(addr) %04X(qty) + CRC`
- 写单寄存器请求：`%02X 06 %04X(addr) %04X(value) + CRC`
- 读保持寄存器响应：`slave 03 byteCount (u16 BE register...) + CRC`
- CRC16/Modbus：初始 `0xFFFF`、多项式 `0xA001`、**低字节在前**发送

## 帧格式（读保持寄存器响应，单寄存器）

| 偏移 | 宽度 | 名称 | 类型 | 字节序 | 置信度 | 证据 |
|---|---|---|---|---|---|---|
| 0x00 | 1 | slave | u8 常量 `0x01` | - | 观察 | 全部样本 |
| 0x01 | 1 | function | u8 常量 `0x03` | - | 观察 | 全部样本 |
| 0x02 | 1 | byteCount | u8 常量 `0x02` | - | 观察 | 全部样本 |
| 0x03 | 2 | register | u16 | be | 推断 1.00 | 差分样本 m1–m5 |
| 0x05 | 2 | checksum | crc16-modbus over 0x00–0x04 | le | 推断 1.00 | 5/5 样本重算一致 |

差分样本（`register` 分别取 10、42、300、1000、5）：

```text
01 03 02 00 0a | c5 0d
01 03 02 00 2a | ?? ??
01 03 02 01 2c | ?? ??
01 03 02 03 e8 | ?? ??
01 03 02 00 05 | ?? ??
```

（完整帧由 `buildReadHoldingResponse` 生成，CRC 由独立的参考实现计算。）

## 复现命令

```bash
npm test -- nexiot-modbus
```

等价的 CLI 流程：

```bash
node dist/cli.js diff-frames observations.json --ksy modbus.ksy --id nexiot_modbus_read_holding
node dist/cli.js evidence-pack observations.json --max-frames 20
node dist/cli.js verify-hypotheses observations.json --hypotheses hypotheses.json
```

## 框架测试结论

| 项目 | 结果 |
|---|---|
| 变异区段 | 精确落在 `0x03–0x06`（数据字 + CRC），常量字节未误报 |
| 字段类型 | 单寄存器 → `u16 be @0x03`；4 寄存器响应中第 3 个 → `u16 be @0x07` |
| 字节序 | 换成小端样本后正确转为 `u16 le`，不硬编码大端 |
| 校验识别 | `crc16-modbus` @0x05（单寄存器）/ @0x0b（四寄存器），`le`，覆盖 `0x00–0x04` |
| 假设裁决 | 规范派生的 `u16 be`、CRC 覆盖范围 → `verified`；`u16 le` → `rejected`（反例 m1–m5）；未注册 verifier → `unverified` |
| Kaitai 草稿 | `reserved_0 size: 3` + `u2be register` + `u2le checksum_crc16_modbus` |

测试过程中发现并修复了一个框架缺陷：`u16` 与 `i16` 在同样匹配时的取舍原先取决于扫描顺序，导致小数值寄存器被标成 `i16`。现在按"同置信度、同宽度时无符号优先"裁决（`src/domain/inference.ts`），并加了回归测试。

## 未知

- [ ] `register` 的业务含义、单位与缩放（协议层只保证字节布局）
- [ ] 多寄存器响应中不同寄存器的语义映射
- [ ] 从站地址与网关子设备的实际寻址方式
- [ ] 异常响应（功能码 `0x83`）与写单寄存器响应的字节布局未纳入本次样本
