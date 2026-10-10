# HonoCraft

面向开发者与小型团队的单租户 SaaS / 企业后台脚手架，提供认证、用户管理、角色权限、安全审计和基础运维能力的设计与实现基础。

每个部署实例服务一个企业或业务系统，支持多个用户与角色。项目不包含多租户隔离、在线订阅或支付功能。

## 当前状态

项目处于 P0 开发阶段，尚未形成可运行的完整后台。

- **设计文档**：已提供产品需求、架构设计和详细设计。
- **已有代码**：工作区配置、共享数据契约与权限目录、配置校验、数据库迁移与事务封装、权限策略、审计、幂等、共享限流、Argon2 密码与会话服务，以及登录、注册、邮箱验证/重发、密码找回/重置、本人资料、退出和初始化完成的 HTTP 接口；已实现加密邮件 outbox、投递租约/重试、SMTP 适配、投递前凭证复核、常驻 Worker、通知发送节流和本机初始化命令。已有单元测试、真实 PostgreSQL、HTTP 和进程集成测试。
- **待完成**：初始化及其他前端页面、近期验证/本人改密/会话管理/邀请/邮箱变更、Worker 到期对象/文件/留存清理、管理接口、前端页面，以及构建、部署、恢复和端到端验收。

目前可用 `pnpm start:web` / `pnpm start:worker` 分别启动服务端和邮件 Worker，`pnpm dev:server` / `pnpm dev:worker` 监听源码变化，`pnpm ops:init` 执行本机初始化。这些入口暂时使用 tsx 运行源码，需要开发依赖。尚无前端，也没有完整的 `dev`、`build` 和生产镜像交付。`test:e2e` 仅预留命令，尚未提供端到端用例。设计文档中的功能与验收指标是交付目标，不代表当前实现已全部通过验收。

## 文档导航

建议按“需求 → 架构 → 详细设计 → 实施计划”的顺序阅读。

| 文档 | 内容 |
| --- | --- |
| [产品需求（PRD）](docs/superpowers/specs/2026-10-10-honocraft-prd.md) | 产品定位、P0 / P1 / P2 范围、业务规则和验收标准 |
| [架构设计](docs/superpowers/specs/2026-10-10-honocraft-architecture-design.md) | 技术选型、模块边界、安全机制和部署结构 |
| [详细设计](docs/superpowers/specs/2026-10-10-honocraft-detailed-design.md) | 数据模型、接口契约、权限算法、业务流程、并发控制与验证设计 |
| [P0 实施计划](docs/superpowers/plans/2026-10-10-honocraft-p0-implementation.md) | 开发任务、依赖关系与验证步骤 |
| [实施记录](docs/verification/implementation-progress.md) | 开发环境、实施约定与阶段记录；任务状态可能滞后，以源码和实际验证结果为准 |

## 技术栈

以下为当前选定的技术栈，部分应用层能力仍待实现。

| 层次 | 技术 |
| --- | --- |
| 运行时与工程 | Node.js 24、pnpm 10、TypeScript、pnpm workspace |
| 服务端 | Hono、Zod、Drizzle ORM / node-postgres |
| 数据库 | PostgreSQL 17 |
| 前端 | React 19、Vite、React Router、TanStack Query、React Hook Form、Tailwind CSS、i18next |
| 安全与媒体 | Argon2、Node.js Crypto、Sharp |
| 邮件 | Nodemailer；设计采用数据库邮件任务与独立 Worker |
| 检查与测试 | ESLint、TypeScript、Vitest；计划使用 Playwright 完成端到端验收 |

架构采用模块化单体、同源浏览器会话，以及共享 PostgreSQL 的 Web / Worker 进程。部署设计见架构与详细设计文档。

## 项目结构

```text
apps/
  server/                 服务端配置、基础设施与业务模块
  web/                    前端工作区，目前仅配置依赖
packages/
  contracts/              共享数据校验、错误定义与权限目录
db/
  migrations/             SQL 迁移
scripts/                  配置检查与迁移入口
data/passwords/           离线密码阻断集、来源清单及上游许可
tests/
  unit/                   单元测试
  integration/            数据库集成测试
  helpers/                临时 PostgreSQL 测试集群工具
docs/
  superpowers/specs/      PRD、架构与详细设计
  superpowers/plans/      实施计划
  verification/           实施与验证记录
.env.example              环境变量示例
```

## 本地开发准备

当前集成测试依赖 Linux x64 PostgreSQL 二进制，适用于 Linux x64 或 WSL Linux x64 环境，并须使用非 root 用户运行。其他平台尚未适配该测试工具。

准备 Node.js 24 和 pnpm 10.34.6，在项目根目录安装依赖：

```bash
pnpm install --frozen-lockfile
```

首次配置时，将 [.env.example](.env.example) 复制为 `.env`，已有配置时直接编辑原文件。填写自己的数据库连接、SMTP 配置、文件目录与密钥文件路径，再检查环境变量：

```bash
pnpm env:check
```

此命令校验配置格式、密钥文件及随版本分发的离线密码阻断集，不连接数据库或 SMTP。可用 `pnpm env:check -- --mode=production` 明确检查生产约束。失败时退出码为 2，仅显示配置字段名。示例中的 `replace-me` 是占位值；`.env` 和 `.local/` 已列入忽略规则。

密钥文件格式及首次生成方法见 [本地运行说明](docs/LOCAL_RUNTIME.md)。启动前需手动执行迁移；服务端只读检查迁移校验和、权限目录与模块开关，一旦不一致便拒绝启动，不自动迁移或覆盖数据库设置。

### 常用检查

```bash
# ESLint 与 TypeScript 检查
pnpm check

# 单元测试
pnpm test

# 真实 PostgreSQL 集成测试
pnpm test:integration
```

集成测试会在 `.local/tests/` 创建隔离的 PostgreSQL 17 临时集群，使用本地端口，并在正常结束时清理。无需预先启动数据库服务，也不使用 `.env` 中的业务数据库连接。测试覆盖配置、契约、权限、加密、迁移约束及事务行为；完整 P0 验收仍待完成。

### 数据库迁移

手动迁移需要事先准备 PostgreSQL 17 数据库，并在 `.env` 中设置 `MIGRATION_DATABASE_URL`：

```bash
pnpm db:migrate
```

初始迁移需要创建扩展、角色、表和授权的相应权限；请使用独立的迁移账号。迁移会建立核心结构、内建角色和权限目录，不创建用户账号或默认密码。应用数据库账号与迁移账号的权限应分开配置。

## P0 交付目标

首版围绕“初始化 → 邀请 → 授权 → 撤权 → 审计”闭环，逐步交付：

- 邮箱密码认证、邮箱验证、密码重置与会话管理。
- 个人资料、用户管理、邀请与 RBAC 权限管理。
- 管理审计、安全事件、邮件任务与系统设置。
- 文件上传、可移除的业务示例及模块接入约定。
- 配置检查、部署、迁移、备份恢复与完整验收记录。

具体规则和验收口径以 [PRD](docs/superpowers/specs/2026-10-10-honocraft-prd.md) 为准，实现细节参见 [详细设计](docs/superpowers/specs/2026-10-10-honocraft-detailed-design.md)。
