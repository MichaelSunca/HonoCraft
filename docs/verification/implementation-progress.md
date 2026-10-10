# Implementation ledger — plan: docs/superpowers/plans/2026-10-10-honocraft-p0-implementation.md

## Scope

2026-10-10 用户要求“开发”，按 PRD/架构/详细设计实现全部 P0，执行方式为当前会话逐任务实现。37 项 P0 验收与完整发布物仍是目标，不把基座或局部测试通过等同完成。

## Initial evidence

- 工作区仅有 specs 下三份设计文档；不是 Git 仓库，没有已有业务源码。
- 普通 agent executor 除 pwd 外在进程启动前失败；显式 /bin/bash + 当前工作目录 + 经自动审核的提升执行可运行命令。
- WSL Ubuntu 24.04 x86_64；初始没有 Node/pnpm/Docker/PostgreSQL。
- Node.js 24.21.0 官方二进制下载到 .tools，已核对官方 SHA-256。
- PRD、架构、详细设计现已统一在 specs 目录，引用已修复。

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

Task 1: 基座、配置/契约校验已实现；单元测试覆盖配置、契约、权限策略与加密工具。
Task 2: SQL 迁移、事务预算与真实 PG 约束测试已实现；Drizzle schema 映射及升级完整验证待补。
Task 3: in progress — 权限策略已实现，正在接入统一写入口、审计、幂等及限流。
Task 4: 加密 outbox、模板、投递前复核、租约/CAS/重试及 SMTP 已实现；常驻循环、心跳及通知发送限流已实现；到期对象、媒体与留存清理待实现。
Task 5: 会话、Argon2 密码、登录、HTTP Cookie/Origin/CSRF、本人资料与退出已实现；初始化服务、完成接口、Web 进程和密钥加载已实现；初始化 CLI 已实现；初始化页面、近期验证及会话管理 API 待实现。
Task 6–12: pending（README 已补，完整交付未完成）。

## 2026-10-10 continuation evidence

- 首次提交 `5e0e397` 建立项目历史；基础检查通过，50 个单元测试通过；当时集成测试 14/15，通过前插迁移案例确认缺少顺序校验。
- Ruling: 使用当前工作区的 `feat/p0-implementation` 开发分支继续 — 用户要求继续已有开发并在当前目录初始化仓库，保留现有本地工具和数据库测试环境；不重新创建工作树或改动 main 的提交。代价：工作目录仍共享，后续切换分支须保留未提交文件。
- 迁移修复：已应用历史必须是待执行文件的连续前缀，先检查全部历史 checksum，再执行新迁移；拒绝历史前插而不写入。
- `pnpm test:integration -- migrations` 实际运行两个 integration 文件，15/15 通过（Vitest 的脚本参数写法没有仅筛选 migrations；后续使用 `pnpm exec vitest run --project integration <path>`）。
- 会话 RED：15/15 失败；实现后 `pnpm exec vitest run --project integration tests/integration/sessions.test.ts` 15/15 通过，`pnpm check` 通过。
- 会话验证覆盖原期限、策略收紧、epoch、授权版本、用户状态、撤销、初始化、启用权限目录与单设备近期验证；测试通过不等同登录/HTTP 已实现。
- Ruling: 增加 independent 短事务模式供读取会话、限流及失败事件使用 — 读会话不能先锁 session 再请求安全协调锁；受保护业务写入仍只能经 shared/exclusive 事务。

- 审计/幂等 RED：9 项目标用例先失败；实现后 9/9 通过。测试直接依赖 Zod，已在 workspace 根开发依赖中明确声明，使用现有离线缓存安装。
- 统一写入口 RED：保护规则缺失时用例失败；接入真实 profile 更新后 9/9 通过，`pnpm check` 通过。验证了锁后重鉴权、CSRF、权限、近期验证、目标范围重放、旧版本重试、审计数据库失败回滚。
- Ruling: 幂等首次响应保留接口定义 DTO，历史重放只返回设计规定的最小 operation summary — §9 的各业务响应与 §4.5 的最小重放内容需同时满足；前端必须识别 replayed 标记并刷新目标，不将摘要作为完整 DTO。
- Ruling: users 行使用 FOR UPDATE；角色加载使用 FOR SHARE，角色安全变更由全局 UPDATE 协调锁串行化 — 避免所有拥有同一内建角色的普通资料写因角色行排他锁而互相串行；角色修改用例仍遵守统一锁顺序。

- 共享限流 RED→GREEN：7/7 通过，包括 12 并发最多 5 次受理、事务回滚返还配额、跨 scope 原子扣减、冷却、边界 bucket 和账号锁不延长。测试时间常量修正为显式 UTC，避免本机时区将 sentinel 当成普通 bucket。
- 密码服务 RED→GREEN：5/5 通过；真实 Argon2id 独立随机盐、严格密码边界、未知账号同成本验证、并发 2/队列 10/等待 2 秒。全局假时钟干扰真实哈希测试，改为实际短队列期限验证，保留生产 2 秒默认。
- 登录 RED→GREEN：7/7 通过；密码在事务外校验，事务内重查 hash/password_version、当前状态与账号锁，再创建全新会话并提交审计。IP 配额独立提交，失败不抵消计数。
- HTTP RED→GREEN：8 个真实监听端口用例及 3 个代理 IP 单元用例通过。API 已有 login/me PATCH/logout；验证 host-only Secure Cookie、Origin/CSRF、分块 body 上限、无敏感字段响应、错误安全头、退出与旧会话失效。
- 2026-10-10 全量检查：`pnpm check` 通过；`pnpm test` 60/60；`pnpm test:integration` 68/68，8 个文件，总计约 28 秒。未运行浏览器 E2E、应用构建、Docker、恢复或性能验收；不得标为通过。
- Ruling: 密码服务要求调用方提供已验证版本的离线阻断集，目前测试注入小集合，生产数据集及校验加载尚未交付；HTTP factory 只用于已配置依赖的组装/测试，不提供绕过初始化的默认账号。
- Ruling: 提前完成 Task 5 中不依赖邮件的登录与 HTTP 基础，以验证 Task 3 的真实使用链路；Task 4 outbox 和初始化依赖仍继续实现，不以现有接口替代完整 P0。
- Argon2 接口核对：已安装 `argon2@0.44` 类型与官方项目 https://github.com/ranisalt/node-argon2 。哈希工作因子按已定架构 64 MiB/3 次/parallelism 1 实现，尚未完成目标机器登录 P95 压测。

## 2026-10-10 mail, bootstrap and process startup

- 已实现严格邮件模板、AES-GCM outbox、租约 CAS 完成/回收、最多三次尝试和终态敏感内容清理；SMTP 使用真实本地协议测试，20 秒截止通过销毁连接真正终止活动 SMTP。
- 投递前按六种凭证用途复核当前用户/邀请/角色范围/初始化/epoch；失效凭证取消投递。credentials 测试首次 RED 是 SQL 参数推断错误，不作为业务失败证据；修复后临时让真实检查器返回 null，7 项正向授权测试失败，再恢复实现并通过 9 项用例。
- 本机初始化签发/重发/取消服务与公开一次性完成接口已实现；受限 Web 角色通过 0002 安全定义函数原子完成初始化；无默认密码、不自动登录。初始化 CLI、页面和发送保护仍待补。
- 上一轮完整集成测试日志已核查：109/109，通过 13 个测试文件。其后本轮新增启动校验与进程测试，完整结果另记。
- 密钥加载 RED 16 项失败 → 16/16 通过，覆盖缺失/格式/权限/独立材料/文件别名，以及阻断集版本/摘要/行数。离线样本已固定 SecLists 提交，附原始上游许可与 manifest。
- env:check 子进程测试的初次失败源于 Vitest 不支持 import.meta.resolve；改为 createRequire 解析后观察到真实缺陷：缺失秘密、生产模式和非法参数均错误退出 0（3 失败/1 通过）。实现后 4/4 通过。
- 只读启动兼容性 RED 10 项失败 → 10/10 通过：真实 PG 17、受限 Web/Worker 角色、迁移完整性/校验和、权限属性/依赖与模块开关。0003 仅授予 Worker 读取 migration_history，不赋予迁移写权限。
- Web 实际子进程 RED 4 项失败 → 4/4 通过，覆盖秘密加载、受限账号启动、初始化门禁、拒绝旧库/目录差异，以及 SIGTERM 后关闭数据库连接。已提供 start:web 与 dev:server，暂用 tsx 源码执行；最终编译入口、前端/Worker/dev 组合启动仍待实现。
- 本轮 `pnpm check` 通过；`pnpm test` 83/83。完整集成回归 123/123，通过 15 个文件，耗时约 51 秒。所有浏览器、Docker、恢复、性能与 37 项 P0 全量验收仍未完成。
- 临时运行约定：当前 .env.example 显式禁用 example notes，与已交付数据库目录一致；保留配置层开发默认 true 的最终设计，后续补显式模块目录迁移。启动不得为通过测试而静默改写数据库模块状态。


## 2026-10-10 worker and local initialization command

- 通知配额真实 SMTP RED：7 个同地址通知全部发出，2 项行为测试失败。实现 0004 受限函数后只允许 5 个，剩余任务保持 queued/密文、attempts 退回，下一窗口继续；不同地址独立。Worker 未获 rate_limit_buckets 通用 DML 权限。
- 补充 SQL NULL 租约版本测试先收到 send；将比较改为 IS DISTINCT FROM 后拒绝空/旧版本，且不扣配额。新迁移未提交前修正，不改既有已发布迁移。
- Worker 常驻入口与每秒轮询已实现，两个并发槽、30 秒心跳、启动及每分钟租约回收、SIGTERM 排空且不继续领取。真实 SMTP held fixture 阻塞受理，验证两条 Sending / 两条 Queued、退出后剩余任务由新进程完成。
- Worker 测试首次出现一次短时观察超时与陈旧租约未回收；添加安全时间诊断后未复现。测试等待改用单调时钟，旧进程夹具租约明确过期 5 分钟，连续三次 4/4 通过。未据此声称已证明最初失败原因；常规租约边界仍由 outbox 集成测试覆盖。
- 初始化服务新规则 RED 3 失败/6 通过 → 9/9：已完成时无副作用报告 initialized；重发按当前 60–3600 秒冷却、地址用途 1–5/h、本机来源 1–20/h 同事务扣减。拒绝重发不撤销旧凭证、不递增版本、不留新任务。
- ops:init 已支持 email/resend/cancel+reason、参数互斥、结构化安全结果及退出码。初始 CLI 测试有参数矩阵展开与根工作区契约包解析错误；修正矩阵、将组装放到 server 工作区后 8/8 真实子进程测试通过，包括实际凭证完成后的重复初始化。
- start:worker、dev:worker 与 ops:init 脚本已提供，README 和本地运行说明已同步；入口仍用 tsx 源码执行，编译/镜像/完整 dev 命令待交付。
- 本轮完整回归：`pnpm check` 通过，83/83 单元测试、141/141 集成测试（18 文件，约 77 秒）通过；仍不能声称完整 P0、浏览器、Docker、恢复或性能验收通过。
