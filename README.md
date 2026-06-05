# Scaflow

Scaflow 是一个面向 AI Coding Agent 的项目级开发操作系统。它通过与具体项目绑定的 Scaflow Project Repository，组织项目知识、多代码仓库、Task Contract、隔离 Workspace、Codex 执行、Verification 和 ChangeSet。

当前仓库用于实现 **Scaflow v0.1.0 Execution Kernel**。

## 当前状态

- 设计基线：v0.2
- 产品目标版本：v0.1.0
- 阶段：PRD 已冻结，可进入任务拆解与开发

## 关键文档

- [Scaflow v0.1.0 PRD](docs/source/scaflow-v0.1.0-prd.md)
- [Scaflow v0.2 设计基线摘要](docs/architecture/scaflow-v0.2-baseline.md)

## v0.1.0 范围

```text
手工 Task Contract
→ 隔离 TaskRun Workspace
→ Codex 执行
→ Verification
→ Repair Loop
→ 多仓库 Commit
→ ChangeSet
```

PRD 编译、独立 Reviewer、GitHub PR 编排、Staging 与生产发布不属于 v0.1.0。
