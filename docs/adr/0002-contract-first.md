# ADR 0002：契约先行，CLI 与 MCP 共用工作流

## 状态

已采纳，2026-11-18。

## 背景

v1 只需要 CLI 和库，但目标是让 agent 后续直接调用同一套能力。如果在 CLI 里写分析逻辑，MCP 适配器将不得不复制一遍，证据语义也会分叉。

## 决策

- 四层依赖：`contracts → providers → domain → app/cli`，只向内依赖。
- `src/app/*` 是唯一的工作流实现，输入用 Zod schema 校验；`src/cli.ts` 只做参数翻译和格式化。
- `src/contracts/operations.ts` 暴露 `Operation<I, O>` 注册表，MCP 适配器绑定 `run(input)`，不解析 CLI 字符串。
- provider 只负责"把外部工具变成受控子进程"：绝对路径、私有只读副本、输入/输出/超时限额、执行前后 digest 复核、失败保留部分输出。
- 能力与提供者是多对多：`inspect-capture` 可由 tshark 提供，未来也可由其他解析器提供；provider 不进入 domain 层。

## 后果

- v1 不实现 MCP server，但 seam 已存在：加一层传输适配即可，不需要改工作流。
- Zod schema 是唯一的输入契约，CLI、库、未来的 MCP 都不会出现第二份定义。
- 外部工具缺失是 `limitations`/`missing_tool`，不是静默降级；`doctor` 与集成测试都按这个口径处理。
- 新能力必须先定义输入/输出契约，再选 provider；不能先写脚本再补契约。
