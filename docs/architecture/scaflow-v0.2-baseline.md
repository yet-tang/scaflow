# Scaflow v0.2 设计基线摘要

## 已确认的唯一口径

1. 产品名和 CLI 名称统一为 `Scaflow` / `scaflow`。
2. Scaflow Engine 使用 TypeScript、Node.js 22、pnpm、Commander、Zod、SQLite、Vitest。
3. 具体项目拥有独立的 Scaflow Project Repository（SPR）。
4. SPR 保存项目知识、规则、Task Contract、环境定义和跨仓库契约，不保存应用源码。
5. Application Repository 保持独立 Git 仓库。
6. `workspace/repos/` 面向开发者，长期存在；正式 Codex Task 不直接修改这里。
7. `workspace/runs/<task-id>/<task-run-id>/` 面向 Scaflow 和 Codex，保存隔离 Worktree 与运行上下文。
8. `.scaflow/` 只保存本地运行状态，不保存应用源码。
9. `@control` 是 SPR 的保留仓库 ID。
10. Task 是团队共享定义；TaskRun 是一次本地执行；ChangeSet 是跨仓库逻辑变更集合。
11. TaskRun 成功不等于 Task 完成；只有相关 ChangeSet 合并后 Task 才能完成。
12. v0.1.0 只实现 Execution Kernel，不实现 PRD Compiler、生产发布或中央调度。
