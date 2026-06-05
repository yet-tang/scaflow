# Architecture Summary

Scaflow 由以下部分组成：

- Scaflow Engine：通用 CLI 与执行引擎。
- Scaflow Project Repository：与具体项目绑定的控制和知识仓库。
- Application Repositories：独立的前端、后端、Worker、Infra 等源码仓库。
- `workspace/repos/`：开发者长期工作区。
- `workspace/runs/`：Scaflow 为每次 TaskRun 创建的隔离执行区。
- `.scaflow/`：本地状态、日志、Evidence、缓存和锁。

详细基线见 `docs/architecture/scaflow-v0.2-baseline.md`。
