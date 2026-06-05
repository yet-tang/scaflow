# Scaflow v0.1.0 产品需求文档

- 产品版本：v0.1.0
- 设计基线：v0.2
- 产品阶段：Execution Kernel
- 文档状态：Ready for Development
- 最后更新：2026-06-05

---

## 1. 文档目的

本文定义 Scaflow v0.1.0 的产品范围、用户流程、功能需求、数据边界、Workspace 模型、安全边界和验收标准。

本版本的目标不是实现“PRD 到生产上线”的完整自动化，而是先建立稳定的执行内核：把一份人工确认的 Task Contract 转换为一次隔离、可验证、可恢复的 Codex 执行，并把多个独立 Git 仓库中的结果组织为 ChangeSet。

本文是 v0.1.0 开发、测试和验收的唯一产品基线。

---

## 2. 背景与问题

当 Codex 参与真实项目开发时，仅依赖聊天上下文或单个应用仓库中的零散说明，会出现以下问题：

1. 项目知识无法在多人之间稳定共享。
2. 前端、后端、Worker 和基础设施分属多个仓库，Agent 缺少统一项目视图。
3. Agent 容易直接修改开发者当前工作区，污染人工未提交变更。
4. 多个任务缺少固定的多仓库版本基线，结果难以复现。
5. Agent 可能声明“完成”，但测试、路径范围或验收条件并未真正通过。
6. 多仓库变更缺少统一的逻辑变更单元。
7. 执行失败后缺少结构化状态、证据和恢复路径。

Scaflow 通过“项目控制仓库 + 多仓库 Workspace + Task Contract + Verification + ChangeSet”解决这些问题。

---

## 3. 产品定义

Scaflow 是一个面向 AI Coding Agent 的项目级开发操作系统。

一个被 Scaflow 管理的项目由以下部分组成：

```text
Scaflow Project Repository
+
One or More Application Repositories
+
Local Workspace
+
Scaflow Engine
+
Codex Runtime
```

### 3.1 Scaflow Engine

通用执行引擎，负责 CLI、配置解析、Git 操作、Workspace 管理、Codex 调用、Verification、状态恢复和 ChangeSet 生成。

### 3.2 Scaflow Project Repository

简称 SPR。它与一个具体项目深度绑定，是项目的控制仓库和知识仓库，保存：

- 产品目标与 PRD；
- 系统架构与 ADR；
- 项目级 `AGENTS.md` 和 Skills；
- Application Repository 清单；
- 开发环境定义；
- Task Contract；
- 跨仓库契约；
- Verification 规则；
- ChangeSet 和完成摘要。

SPR 不保存应用源码。

### 3.3 Application Repository

独立的业务源码仓库，例如 Web、API、Worker、Mobile、Infrastructure 或 Shared Library。

### 3.4 Workspace

SPR 在开发者本地组装多个 Application Repository 的目录。Workspace 不进入 SPR Git。

---

## 4. v0.1.0 产品目标

### G-001：可重复初始化项目开发环境

开发者克隆 SPR 后，执行 `scaflow bootstrap`，可以获得配置中声明的应用仓库及一致的本地 Workspace。

### G-002：共享项目知识体系

团队成员和 Codex 使用同一个 SPR 中的产品、架构、规则、契约和 Task 定义。

### G-003：隔离 Codex 正式任务

正式 Task 不直接修改开发者的基础工作区，而是在独立 TaskRun Bundle 中运行。

### G-004：固定多仓库版本基线

每次 TaskRun 必须记录不可变 Revision Set，明确 SPR 和每个相关 Application Repository 的 Base Commit。

### G-005：机械验证任务结果

任务完成状态由 Scaflow 根据实际 Git Diff、路径权限、命令结果、验收映射和 Agent Result 判断，而不是由 Codex 自行决定。

### G-006：支持多仓库逻辑变更

一个 Task 可以修改 SPR 和多个 Application Repository，并形成统一 ChangeSet。

### G-007：支持失败恢复

Scaflow 重启后可以恢复 TaskRun、Verification 和 ChangeSet 状态；无法继续的运行标记为 `orphaned`。

---

## 5. 非目标

Scaflow v0.1.0 不实现：

- PRD 自动编译；
- 自动生成完整产品规格；
- 自动生成 Task DAG；
- 独立 Reviewer Agent；
- GitHub PR 自动创建与合并；
- 跨机器统一 Lease；
- 中央多项目控制平台；
- 分布式 Worker；
- 自动 Staging 或生产发布；
- 自动灰度和回滚；
- Web 控制台；
- 多模型动态路由；
- Windows 原生支持；
- 多仓库原子提交。

---

## 6. 用户角色

### 6.1 项目创建者

- 创建 SPR；
- 配置项目和应用仓库；
- 固定 Scaflow Engine 版本；
- 提交初始项目知识。

### 6.2 项目维护者

- 维护 SPR；
- 维护 Task Contract、Policy 和 Workflow；
- 审查高风险控制面变更；
- 管理 ChangeSet 生命周期。

### 6.3 项目开发者

- 克隆 SPR；
- 初始化 Workspace；
- 执行和检查 Task；
- 处理本地失败；
- 发布分支或交由后续工具创建 PR。

### 6.4 Codex Agent

- 读取 TaskRun 中的任务上下文；
- 修改被授权的 Worktree；
- 执行被允许的命令；
- 返回结构化 Agent Result；
- 根据 Verification Failure 进行有限修复。

---

## 7. 核心术语与状态

### 7.1 Task

团队共享的工作定义，保存在 SPR 中。

Task Definition State：

```text
draft
ready
cancelled
completed
```

`completed` 表示相关 ChangeSet 已合并，而不是本地执行已经成功。

### 7.2 TaskRun

Task 的一次本地执行，保存在 `.scaflow/state.db`。

TaskRun State：

```text
queued
preparing
running
verifying
repairing
succeeded
failed
blocked
cancelled
orphaned
```

### 7.3 ChangeSet

一次 TaskRun 在一个或多个仓库中产生的逻辑变更集合。

ChangeSet State：

```text
draft
verified
published
partially_merged
merged
failed
cancelled
rolled_back
```

### 7.4 Revision Set

TaskRun 开始时冻结的多仓库版本集合。

示例：

```yaml
control: abc123
repositories:
  web:
    commit: def456
    access: read-only
  api:
    commit: ghi789
    access: read-write
```

TaskRun 执行过程中不得自动跟随远程分支更新。

---

## 8. 目录模型

一个标准 SPR 的本地结构：

```text
project-scaflow/
├── .git/
├── scaflow
├── scaflow.yaml
├── repositories.yaml
├── AGENTS.md
├── PRODUCT.md
├── ARCHITECTURE.md
├── docs/
├── tasks/
├── changesets/
├── policies/
├── workflows/
├── environments/
├── skills/
├── plugins/
│
├── workspace/                # Git ignored
│   ├── repos/                # 开发者长期工作区
│   └── runs/                 # TaskRun隔离工作区
│
└── .scaflow/                 # Git ignored
    ├── state.db
    ├── logs/
    ├── evidence/
    ├── artifacts/
    ├── cache/
    ├── locks/
    └── tmp/
```

### 8.1 `workspace/repos/`

- 所有者：开发者；
- 生命周期：长期；
- 用途：日常开发、浏览、调试、Fetch；
- Scaflow 不自动 Reset；
- Scaflow 不删除未提交变更；
- Scaflow 不自动切换开发者当前分支；
- 正式 Codex Task 不直接修改这里。

### 8.2 `workspace/runs/`

- 所有者：Scaflow Engine；
- 生命周期：TaskRun 级；
- 用途：隔离多仓库 Worktree、任务上下文和验证；
- Codex 根据 Task Contract 访问；
- 满足清理条件后可删除。

### 8.3 `.scaflow/`

- 所有者：Scaflow Engine；
- 保存本地状态、日志、Evidence、缓存和锁；
- 不保存 Application Repository 源码；
- 不提交 Git。

---

## 9. TaskRun Bundle

标准结构：

```text
workspace/runs/<task-id>/<task-run-id>/
├── AGENTS.md
├── task-contract.yaml
├── context-manifest.json
├── revision-set.yaml
├── context/
├── control/                  # 仅@control read-write时创建
├── repos/
│   ├── web/
│   └── api/
└── runtime/
```

TaskRun Bundle 根目录不是 Git 仓库。

所有 Git 和验证命令必须绑定具体 Repository ID，禁止依赖当前目录执行隐式 `git` 或构建命令。

### 9.1 `@control`

`@control` 是 SPR 的保留仓库 ID。

规则：

- Application Repository ID 不允许以 `@` 开头；
- `@control` 未声明时，只生成必要知识快照；
- `@control` 为 `read-only` 时，只生成只读知识快照；
- `@control` 为 `read-write` 时，创建独立 SPR Worktree。

### 9.2 Application Repository 访问模式

- `read-only`：使用固定 Commit 的 Detached HEAD Worktree，任何 Diff 都视为失败；
- `read-write`：使用任务分支 Worktree，允许路径仍受 Scope Policy 限制。

---

## 10. 主用户流程

### 10.1 创建 Scaflow Project Repository

```bash
scaflow init beauty-ai
```

结果：生成 SPR 目录、固定 Engine 版本、初始化 Git，并创建项目级配置和知识结构。

### 10.2 初始化本地 Workspace

```bash
./scaflow bootstrap
```

结果：

1. 验证 `repositories.yaml`；
2. 创建 `workspace/repos/`；
3. 克隆缺失仓库；
4. Fetch 已存在仓库；
5. 保留开发者未提交修改；
6. 生成 Workspace Manifest；
7. 执行环境 Doctor。

### 10.3 创建并验证 Task

```bash
./scaflow task validate TASK-AUTH-006
```

Task Contract 必须处于 `ready`，并通过 Schema 与语义校验。

### 10.4 准备 TaskRun

```bash
./scaflow task prepare TASK-AUTH-006
```

结果：

1. 创建 TaskRun；
2. 解析仓库 Scope；
3. 生成 Revision Set；
4. 创建相关 Worktree；
5. 生成 TaskRun Bundle；
6. 生成运行时 `AGENTS.md` 和 Context Manifest。

### 10.5 运行 Task

```bash
./scaflow task run TASK-AUTH-006
```

结果：启动 Codex，捕获事件和 Agent Result，并进入 Verification。

### 10.6 修复循环

对于可恢复失败：

```text
Codex Run
→ Verification Failure
→ Failure Summary
→ Continue Session
→ Re-verify
```

超过策略上限后 TaskRun 进入 `blocked` 或 `failed`。

### 10.7 生成 Commit 和 ChangeSet

Verification 全部通过后：

1. 每个变更仓库创建独立 Commit；
2. 记录 Base Commit 和 Result Commit；
3. 生成 ChangeSet；
4. TaskRun 标记为 `succeeded`；
5. ChangeSet 标记为 `verified`。

v0.1.0 默认不自动 Push 和创建 PR。

---

## 11. 功能需求

### FR-001：初始化 SPR

命令：

```bash
scaflow init <project-name>
```

必须生成：

- `scaflow.yaml`；
- `repositories.yaml`；
- `AGENTS.md`；
- `PRODUCT.md`；
- `ARCHITECTURE.md`；
- `docs/`；
- `tasks/`；
- `changesets/`；
- `policies/`；
- `workflows/`；
- `environments/`；
- `skills/`；
- `plugins/`；
- `.gitignore`；
- `scaflow` 薄启动器。

验收条件：

- FR-001-AC-01：空目录初始化后通过 `scaflow validate`；
- FR-001-AC-02：`workspace/` 与 `.scaflow/` 不被 Git 跟踪；
- FR-001-AC-03：重复初始化不会覆盖用户已修改文件；
- FR-001-AC-04：项目通过依赖固定 Scaflow Engine 版本。

### FR-002：Repository Manifest

`repositories.yaml` 只声明 Application Repository。

每项至少包含：

- ID；
- 名称；
- Git URL；
- 默认分支；
- Checkout Directory；
- Repository Type；
- 可选结构化命令。

验收条件：

- ID 唯一；
- ID 不以 `@` 开头；
- Checkout Directory 唯一；
- 不允许绝对路径；
- 不允许路径穿越；
- 依赖引用的仓库必须存在。

### FR-003：Bootstrap

命令：

```bash
./scaflow bootstrap
```

要求：

- 幂等；
- 已存在且远程一致时执行 Fetch；
- 不覆盖未提交修改；
- 不自动 Reset；
- 不自动切换分支；
- 单仓库失败不破坏其他成功仓库；
- 二次执行可继续失败部分。

### FR-004：Doctor

命令：

```bash
./scaflow doctor
./scaflow doctor --json
```

检查：

- Node.js；
- pnpm；
- Git；
- Codex Runtime；
- Scaflow Engine 版本；
- SPR Schema；
- Workspace；
- Repository Identity；
- 环境变量；
- 可选 Docker。

结果级别：

```text
PASS
WARN
FAIL
SKIP
```

### FR-005：Task Contract

稳定路径：

```text
tasks/<task-id>/contract.yaml
```

必须包含：

- Task ID；
- 标题；
- 类型；
- 风险等级；
- Definition State；
- 目标；
- 来源需求；
- Repository Scopes；
- Allowed Paths；
- Forbidden Paths；
- Acceptance Criteria；
- Verification Commands；
- Retry Policy。

### FR-006：TaskRun Preparation

系统必须：

- 生成唯一 TaskRun ID；
- 解析 Repository Scopes；
- 固定 Revision Set；
- 创建 `read-only` 或 `read-write` Worktree；
- 创建 TaskRun Bundle；
- 校验 Repository Identity；
- 生成 TaskRun 根 `AGENTS.md`；
- 记录到 SQLite。

### FR-007：Context Assembler

生成：

- `context-manifest.json`；
- TaskRun 根 `AGENTS.md`；
- 必要知识快照。

必须包含：

- SPR 项目规则；
- Task Contract；
- 授权仓库；
- 仓库局部规则摘要；
- 相关规格、ADR 和契约；
- Verification Commands；
- 禁止操作；
- 上一次失败摘要。

不得包含：

- Secret；
- 无关仓库源码；
- 其他 TaskRun；
- 本地 SQLite；
- 用户完整 Home。

### FR-008：Codex Runtime

主通道：`@openai/codex-sdk`。

降级通道：`codex exec`。

必须支持：

- Working Directory；
- Session ID；
- 流式事件；
- 最终 Agent Result；
- Continue Session；
- Cancel；
- Timeout；
- 日志脱敏。

### FR-009：结构化命令

所有 Engine 执行的项目命令必须采用：

```yaml
repository: api
executable: pnpm
args:
  - test
timeout_seconds: 900
required: true
```

默认禁止任意 Shell 字符串。

显式 Shell 模式必须提高风险等级并经过 Command Policy。

### FR-010：Scope Verification

Scaflow 必须比较：

```text
Task允许的Repository和Path
vs
Git实际Diff
```

以下情况立即失败：

- 修改未授权仓库；
- 修改 `read-only` 仓库；
- 修改未授权路径；
- 修改受保护控制文件；
- 修改其他 TaskRun；
- Repository Identity 不匹配。

### FR-011：Command Verification

根据 Task Contract 在对应仓库 Worktree 中执行结构化命令。

要求：

- 固定 Working Directory；
- 参数数组执行；
- Timeout；
- 环境变量白名单；
- stdout/stderr 截断与 Artifact 保存；
- 明确 Exit Code。

### FR-012：Test Integrity Verification

MVP 至少检查：

- 删除测试；
- 增加 Skip 或 Only；
- 修改验证命令；
- 修改质量门禁；
- 修改受保护测试目录；
- 降低覆盖率阈值。

### FR-013：Agent Result Verification

Agent Result 必须符合 Schema，并包含：

- Status；
- Summary；
- Changed Files 声明；
- Commands Run 声明；
- Acceptance Mapping；
- Known Limitations；
- Decision Requests；
- Risks Detected。

Scaflow 必须以真实 Git Diff 和实际 Command Result 为准，不能信任 Agent 自报结果。

### FR-014：Repair Loop

默认策略：

```yaml
max_attempts: 2
max_repair_rounds_per_attempt: 3
escalate_after_same_failure: 2
```

不可自动修复：

- Repository Identity Mismatch；
- 未授权仓库修改；
- 受保护控制文件修改；
- Secret 暴露；
- Task Contract 无效；
- Workspace 损坏。

### FR-015：Commit Generation

Verification 通过后，对每个变更仓库创建独立 Commit。

Commit Message 必须包含：

- Task ID；
- TaskRun ID；
- Requirement IDs；
- Acceptance Criterion IDs。

v0.1.0 不自动 Push。

### FR-016：ChangeSet

ChangeSet 必须记录：

- Task ID；
- TaskRun ID；
- 每个仓库的 Base Commit；
- 每个仓库的 Result Commit；
- 变更文件；
- Verification Result；
- Merge Order；
- 状态；
- 可选 Remote Branch 和 PR 字段。

ChangeSet 不承诺跨仓库原子性。

### FR-017：状态恢复

SQLite 至少保存：

- Project；
- Task；
- TaskRun；
- Agent Session；
- Verification Run；
- ChangeSet；
- Event；
- Schema Migration。

Engine 启动时：

1. 检查非终态 TaskRun；
2. 检查对应进程和 Workspace；
3. 可继续则恢复；
4. 不可继续则标记 `orphaned`；
5. 保留日志和 Evidence。

### FR-018：Workspace 清理

命令示例：

```bash
./scaflow run inspect <run-id>
./scaflow run clean <run-id>
./scaflow run clean --completed
./scaflow run clean --older-than 7d
```

规则：

- 不清理运行中 TaskRun；
- 有未提交 Diff 时不静默删除；
- 删除前保存 Diff、日志和 Evidence；
- 不得删除 `workspace/repos/`；
- `.scaflow/state.db` 不得被普通清理命令删除。

---

## 12. CLI 范围

v0.1.0 最低命令集：

```text
scaflow init
scaflow validate
scaflow bootstrap
scaflow doctor

scaflow repo status
scaflow workspace status
scaflow workspace sync

scaflow task list
scaflow task show
scaflow task validate
scaflow task prepare
scaflow task run
scaflow task status
scaflow task cancel

scaflow run inspect
scaflow run clean

scaflow changeset show
scaflow changeset list
```

`push`、PR、Review、Merge 和 Release 命令不属于 v0.1.0 必须范围。

---

## 13. 安全要求

### SEC-001：文件系统隔离

Codex 只能访问当前 TaskRun Bundle 和被允许的临时资源。

禁止访问：

- 其他 TaskRun；
- 用户完整 Home；
- SSH Key；
- 云凭证；
- 生产 Secret；
- `.scaflow/state.db`；
- Scaflow Engine 源码；
- Docker Socket。

### SEC-002：网络边界

区分：

- 控制面网络：Engine 调用 Codex 服务；
- Agent 命令网络：项目命令访问外网。

Agent 命令网络默认关闭。Bootstrap 阶段可按白名单访问包仓库。

### SEC-003：控制面保护

普通业务 Task 不得修改：

- `policies/security.yaml`；
- `policies/command-policy.yaml`；
- Engine 版本；
- 核心 Schema；
- 核心 Workflow；
- 发布权限；
- 审批记录。

修改这些内容必须使用 `control-plane-change` Task，风险等级不低于 R2。

### SEC-004：Secret 管理

Secret 不进入：

- Task Contract；
- Prompt；
- Agent Result；
- 普通日志；
- Git 仓库。

---

## 14. 非功能需求

### NFR-001：平台支持

MVP 支持：

- macOS；
- Linux；
- Node.js 22；
- Git 2.40+。

### NFR-002：幂等性

- `init` 不覆盖已有文件；
- `bootstrap` 可重复执行；
- `task prepare` 不得创建重复 Worktree；
- 状态转换在事务中执行；
- Commit 生成需检查当前状态。

### NFR-003：可审计

记录：

- TaskRun 状态变化；
- Codex Session；
- 命令；
- Diff；
- Verification；
- Commit；
- ChangeSet；
- Failure Classification。

### NFR-004：性能目标

不包含 Clone、依赖下载和真实 Codex 推理时间：

- `scaflow validate`：P95 小于 2 秒；
- `scaflow task status`：P95 小于 1 秒；
- TaskRun Bundle 准备：中小型仓库 P95 小于 15 秒。

### NFR-005：可测试性

必须提供：

- Mock Codex Runtime；
- 临时 Git Repository Fixture；
- Fake Command Runner；
- Workspace Fixture；
- 故障注入能力。

---

## 15. 多人协作边界

v0.1.0 支持：

- 多人共享 SPR；
- 多人共享项目知识和 Task 定义；
- 多人各自初始化本地 Workspace；
- 多人处理不同 Task；
- 通过 Git 分支和 ChangeSet 协调。

v0.1.0 不支持：

- 跨机器全局 Lease；
- 中央 Task Scheduler；
- 自动阻止两个人同时执行同一个 Task；
- 全局实时 Agent Session 状态。

项目团队应在 Task Contract 或项目管理系统中标记 Assignee，并通过分支和评审避免重复执行。

---

## 16. 数据与事实归属

### 进入 SPR Git

- PRD；
- Product Specification；
- Architecture；
- ADR；
- Repository Manifest；
- Task Contract；
- Completion Summary；
- ChangeSet Manifest；
- 跨仓库契约；
- 项目级 Policy 和 Workflow。

### 进入 Application Repository Git

- 业务代码；
- 本仓库测试；
- 本仓库构建配置；
- 本仓库局部文档；
- 本仓库生成代码。

### 只进入 `.scaflow/`

- TaskRun 实时状态；
- Agent Session；
- 命令日志；
- Verification 临时结果；
- Token 和成本；
- Lock；
- Heartbeat；
- 临时 Artifact。

---

## 17. MVP 验收场景

Scaflow v0.1.0 必须完成以下端到端演示：

1. 使用 `scaflow init` 创建一个 SPR；
2. 在 `repositories.yaml` 中声明 `example-web` 和 `example-api`；
3. 新开发者执行 `bootstrap` 获得 `workspace/repos/web` 和 `workspace/repos/api`；
4. 创建一个同时涉及 `@control`、`web` 和 `api` 的 Task；
5. `task prepare` 创建固定 Revision Set 和隔离 Worktree；
6. Mock Runtime 或真实 Codex 修改前端与后端；
7. 第一次运行故意修改未授权路径，Scope Verifier 阻断；
8. 第二次运行保留一个测试失败，Repair Loop 修复；
9. 所有 Required Verification 通过；
10. 分别为 SPR、Web、API 创建 Commit；
11. 生成包含三个仓库的 ChangeSet；
12. 重启 Scaflow 后仍能查看完整 TaskRun 和 ChangeSet；
13. 清理 TaskRun 前保存 Evidence；
14. `workspace/repos/` 中开发者的未提交修改始终未被影响。

---

## 18. 发布标准

v0.1.0 可以发布，必须满足：

- 全部 FR 的 Required Acceptance Criteria 通过；
- 核心状态机测试通过；
- Git Worktree 集成测试通过；
- Scope 越界测试通过；
- Test Integrity 测试通过；
- Codex Runtime Contract Test 通过；
- Engine 重启恢复测试通过；
- MVP 端到端场景通过；
- 无已知 Critical 或 High 安全问题；
- 用户文档覆盖 init、bootstrap、task、run、changeset 和 clean。

---

## 19. 后续版本

### v0.2.0：Specification Compiler

```text
PRD
→ Requirement
→ Acceptance Criteria
→ Task DAG
```

### v0.3.0：Review and Git Integration

- Independent Reviewer；
- GitHub PR；
- Merge Queue；
- 远程 ChangeSet 状态。

### v0.4.0：Release Pipeline

- Staging；
- Release Evidence；
- Production Approval；
- Rollback。

### v1.0.0：PRD to Production

实现从 PRD 到生产上线的完整闭环。

---

## 20. 产品成功指标

v0.1.0 重点评估执行内核，而不是业务规模：

- TaskRun 首次成功率；
- 平均 Repair Round；
- Scope Violation 捕获率；
- Test Integrity Violation 捕获率；
- TaskRun 恢复成功率；
- Workspace 污染事件数；
- ChangeSet 生成成功率；
- 单任务人工介入次数；
- 单任务平均执行时长；
- 单任务 Token 和成本。

核心成功标准：正式 Codex Task 不污染 `workspace/repos/`，并能在固定 Revision Set 上形成可验证的多仓库 ChangeSet。
