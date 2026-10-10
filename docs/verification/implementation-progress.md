# Implementation ledger — plan: docs/superpowers/plans/2026-10-10-honocraft-p0-implementation.md

## Scope

2026-10-10 用户要求“开发”，按 PRD/架构/详细设计实现全部 P0，执行方式为当前会话逐任务实现。37 项 P0 验收与完整发布物仍是目标，不把基座或局部测试通过等同完成。

## Initial evidence

- 工作区仅有 specs 下三份设计文档；不是 Git 仓库，没有已有业务源码。
- 普通 agent executor 除 pwd 外在进程启动前失败；显式 /bin/bash + 当前工作目录 + 经自动审核的提升执行可运行命令。
- WSL Ubuntu 24.04 x86_64；初始没有 Node/pnpm/Docker/PostgreSQL。
- Node.js 24.21.0 官方二进制下载到 .tools，已核对官方 SHA-256。
- PRD 已被移到 specs 目录，架构/详细设计仍用旧相对链接，将修复为同目录。

## Rulings

- 无 Git 仓库，不创建虚构 worktree；在用户指定工作区开发，保留全部现有文档。
- 使用用户当前“开发”指令执行已提供规格并记录实施计划，不重新请求每一阶段开发许可。
- 没有 Docker 的当前环境采用项目本地真实 PostgreSQL 17 进程执行集成测试；生产 Compose 交付仍保留，Docker 验证单列证据。
- 不引入业务假数据/内存身份存储替代 PG 安全事实。

## Pre-flight

- Task 1 AppConfig → Task 2 DB/Task 4 crypto/Task 5 HTTP：统一通过显式配置对象注入，无模块 import 时读取秘密。
- Task 2 Tx → Tasks 3–8：Repository 必须接收相同事务；安全锁先于角色/会话写入。
- Task 3 catalog/gateway → Tasks 5–9：权限 Code/DTO 来自 contracts，不让前端身份承担服务端授权。
- Task 4 outbox → Tasks 5–7：仅入队与业务同事务，SMTP 在 worker 事务外。
- Task 5 credentials → Task 11 restore：每次校验 epoch，恢复先停全部旧进程。

## Tasks

Task 1: in progress — preparing toolchain, configuration tests and workspace.
Task 2–12: pending.
