# NexIoT DL/T 645 编码规则（数据域 + CS）

> 同一上游项目中的第二组字节级规则，用于验证框架面对"非恒等编码"时的行为：
> 应该定位变异区段、识别校验，但不能假装理解了被 `+0x33` 编码的字段。

## 元信息

| 项 | 值 |
|---|---|
| 上游项目 | https://gitee.com/NexIoT/nexiot |
| 规则来源 | `cn-universal-core/src/main/java/cn/universal/core/engine/extend/HexFunctions.java`、`ProtocolFunctions.java` |
| 核对提交 | `22072417fb51e6baa33ec0b895dddedbfac7b55d` |
| 测试 | `test/nexiot-dlt645.test.ts`（8 条），夹具 `test/fixtures/nexiotDlt645.ts` |
| 分析日期 | 2026-11-18 |

## 上游提供的规则

| 规则 | 上游函数 | 说明 |
|---|---|---|
| 数据字节 +0x33 | `hex_add33` / `hex_sub33` | 编码时每字节加 `0x33` 取低 8 位，解码时减回 |
| 地址 BCD 倒序 | `hex_645AddrEncode` | 12 位数字补零、BCD 编码、按字节倒序 |
| DI 倒序 | `hex_diReverse` | 数据标识按字节倒序 |
| CS 求和校验 | `cs_check` / `cs_verify` | 按字节求和取余（默认 mod 256），两位 HEX |

`68 … 68 / 16` 帧壳属于 DL/T 645 标准，不在上游帮助函数中声明；测试只对上述变换与 CS 规则做断言。

## 测试帧

```
68 addr(6) 68 C=0x91 L=0x08 [DI(4, 倒序) + BCD值(4) +0x33] CS 16
```

样本：电量 `1234 / 2000 / 3456 / 7890 / 9999`（8 位十进制，BCD 后仅低两字节变化）。

## 结果

| 项目 | 结果 |
|---|---|
| 变异区段 | `0x10–0x12`（低两字节 + CS）；高两字节因数值 < 10000 保持 `00 00` |
| 字段推断 | 对 `energy` **没有**输出类型假设，写入 unknowns："no field hypothesis" —— 编码字段没有被强行解释 |
| 校验识别 | `sum8 @0x12`，覆盖 `0x00–0x11`，5/5 一致 |
| 假设裁决 | CS 覆盖范围 → `verified`；"u32be 恒等解码" → `rejected`；"BCD + 0x33" → `verified`（`bcd_fit`，5/5） |
| Kaitai 草稿 | 编码值保持为 `reserved_*` 间隙；只输出 `checksum_sum8` |

## 未知

- [ ] 数值是否 BCD、小数位与单位（上游只给字节变换，不给语义）
- [ ] DI 是否也应参与 `+0x33`（上游 `hex_diReverse` 未包含该步）
- [ ] `C` 控制码与 `L` 长度的取值规则
- [ ] 其他变换（取反、异或、位交换）仍无 verifier，这类假设会停留在 `unverified`

## 复现

```bash
npm test -- nexiot
```
