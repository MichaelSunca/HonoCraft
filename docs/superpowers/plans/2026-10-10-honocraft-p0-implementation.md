# HonoCraft P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Follow each task's red/green verification and record evidence in `docs/verification/implementation-progress.md`.

**Goal:** 完成 PRD 全部 P0 能力及源码模板交付，以真实数据库、浏览器和恢复验证证明可用。

**Architecture:** Hono 模块化单体 + 同源 React SPA，PostgreSQL 保存身份、权限、审计、任务与幂等事实。web/worker 同版本发布，事务协调锁保护撤权与管理一致性。

**Tech Stack:** Node.js 24、pnpm 10、TypeScript strict、Hono 4、React 19、PostgreSQL 17、Drizzle、Zod、Vitest、Playwright、Docker Compose。

**Spec:** [详细设计](../specs/2026-10-10-honocraft-detailed-design.md)、[架构](../specs/2026-10-10-honocraft-architecture-design.md)、[PRD](../specs/2026-10-10-honocraft-prd.md)。

## Global Constraints

- 一实例一个数据域；P0 不包括 OAuth/MFA/计费/多租户。
- Cookie 服务端会话；所有受保护请求确认数据库当前状态与 epoch。
- 成功审计、授权更新、会话撤销、相关 outbox 同事务提交。
- 邮箱唯一含软删除；一次性凭证只保存摘要，任务敏感载荷加密。
- 用户角色变化成功后旧 session 的下一请求失败；写入与撤权遵守协调锁。
- 保留最后一名可用超级管理员；本人后台角色/状态/删除不可操作。
- PG 17 真实集成测试，不用内存数据库替代锁与事务验证。
- 37 项 P0 验收必须逐项有证据；未运行或未实现不得标完成。

## Review Focus

- 两个数据库连接交错撤权与写入：只有写入先提交或撤权后拒绝两种结果（Task 5/7）。
- SMTP 受理后进程中断：租约接管不能被旧 worker 回写，最多三次尝试（Task 4）。
- 默认注册角色/邀请角色后续变化：不能间接提权或自动换角色（Task 6/7）。
- 响应丢失、同键换正文与撤权后重试：副作用不重复，旧结果不绕权（Task 3/7）。
- 备份恢复或文件附着/回收竞争：旧凭证不复活、当前文件不误删（Task 8/11）。

## Task 1: 工程基座与严格配置

**Files:** root manifests/tsconfig/eslint/vitest; `packages/contracts/src/{common,errors}.ts`; `apps/server/src/infrastructure/config.ts`; `tests/unit/config.test.ts`.
**Interfaces:** Produces `loadConfig(input: NodeJS.ProcessEnv): AppConfig`、稳定 AppError、分页与身份字段 schema。

- [ ] 写配置测试：生产 HTTP、开发邮件、缺失秘密、非法数字、未知开关拒绝；开发合法配置通过。
- [ ] 运行 `pnpm test -- tests/unit/config.test.ts`，确认目标行为失败。
- [ ] 实现配置、workspace、严格共享 DTO 与工具入口；补准确环境示例。
- [ ] 运行配置测试及 `pnpm typecheck`，预期全部通过。

## Task 2: 数据迁移、目录与事务工具

**Files:** `db/migrations/0001_core.sql`; `db/schema/index.ts`; `apps/server/src/infrastructure/{db,migrations}.ts`; `scripts/migrate.ts`; `tests/integration/migrations.test.ts`.
**Interfaces:** Consumes AppConfig; produces `Database`、`withTransaction(mode, callback)`、`migrate(pool)`、版本化权限目录。

- [ ] 写真实 PG 测试：迁移重复执行、唯一邮箱含 Deleted、Token 摘要、Pending 邀请唯一、审计账号不能删除日志。
- [ ] 运行 `pnpm test:integration -- migrations`，确认数据库约束尚不存在。
- [ ] 实现表/索引/FK/checksum 迁移，种子只含内建角色/目录/设置，不建账号。
- [ ] 运行迁移测试，预期全过且多次迁移无重复种子。

## Task 3: 授权、事务入口、审计与幂等

**Files:** `modules/access/{catalog,policy,mutation-gateway}.ts`; `modules/audit/*`; `infrastructure/{rate-limit,idempotency}.ts`; unit/integration policy tests.
**Interfaces:** Produces `can`、`assertManageableTarget`、`assertGrantableRoles`、`authorizeMutation`、`appendAudit`、操作结果查询。

- [ ] 写策略/DB 测试：自定义管理者完整范围、保留权限、本人保护、依赖闭包、同键重放/换正文、审计失败回滚。
- [ ] 运行相关测试，确认无规则实现时失败。
- [ ] 实现安全锁/锁后时间/超时，成功与失败审计分离，限流持久化，24h 幂等记录。
- [ ] 集成验证副作用一次、权限重查、无秘密入日志。

## Task 4: 邮件 outbox 与 worker

**Files:** `modules/mail/*`; `infrastructure/crypto.ts`; `entrypoints/worker.ts`; `tests/integration/mail-worker.test.ts`.
**Interfaces:** Produces `enqueue(tx,event)`、`claimTasks`、`runDelivery`、模板/脱敏状态查询。

- [ ] 写 SMTP 成功/拒绝/超时及租约测试，重复领取只一持有者，旧租约 CAS 失败。
- [ ] RED 后实现 AES-GCM、三次退避、失效凭证检查、终态载荷清除、双语模板。
- [ ] 终止子进程并接管租约，确认不永久 Sending，不承诺供应商恰好一次。

## Task 5: 初始化、密码、会话与 HTTP 安全

**Files:** `modules/auth/*`; `http/*`; `entrypoints/{web,ops}.ts`; auth/browser-security integration tests.
**Interfaces:** Consumes gateway/outbox; produces session authentication、CSRF、近期验证、bootstrap CLI、健康接口。

- [ ] RED：无默认密码、bootstrap 只能一次、Pending 无会话、Origin/CSRF 检查、过期/撤销/epoch 不一致拒绝。
- [ ] 实现 Argon2id、dummy hash、限流、Cookie、当前会话 reauth 与会话列表/撤销。
- [ ] 两连接验证撤权后请求失败、不同设备不共享近期验证。

## Task 6: 注册、验证、密码重置与邮箱变更

**Files:** auth/user application services and routes; `tests/integration/account-lifecycle.test.ts`.
**Interfaces:** Produces PRD 身份公开接口、profile/me/password/email-change。

- [ ] RED：统一防枚举、原始注册角色复核、Token GET 不消费/POST 单次、改密撤销全会话、换邮箱竞争。
- [ ] 实现一次性 Token 生命周期与原子激活/重置/邮箱替换，邮箱请求替换/取消/Pending 修正。
- [ ] 验证旧 hash 不能覆盖并发密码、旧邮箱链接失效、禁用不能借验证激活。

## Task 7: 用户、角色、邀请与管理设置

**Files:** `modules/{users,invitations,access/roles,settings}/*`; management/concurrency tests.
**Interfaces:** Produces 全部管理 API、allowed_actions、完整版本冲突与确认 DTO。

- [ ] RED：管理员不能接管高权限目标、最后管理员并发、角色引用、权限改变同步撤销全量 session。
- [ ] 实现用户状态/软删、角色/资格、邀请创建/重发/撤销/接受，设置整组更新。
- [ ] 验证 Pending 角色引用与邀请版本、发送配额/幂等、高权限确认及只读脱敏。

## Task 8: 媒体及可移除笔记

**Files:** `modules/{files,example-notes}/*`; file/notes tests.
**Interfaces:** Produces 受控文件存储与读取、owner-scoped CRUD、模块开关/目录同步。

- [x] RED：伪图片/超限/SVG、授权失败保留原头像、两用户及超管不能跨 owner。
- [x] 实现 sharp 重编码、staged/attached/orphaned/deleting、版本与审计；实现笔记 CRUD。
- [ ] 验证文件回收竞态、模块禁用 API/菜单无残留及显式裁剪迁移。

## Task 9: React 管理端和认证页面

**Files:** `apps/web/src/{app,components,features,locales}/*`; `tests/e2e/*`.
**Interfaces:** Consumes 所有严格 API schemas; produces React Router 页面、Query 缓存、i18n/主题/表单。

- [ ] 写浏览器旅程：bootstrap 邮件设密→登录→邀请→分配/撤权→审计；账号安全与无权限直接 URL。
- [ ] RED 后实现完整页面、表单错误/冲突、近期验证不自动重放、幂等不明结果恢复。
- [ ] 验证移动核心流程、键盘、双语、深色模式、跨账号缓存清除。

## Task 10: OpenAPI、开发入口、Compose 与 CI

**Files:** `scripts/*`; `deploy/*`; `.github/workflows/ci.yml`; `docs/{QUICKSTART,CONFIGURATION,API}.md`.
**Interfaces:** Produces 架构要求的准确 pnpm commands，生产 web/worker 单镜像、Caddy HTTPS、Mailpit 开发捕获。

- [ ] 为 env:check/dev:reset/路由目录写行为测试，未知 API 不回 SPA、生产危险配置拒绝。
- [ ] 实现命令、Docker、OpenAPI 导出、静态检查与 CI；固定依赖锁。
- [ ] `pnpm check && pnpm test && pnpm test:integration && pnpm build` 全过；Docker 可用时实际构建验证。

## Task 11: 升级、备份恢复与容量

**Files:** ops services/scripts; `tests/{migrations,recovery,performance}/*`; `docs/{OPERATIONS,UPGRADING,MODULES}.md`.
**Interfaces:** Produces 加密一致备份/manifest、外部 epoch 轮换、恢复核实、留存维护与监测。

- [ ] RED：还原旧凭证仍拒绝、只换镜像不被当安全回滚、旧库权限/自定义数据保留。
- [ ] 实现维护模式流程、备份/恢复/rotate-epoch/recover、checksum/媒体核对。
- [ ] 运行真实恢复与性能用例，记录条件、错误率及 P95；达不到目标记真实差距。

## Task 12: 全量验收与独立评审

**Files:** `docs/verification/*`; README、支持矩阵、许可说明与变更记录。
**Interfaces:** Consumes 所有 task evidence; produces 37项 P0 验收矩阵、已知限制和可复现发布包。

- [ ] 按 PRD 每项逐个核验证据；未运行不标通过。
- [ ] 进行完整新上下文代码评审，修复安全/正确性问题并增加对应回归测试。
- [ ] 完成新副本启动、模块接入、示例裁剪试用；真实部署者配置/许可选择仍需其提供时明确记录。
- [ ] 全套验证完成且没有必要工作剩余，才将开发目标标为完成。
