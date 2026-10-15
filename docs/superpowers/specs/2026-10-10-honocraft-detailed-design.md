# HonoCraft 详细设计

| 项目 | 内容 |
| --- | --- |
| 版本 / 日期 | v0.1 / 2026-10-10 |
| 需求依据 | [PRD v1.2](2026-10-10-honocraft-prd.md) |
| 架构依据 | [架构设计 v0.1](2026-10-10-honocraft-architecture-design.md) |
| 文档状态 | 详细设计评审稿；用于后续实施计划、接口实现、迁移与测试设计 |
| 本轮范围 | P0；不编写业务代码，不生成数据库，不将设计指标标为已验证 |
| 适用实现 | Hono + TypeScript、React SPA、PostgreSQL、Docker 单机；库与主版本沿用架构建议 |

## 1. 文档定位与设计基线

### 1.1 预期结果

开发者能够依据本文确定每个模块的输入输出、存储约束、状态变化、事务边界、失败行为和验证方式，实现“初始化 → 邀请 → 授权 → 撤权 → 审计”完整闭环。详细设计补全架构的实现决策，不重新选择架构，不扩展为多租户或商业计费平台。

本文没有授权实施，也不是逐任务实施计划。后续实施计划应引用本文，拆分具体文件、开发步骤及测试命令。当前工作区只有设计文档，未建立 Git 仓库；下文源码路径、脚本与测试路径均是待创建的目标路径，不是当前已存在能力。

### 1.2 继承约束

- 模块化单体；同版本 web/worker 两个常驻进程；一个 PostgreSQL 数据库；同源浏览器 Cookie 会话。
- P0 不使用 Redis、JWT 权限快照、独立队列、对象存储、通用工作流或运行时插件。
- 所有保护规则以后端数据库事实为准；成功安全变更、撤权、审计和邮件任务共同提交。
- 用户软删除仍占用邮箱；邀请不预建用户；所有邮件凭证只能消费一次。
- 非超级管理员适用相同委派与目标范围规则，包括通过自定义角色取得管理权限者。
- P1 的 OAuth、MFA、批量邀请只保留边界，不创建空表、按钮或假实现。
- 性能、开发者体验、可访问性与恢复目标继承 PRD，必须在实施后提供实测证据。

### 1.3 本文新增的建议决策

以下是细化建议，不表示用户已逐项批准；变更时应同步接口、数据库及验收。

| 编号 | 细化决定 | 理由与影响 |
| --- | --- | --- |
| DD-01 | API 与数据库状态值统一小写；版本为正整数；时间输出 RFC 3339 UTC | 避免三套枚举与时区语义 |
| DD-02 | 用户新增独立 `password_version`；凭证绑定安全版本，不绑定资料编辑版本 | 昵称更新不应使重置凭证失效；旧密码验证结果不能覆盖新密码 |
| DD-03 | 锁取得后重新获取数据库实时时间；到期条件统一 `now >= expires_at` | 防止等待锁跨越有效期后仍消费凭证 |
| DD-04 | 管理/安全写入必须携带幂等键；登录、近期验证、匿名凭证消费与普通资料/笔记写入除外 | 明确哪些客户端需要保留请求身份 |
| DD-05 | 管理者创建/复制的自定义角色默认不可委派、不可用于注册 | 贯彻 PRD；非超级管理员创建后可能无法继续维护，页面须提示由超级管理员设置资格 |
| DD-06 | 终态邀请重新邀请创建新 ID；仅 Pending 邀请可原 ID 重发 | 历史行为清晰；新邀请不复活旧链接 |
| DD-07 | 头像 256×256 WebP、品牌 Logo 最大边 512、Favicon 32/64 PNG；单文件 2 MiB | 具体化原有图片管线，数值为本轮建议 |
| DD-08 | 受保护写事务内进行权威会话检查；HTTP 层不得先持有会话行锁再取安全锁 | 保持全系统锁顺序 |
| DD-09 | 设置分为 branding、security 两条聚合记录；注册默认角色由独立外键列承载 | 整组版本校验，避免关键角色引用只藏在 JSON 中 |
| DD-10 | 源 IP 配额公开 429；匿名邮箱特定发送配额命中仍统一 202 | 防止通过邮箱冷却与额度响应探测账号活动；管理端可显示明确限流原因 |
| DD-11 | P0 邮箱地址采用 ASCII/ASCII 域名；安全参数只在 §11 范围内调整 | 明确首版输入与最低保护边界，SMTPUTF8 另行扩展 |
| DD-12 | Suspended 先启用再调角色；受保护用户邮箱对无管理范围者掩码展示 | 明确管理顺序与脱敏范围，不增加越权能力 |

### 1.4 不变量与覆盖位置

| 编号 | 不变量 | 详细落点 |
| --- | --- | --- |
| INV-01 | 撤权提交后下一次受保护请求失败 | §4、§6、§8 |
| INV-02 | 成功管理审计写入失败则业务回滚 | §4.4、§10 |
| INV-03 | 邮箱全局唯一、凭证成功消费最多一次 | §3、§7 |
| INV-04 | 并发不能消除最后一名可用超级管理员 | §5.3、§8.2 |
| INV-05 | 超级管理员也受笔记 owner 约束 | §5.4、§13 |
| INV-06 | 备份恢复不能复活旧凭证 | §6.4、§14 |
| INV-07 | 默认角色、邀请角色不能间接扩权 | §5.2、§7.2、§7.3 |
| INV-08 | 普通后台永远不能读取密码、令牌和邮件载荷 | §9、§10、§16 |

## 2. 模块与内部契约

### 2.1 目标文件与职责

所有路径相对于项目根；只列决定模块边界的文件，实施计划再展开组件与测试文件。

| 路径 | 职责与允许依赖 |
| --- | --- |
| `apps/server/src/entrypoints/{web,worker,ops}.ts` | 组装进程、校验配置、关闭资源；不包含业务规则 |
| `apps/server/src/http/{app,route-factory,errors,security-headers}.ts` | Hono 管线、路由清单、稳定错误与响应头 |
| `apps/server/src/modules/auth/{session-service,credential-service,password-service,login-service}.ts` | 会话、凭证和密码认证；不把完整用户实体返回路由 |
| `apps/server/src/modules/access/{policy,mutation-gateway,catalog}.ts` | 纯策略、事务授权入口、版本化权限定义 |
| `apps/server/src/modules/users/{service,email-change-service,repository}.ts` | 用户聚合、邮箱流程、显式事务查询 |
| `apps/server/src/modules/invitations/{service,repository}.ts` | 邀请状态、角色快照、接受与重新邀请 |
| `apps/server/src/modules/access/roles/{service,repository}.ts` | 角色用例及查询；依赖 access 策略，不创建第二套授权实现 |
| `apps/server/src/modules/audit/{writer,query,redaction}.ts` | 成功/失败事件、字段允许清单及查询 |
| `apps/server/src/modules/mail/{outbox,worker,templates,smtp}.ts` | 持久任务、租约和模板；不得直接更改用户权限 |
| `apps/server/src/modules/settings/{schema,service}.ts` | 分组配置、交叉约束和生效规则 |
| `apps/server/src/modules/files/{service,storage,cleanup}.ts` | 解码重编码、文件发布、受控读取与回收 |
| `apps/server/src/modules/example-notes/{routes,service,repository}.ts` | 本人笔记，展示接入契约 |
| `apps/server/src/infrastructure/{db,crypto,clock,rate-limit,config}.ts` | 技术适配；无 HTTP 响应逻辑 |
| `packages/contracts/src/{common,auth,users,roles,invites,settings,logs,notes}.ts` | 严格请求/响应 schema、稳定错误与权限 Code；不得依赖 server/数据库 |
| `apps/web/src/features/*` | 按页面能力组织 API 调用、Query、表单、翻译键 |
| `db/schema/*`、`db/migrations/*` | 物理定义及前向版本迁移；目录属性变更也走迁移 |
| `tests/{integration,concurrency,e2e,migrations,recovery}/*` | 契约、真实 PG 并发与运维验证 |

各模块自己的 routes/schemas 按实际接口拆分，不能把所有路由与用例集中到入口文件。

### 2.2 类型边界

下列签名表达内部契约，不是实现代码。

```ts
type UUID = string;
type Version = number; // 安全整数，>= 1
type PermissionCode = string; // 只能来自启用目录

type ActorRef = { sessionTokenHash: Uint8Array; csrfToken?: string };
type RequestMeta = { requestId: UUID; ip: string; userAgent: string };
type Principal = {
  userId: UUID; sessionId: UUID; authorizationVersion: Version;
  isSuperAdmin: boolean; permissionCodes: ReadonlySet<PermissionCode>;
};
type AccessRule =
  | { kind: 'public' }
  | { kind: 'self' }
  | { kind: 'permission'; code: PermissionCode };
type Tx = AppTransaction; // 仅由事务工厂产生，Repository 不接收连接池

authenticateRead(ref: ActorRef, meta: RequestMeta): Promise<Principal>;
requireRecentAuth(tx: Tx, principal: Principal, now: Date): Promise<void>;
can(principal: Principal, permission: PermissionCode): boolean;
assertManageableTarget(actor: AccessSnapshot, target: AccessSnapshot): void;
assertGrantableRoles(actor: AccessSnapshot, roles: readonly RoleSnapshot[]): void;
revokeSessions(tx: Tx, userIds: readonly UUID[], reason: string): Promise<number>;
enqueue(tx: Tx, event: MailEvent): Promise<UUID>;
appendAudit(tx: Tx, event: AllowedAuditEvent): Promise<UUID>;
```

`ActorRef` 仅代表请求携带的凭证线索，不代表已经授权；读请求忽略其中 CSRF 值，认证写入口必须检查其非空并验证。`AccessSnapshot` 包含当前用户状态、角色及权限属性，只能在规定的一致性边界内构造。`Principal` 生命周期只限一次请求，不跨请求缓存。

`authorizeMutation(actor, operationId, input, meta)` 是认证写入唯一入口：operationId 映射编译期登记的输入/输出 schema、锁模式、策略及处理函数，TypeScript 通过登记表索引推导 input/result 类型，不接受调用方提供任意 SQL 回调。worker/ops 使用不对 HTTP 导出的系统用例入口，限定 actor_type、固定 operationId 与对应凭据；系统身份不能调用任意用户写操作，也不能由请求正文构造。

`AppTransaction` 是 pg/Drizzle 事务的受限包装；所有查询、设置超时与锁操作必须使用相同连接。禁止应用服务内部另开数据库事务后假定能够与外层共同回滚。

### 2.3 路由声明

每个路由必须注册 operation_id、访问策略、请求/响应 schema、是否写操作、协调锁模式、近期验证规则、幂等策略及审计动作。公开写接口显式声明 `public`，不能用“未配置权限”表示公开。

构建阶段输出路由清单，对照实际 Hono 路由：遗漏策略、重复 operation_id、未知权限、写路由缺少用例入口都失败。API 404 不回落到 SPA HTML；仅已知页面路由回落到 index.html。

导航也来自启用模块声明，但不能替代后端规则。动态业务权限必须在迁移阶段注册，服务启动只比对目录版本。

## 3. 数据库物理设计

### 3.1 通用字段和约束

- 主键 `uuid`，由应用 CSPRNG UUID 生成；版本 `integer NOT NULL DEFAULT 1 CHECK(version >= 1)`。
- 时间 `timestamptz`，API 返回 ISO UTC；到期不等于清理，读取当时就必须拒绝过期实体。
- 下文除 `?` 标记或明确说明外均 NOT NULL；`created_at/updated_at` 缺省数据库时间，更新显式赋值。
- 枚举用 `text + CHECK`；关联用外键，默认 `ON DELETE RESTRICT`；用户只软删除。
- `token_hash` 为 32 字节 `bytea`；摘要均限定字节长度，API 不返回摘要。
- `email` 为 trim 后展示值，`normalized_email` 为按统一函数转换的小写值，最长 254 个字符；不去点、不去 `+tag`。P0 接受 ASCII 邮箱地址，Unicode 域名须转为合法 ASCII 域名；显示名可为 Unicode，SMTPUTF8 邮箱另行扩展。
- 邮箱规范函数被注册、登录、邀请、邮箱变更、运维入口共用；DB 增加规范值为小写且无首尾空白的 CHECK。密码不 trim、不 Unicode 归一化，按码点计长。
- JSONB 只用于有版本的 schema 或允许字段事件摘要；不存任意请求对象。

### 3.2 用户与授权表

| 表 | 字段与类型 | 约束、索引和生命周期 |
| --- | --- | --- |
| `users` | `id uuid`；`email/normalized_email varchar(254)`；`display_name varchar(80)`；`password_hash text?`；`password_version integer=1`；`status text`；`creation_source text`；`email_verified_at timestamptz?`；`authorization_version integer=1`；`version integer=1`；`registration_role_id uuid?`；`avatar_file_id uuid?`；`locale text?`；`theme text?`；`locked_until timestamptz?`；`last_login_at/deleted_at timestamptz?`；创建/更新时间 | normalized_email 全表 UNIQUE；status ∈ pending/active/suspended/deleted；creation_source ∈ registration/invitation/bootstrap；`(status='deleted')=(deleted_at IS NOT NULL)`；active 必须已验证且 P0 有密码；locale ∈ zh-CN/en，theme ∈ light/dark/system；`(created_at DESC,id DESC)`、`(status,created_at DESC,id DESC)` |
| `roles` | `id uuid`；`code varchar(64)`；`name varchar(80)`；`description varchar(500)`；`is_builtin/is_delegable/is_registration_default_eligible boolean`；version；创建/更新时间 | code UNIQUE，正则 `^[a-z][a-z0-9_-]{2,63}$`；所有 Code 创建后不可修改；自定义角色两个资格缺省 false；内建身份由迁移赋予 |
| `permissions` | `id uuid`；`code varchar(100)`；`module varchar(64)`；`name_key/description_key text`；`is_reserved/is_delegable/is_self_assignable boolean`；`catalog_version integer` | code UNIQUE；reserved ⇒ 不可委派且不可自助；管理权限不可自助；仅迁移账户写 |
| `permission_dependencies` | `permission_id uuid`；`required_permission_id uuid` | 联合 PK、两项 FK；不能自身依赖；目录同步验证无环及所有依赖存在 |
| `user_roles` | `user_id/role_id uuid`；`assigned_by uuid?`；`assigned_at timestamptz` | 联合 PK；`(role_id,user_id)` 反向索引；Pending 不建立正式角色关联 |
| `role_permissions` | `role_id/permission_id uuid` | 联合 PK；permission_id 反向索引；依赖完整性由服务及目录迁移验证 |

用户 `version` 随可编辑资料、状态、角色集合、邮箱及密码变更递增；登录时间、活跃时间、锁定摘要不改变它。`password_version` 只随密码哈希语义变化递增；参数重哈希也递增以阻止旧验证结果覆盖，但不自动撤销既有会话。授权变化及改密/换邮箱/禁用/删除增加 `authorization_version` 并撤销相关会话；单独撤销某一设备不增加用户授权版本。

注册创建时保存 `registration_role_id`，激活时绑定该角色并清空该 FK，审计保留原 role Code/ID；Suspended 且从未验证的注册账号也保留此 FK，角色保护范围包含这类暂时不能激活的账号。Deleted 清空该引用；已激活账号不因历史默认角色引用永久阻止角色删除。

补充索引：users 的 normalized_email、display_name 建 `pg_trgm` GIN；user_roles 采用 EXISTS 筛选用户列表，避免多角色 JOIN 造成列表/count 重复。

### 3.3 会话、凭证与邀请表

| 表 | 字段与类型 | 约束与索引 |
| --- | --- | --- |
| `sessions` | id/user_id uuid；token_hash bytea；authorization_version integer；credential_epoch text；created_at/last_seen_at/idle_expires_at/absolute_expires_at timestamptz；reauthenticated_at/revoked_at timestamptz?；revoked_reason text?；ip inet；user_agent varchar(512) | token_hash UNIQUE；idle/absolute 不早于 created；`(user_id,last_seen_at DESC,id)` WHERE revoked_at IS NULL；absolute_expires_at 清理索引；UA 仅存截断纯文本 |
| `one_time_credentials` | id uuid；purpose text；token_hash bytea；user_id/invite_id/email_change_request_id uuid?；subject_version integer；target_email/normalized_target_email varchar(254)；credential_epoch text；expires_at/created_at timestamptz；consumed_at/revoked_at timestamptz?；purpose_metadata jsonb | token_hash UNIQUE；不能同时 consumed 与 revoked；到期索引；按 subject/purpose 的未终结部分索引；用途及关联矩阵见下文 |
| `invites` | id uuid；email/normalized_email varchar(254)；inviter_id uuid；status text；expires_at/created_at/updated_at timestamptz；version integer；accepted_by uuid?；accepted_at timestamptz?；terminal_reason text? | pending/accepted/expired/revoked；normalized_email WHERE status='pending' UNIQUE；accepted 必有 accepted_by/at，其余为空；`(created_at DESC,id DESC)`、`(inviter_id,status)` |
| `invite_roles` | id uuid；invite_id uuid；role_id uuid?；role_id_at_issue uuid；role_code/name 快照；role_version_at_issue integer | UNIQUE(invite_id,role_id_at_issue)；live role_id FK 可空；Pending 必须有 live 引用，由事务保证；终态释放 live 引用但保留快照 |
| `email_change_requests` | id/user_id/requested_by uuid；initiated_by_self boolean；new_email/normalized_new_email varchar(254)；status text；version integer；expires_at/created_at/updated_at timestamptz；terminal_reason text? | pending/completed/cancelled/expired；user_id WHERE status='pending' UNIQUE；新邮箱不预占；user_id/created_at 索引 |

一次性凭证用途绑定：

| purpose | 必填关联 | subject_version 比较对象 | purpose_metadata |
| --- | --- | --- | --- |
| email_verify | 仅 user_id | user.authorization_version | 空对象 |
| password_reset | 仅 user_id | user.authorization_version | 空对象 |
| invite_accept | 仅 invite_id | invite.version | 空对象 |
| email_change | user_id + email_change_request_id | request.version，且 request.user_id 必须匹配 | 空对象 |
| bootstrap | 仅 user_id，必须与 system_state.bootstrap_user_id 相同 | system_state.bootstrap_version | 空对象 |
| operator_recovery | 仅 user_id | user.authorization_version | `restore_access`、operator_id、reason、evidence_ref；不含证件原件或秘密 |

按 purpose 建 CHECK 限定可空组合；邮箱变更增加 `(email_change_request_id,user_id)` 复合外键。Token 的 GET、preview、打开邮件均不写 consumed_at。所有批量撤销仅更新 consumed_at/revoked_at 均为空的记录，已消费与已撤销终态保持不变。新发同用途凭证撤销所有旧未消费行；按用途撤销不需要把每次资料编辑绑定成凭证版本。

邀请终态释放 live 角色引用是该状态变更的一部分；角色 Code/name 快照创建时写入，不能从已删除角色临时查询。终态重新邀请通过 POST `/invites` 新建；过期 Pending 先转 expired 才新建。`now()` 不用于部分索引谓词。

### 3.4 系统、运行和文件表

| 表 | 字段与类型 | 约束及用途 |
| --- | --- | --- |
| `system_state` | `id smallint=1`；initialization_status text；bootstrap_user_id uuid?；bootstrap_version integer；initialized_at timestamptz?；catalog_version integer | CHECK id=1；uninitialized/pending/initialized；全局安全协调行；初始化完成状态不可由普通服务逆转 |
| `system_settings` | key text PK；typed_value jsonb；registration_default_role_id uuid?；version integer；updated_by uuid?；updated_at timestamptz | key 仅 branding/security；默认角色 FK 仅 security 行有值；API 中该字段与 JSON 合并为 SecuritySettings DTO，DB 不重复存两份 |
| `idempotency_records` | id/actor_id uuid；operation text；key_digest/request_digest bytea；digest_key_id text；target_type text；target_id uuid?；policy_context jsonb；result_summary jsonb；http_status smallint；created_at/expires_at timestamptz | UNIQUE(actor_id,operation,key_digest)；期限 24h；只有已成功提交结果，没有单独提交的 processing 行；不存完整请求或敏感响应 |
| `rate_limit_buckets` | scope text；key_digest bytea；window_start timestamptz；count integer；expires_at timestamptz；locked_until/last_accepted_at/failure_window_started_at timestamptz? | PK(scope,key_digest,window_start)；count>=0；账号失败状态使用固定标识行，见 §10.3；摘要 key_id 属部署配置版本，轮换时需有明确限流重置操作 |
| `email_tasks` | id uuid；event_key text；purpose text；recipient varchar(254)?；recipient_masked text；credential_id uuid?；payload_ciphertext/nonce/auth_tag bytea?；key_id text?；template_version integer；locale text；status text；attempts integer；next_attempt_at timestamptz；lease_owner uuid?；lease_version integer=0；lease_expires_at timestamptz?；provider_message_id/error_code text?；created_at/updated_at timestamptz | event_key UNIQUE；queued/sending/sent/failed/cancelled；attempts 0..3；sending 必须有租约；queued 到期领取索引、sending 租约到期索引；终态删除载荷与完整收件人，只留脱敏地址 |
| `file_objects` | id uuid；storage_key text；owner_id uuid?；purpose text；state text；content_type text；byte_size bigint；width/height integer；created_at/updated_at timestamptz；lease_expires_at timestamptz? | key UNIQUE，不接收客户端 key；purpose avatar/brand_logo/brand_favicon；state staged/attached/orphaned/deleting；avatar 必有 owner；按 state/updated_at/id 回收；品牌的引用由 branding schema 保存并在服务内验证 |
| `file_variants` | file_id uuid FK file_objects；size smallint；storage_key text UNIQUE；byte_size bigint | PK(file_id,size)；P0 仅 size=32 的 Favicon PNG，key 固定为 file_id-32.png；与父文件共享授权和生命周期，父文件保留 64px 主图 |
| `example_notes` | id/owner_id uuid；title varchar(120)；body text；version integer；created_at/updated_at timestamptz | owner FK RESTRICT；标题 1–120 码点、正文 0–20000 码点；`(owner_id,created_at DESC,id DESC)`；删除笔记硬删，用户软删不级联 |

`purpose_metadata`、settings、policy_context、result_summary 均由对应版本 schema 校验。幂等 `policy_context` 仅含重新授权所需的目标/角色 ID 与操作模式；不能凭保存的旧权限快照授权。

### 3.5 审计表

`audit_events`：id、created_at、actor_type(user/operator/worker/anonymous)、actor_id?、actor_snapshot、action、target_type、target_id?、result(success/denied/failed)、reason_code?、reason?、changes、request_id、ip?、user_agent?。

`security_events`：id、created_at、user_id?、event_type、result、reason_code?、target_digest?、request_id、ip?、user_agent?、allowed_metadata。

两表的 actor/target 字段不设可能阻止留存清理的业务 FK。使用 `(created_at DESC,id DESC)` 及 `(actor_id,created_at DESC,id DESC)`、`(target_type,target_id,created_at DESC,id DESC)`；安全表用 `(user_id,created_at DESC,id DESC)`、`(event_type,created_at DESC,id DESC)`。JSON 不建通用全文索引。

### 3.6 数据访问账号

| 账号 | 权限 |
| --- | --- |
| runtime_web | 核心业务 DML；日志 INSERT/SELECT；权限目录 SELECT；无 DDL、无日志 UPDATE/DELETE |
| runtime_worker | 任务读写、凭证和对象只读资格检查、文件回收、日志追加及心跳；到期邀请/请求变更只通过受限维护函数执行；不能赋权或改密码 |
| maintenance | 专用留存清理所需 DELETE；不可由 web 配置加载 |
| migrator/operator | 迁移与本机受控操作；不注入 web 常驻进程 |

目录及内建角色保护还需服务层验证；数据库账号分权减少误操作，不声称对拥有数据库管理员权限者实现不可篡改。

## 4. 请求、事务和并发控制

### 4.1 请求处理顺序

request_id → 请求大小/时限 → 安全头 → 可信 IP → IP 限流 → Origin/Content-Type → schema → 读身份或写用例 → 授权/业务 → DTO → 响应。

默认 JSON 上限 64 KiB；头像 multipart 文件上限 2 MiB、总请求上限 3 MiB；只接收一个文件及声明的版本字段。超限 413，类型不支持 415。HTTP 处理截止建议 15 秒（上传 30 秒），参数属于部署配置；SMTP 不在 HTTP 请求内执行。

生产写请求 Origin 必须精确等于 PUBLIC_ORIGIN；无 Origin 也拒绝。匿名 JSON 操作要求 application/json。认证写还要求会话绑定的 `X-CSRF-Token`，multipart 也一样；logout 例外规则见 §6.5。`X-Forwarded-For` 只从已配置可信代理覆盖的链路提取。

### 4.2 统一写事务入口

```text
预处理（严格解析、限流、必要的密码哈希或图片处理，无业务写入）
BEGIN READ COMMITTED
  SET LOCAL lock_timeout = '2s'
  SET LOCAL statement_timeout = '5s'
  按用例取得 system_state FOR SHARE 或 FOR UPDATE
  只读定位操作者及目标关联 ID，复核初始化状态，不提前更新 session
  按锁顺序锁定 users、roles、sessions 及目标聚合
  取得锁后的 DB clock_timestamp，复核身份/CSRF/期限并续期 session
  重读当前权限；检查操作权限、目标范围及需要的近期身份验证
  查询同键结果；存在则比对摘要、按当前权限返回最小结果
  新请求检查 expected_version、确认目标、状态及业务约束
  写业务、撤权、成功审计、邮件任务、幂等结果
COMMIT
响应（密码、SMTP、文件转换均不在事务中）
```

应用为整段事务增加 8 秒总预算，超时须取消正在执行的查询并等待回滚后释放连接；不能仅对 Promise 超时却留下后台 COMMIT。普通请求的剩余预算不足时不再启动事务。批量影响角色涉及 1 万用户的事务须实测；预算不够时调整有证据的上限，不拆成部分成功。

锁模式沿用架构：普通资料、笔记、品牌写为 SHARE；用户状态/角色/邮箱/密码、会话撤销、邀请、角色编辑、安全设置、初始化/恢复为 UPDATE。近期验证更新 session 采用 SHARE；登录签发 session 采用 SHARE；公开注册采用 UPDATE 以协调默认角色与初始化状态。

### 4.3 锁顺序与时间判定

统一顺序：system_state → users（ID 升序）→ roles（ID 升序）→ sessions（ID 升序）→ invites → email_change_requests → one_time_credentials → idempotency_records → rate_limit_buckets（scope/key 升序）→ file_objects/业务资源 → email_tasks → 审计 INSERT。

同一类多行总是按稳定 ID 排序。应用用例在取得任何聚合锁前一次性决定 SHARE/UPDATE，不升级锁。本人资料请求也先锁 user 再锁 session；HTTP 身份中间件不能反转这个顺序。独立限流事务只锁 bucket 后结束，禁止在持 bucket 时调用安全事务。

普通读的身份检查可以更新 session，但它不再请求 user/role 的行锁或安全协调锁。worker 队列领取只锁任务并快速提交；随后资格检查使用无锁读，不回头申请安全锁。文件回收先锁 file_objects 后仅检查引用，不再申请用户或 system_state 行锁。

安全锁等待后取 `clock_timestamp()`，并在锁住 session/credential 后再次取值判定截止时间。PostgreSQL 的事务时间 `now()` 固定在事务开始，不能用它代替等待后的当前时间。参考 [PostgreSQL 时间函数](https://www.postgresql.org/docs/17/functions-datetime.html)。本设计要求在锁定后的授权检查点尚未过期；该检查完成后事务只做短数据库操作，成功提交不因随后自然到期追溯撤回。

协调行的 SHARE 与 UPDATE 互斥，锁保持到事务结束：业务写先持 SHARE 则先提交，撤权先持 UPDATE 则后续写重新读到失效身份。参考 [PostgreSQL 显式锁](https://www.postgresql.org/docs/17/explicit-locking.html)。禁止每次 SHARE 事务都 UPDATE system_state，以免隐式升级。

### 4.4 失败、重试与无副作用

- 23505 只按已知约束名映射 EMAIL_CONFLICT、ROLE_CODE_CONFLICT、INVITE_EXISTS 等；公开注册邮箱重复仍返回统一 202。
- 版本失败 409；锁等待超时一般 503 BUSY_RETRY，带 Retry-After；同键并发请求等待超时允许返回 409 REQUEST_IN_PROGRESS。
- 40P01/40001 最多重试 2 次（总计 3 次），仅有幂等保护、无外部副作用且请求预算允许时；每次重新取锁、时间与授权。不能重试密码、SMTP 等外部动作。
- 业务回滚后另用短事务写 denied/failed 事件。独立审计也失败时输出脱敏 stderr、计数告警，仍保持原失败结果。
- 业务提交成功但响应丢失：保留相同幂等键查询或重试。提交结果未知时禁止自动换键。

### 4.5 幂等状态与摘要

必需幂等的路由在 §9 标记 `I`。键为 UUID 字符串，缺失/非法返回 422；作用域 actor_id + operation_id + key，不跨操作者共享。使用确定性 JSON 字段排序、集合排序、规范邮箱、目标 ID、expected_version、确认内容生成带密钥请求摘要；密码绝不进入明文摘要材料日志；需幂等的媒体写入将原始文件字节摘要、用途和版本纳入请求摘要，不保存原文件正文。

业务与结果记录同一事务提交；事务内已存在的行锁和 UNIQUE 约束协调相同键。查询历史结果在版本校验之前，但在当前授权之后；业务“此时已 deleted/已 revoked”不能让合法删除/撤销重试重复执行。仅返回 outcome、resource_id、version、completed_at；不返回旧用户 DTO、Token、邮件或密码。

删除后的重放以当前用户可读取该目标历史、当前操作权限和当前保护范围判断；角色删除重放还需 role:manage，并依据记录的目标身份/所需角色范围重新验证；无法安全判定时拒绝读取结果，不猜测权限。已被撤销的操作者 session 始终先 401。

`GET /operations/:operation/:key`：注册 operation 清单内查找，只查当前 actor；可见成功结果 200；不存在、已过期或越界 404 OPERATION_NOT_FOUND；不开放其他 actor 查询。保留 24h 后用户须先查询目标实际状态再决定是否新建操作。

## 5. RBAC 与资源范围算法

### 5.1 有效权限与目标管理范围

`P(u)` 为用户当前所有角色权限并集；持有 super_admin 时为当前启用目录全集，仍不能绕过状态、本人保护、近期验证与业务 owner 条件。内建 user 没有后台权限，self 能力与角色无关。

非超级管理员管理目标 `t` 的必要条件：

1. 操作者有本次具体权限；本人角色/状态/删除管理一律拒绝。
2. 目标不持有 admin 或 super_admin。
3. 目标的每个角色 `is_delegable=true`。
4. 目标每个权限均 `is_delegable=true` 且在操作者 `P(actor)` 中。
5. 角色分配的完整新集合也符合上述条件；不能只验证增加的差集。

`user:read` 允许查看脱敏高权限账号，不意味着可写。目标不存在 404；管理范围不允许写 403 TARGET_NOT_MANAGEABLE，并记录内部详细原因。笔记跨 owner 用 404，不揭示存在。

### 5.2 角色创建、编辑与默认角色保护

- 创建请求只接受 code/name/description/permission_codes，资格初始 false；非超级管理员必须对全部拟授予权限有当前权限且每项可委派，保留权限一律拒绝。
- 非超级管理员编辑/复制/删除角色：角色可委派、当前和拟变更权限均在范围内；不持有该角色；该角色未分配给任何 admin/super_admin 账号。
- 超级管理员可维护含保留权限的自定义角色，创建/复制/修改这类角色还须近期验证与确认；该角色必须不可委派、不可用于自助注册；持有该角色不会变成 super_admin，涉及“仅超级管理员”的动作仍检查内建身份。
- `role:delegate` 和 `settings:update-security` 是必要权限，分别设置委派和注册资格；P0 同时要求真正的 super_admin 身份及近期验证。不能靠自定义角色获得这两项 Code 后绕过身份规则。
- 权限依赖按有向无环图求闭包；请求必须显式包含全部前置权限，缺项 422 PERMISSION_DEPENDENCY_MISSING；返回缺失 Code，不静默追加。
- 当前注册默认角色、所有保留 registration_role_id 的未验证账号引用角色，都必须继续自助合格：资格为 true 且所有权限均 is_self_assignable。取消资格/注入管理权限返回 409 REGISTRATION_ROLE_IN_USE 或 422 REGISTRATION_ROLE_INVALID。
- role.version 对任何编辑递增；权限集合/资格变化同步使关联用户 authorization_version 递增并撤销所有会话。仅名称/描述改变不撤销用户会话，但旧邀请仍因 role.version 改变而不能接受。
- 复制生成新 ID/Code，两个资格均 false，不复制内建身份。非超级管理员创建/复制成功后可能没有继续编辑/分配该角色的资格；成功页明确提示由超级管理员设置委派资格，不能自动给创建者隐藏权限。
- 删除检查 user_roles、未验证注册引用、当前默认设置、Pending 邀请；任何引用返回 409 ROLE_IN_USE，给出计数，不隐式迁移或撤销。

目录完整沿用 PRD §7.5 的 20 个核心 Code；示例四项按模块开关注册。权限依赖与内建 admin 基线逐项由目录测试对照 PRD，不在前端另写角色名单。

### 5.3 高权限与最后管理员

高权限目标包括 admin/super_admin；超级管理员处理持保留权限或不可委派角色的其他受保护目标，也按高风险处理。要求具体操作权限 + user:manage-privileged + 当前会话近期验证 + 服务端确认目标。

最后管理员集合：status=active、email_verified_at 非空、password_hash 非空且绑定 super_admin。执行可能缩小集合的用户状态、角色、删除、恢复等操作前，持 UPDATE 协调锁计算变更后的集合；小于 1 则 409 LAST_SUPER_ADMIN_REQUIRED。

本人邮箱和密码变更不会移除本地认证能力，但必须原子保留新密码/已验证新邮箱；管理员不能后台禁用、删除或改自己角色。operator 的恢复访问属于受控专用流程，不能复用普通角色接口绕过此限制。

### 5.4 前端能力摘要与 owner

用户/角色详情返回 `allowed_actions`（动作 Code 数组）和 `requires_reauth_actions`；基于当前权限与目标范围计算，不包括邮箱/密码等不可验证条件。版本变化后摘要可过时，提交仍完整校验。

笔记查询与写入均带 `owner_id=principal.userId`。更新/删除先按 owner 查锁目标，找不到 404，再比较 version；不通过版本冲突泄露他人资源。即使 super_admin 也执行同一条件。

## 6. 认证、会话与凭证算法

### 6.1 密码与登录

密码长度默认 15–128 Unicode 码点，不 trim、不截断、可粘贴。弱密码列表离线读取，启动验证文件摘要与版本；缺失生产阻断集时配置检查失败。许可和完整数据集选型为发布前事项。

Argon2id 候选参数沿用架构：64 MiB、3 次、parallelism=1、随机盐至少 16 字节；使用库标准编码。需实测工作因子及并发，不能低于已采用安全基线。[OWASP 密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) 支撑算法选择，不代表本项目已经完成安全认证。

建议每个 web 哈希并发 2，等待队列上限 10，排队最多 2 秒；超限 503 AUTH_BUSY。部署多个 web 时计入总内存预算；压测 5 并发登录以完整排队耗时计算 P95，不只计算单次库调用。

登录顺序：

1. 格式与 IP 配额；读取统一邮箱失败状态；不存在邮箱也使用 dummy hash，失败不公开细分原因。
2. 无持锁事务读取候选 user.id/password_hash/password_version；执行密码校验。
3. 密码错误：在账号失败 bucket 事务记失败，写 security event；返回 401 AUTH_FAILED。
4. 密码正确：SHARE 协调事务内重新读取状态、当前 hash/version、暂锁和系统状态；发生变化则拒绝该验证结果，不能使用旧 hash 建 session。
5. Pending 且为普通注册用户返回 403 EMAIL_VERIFICATION_REQUIRED；bootstrap 用户不走此入口。仅密码正确才返回待验证引导。
6. Active 且已验证、未暂锁：创建全新 32 字节随机 session，绑定授权版本/epoch；写 last_login_at、登录与 session 事件；清理邮箱失败计数并同步 locked_until 摘要。
7. COMMIT 后 Set-Cookie。事务失败不得给浏览器有效 Cookie。

成功登录不自动填 reauthenticated_at；高风险操作需单独近期验证。哈希参数升级可提前计算新 hash，在登录短事务内比较 password_version 后替换；不额外向用户声明“改密”。

### 6.2 会话有效性与续期

令 `t` 为锁后 DB 实时时间，`L` 为续期前 last_seen_at：

```text
有效 = 未撤销 AND Active AND 邮箱已验证
    AND session.authorization_version = user.authorization_version
    AND session.credential_epoch = 部署当前 epoch
    AND t < min(idle_expires_at, L + 当前空闲策略)
    AND t < min(absolute_expires_at, created_at + 当前绝对策略)
```

通过后原子写 `last_seen_at=t`，并把 absolute_expires_at 收紧为原值与当前策略期限的较早者；idle_expires_at 设为 `min(t + 当前空闲策略, 收紧后的绝对期限)`。先判断旧期限再续期，禁止救活已过期行。延长策略不延长既有绝对期限；空闲续期只作用于当时仍有效会话。锁定 session 后再次取 t，避免并发使用较旧时刻倒退 last_seen_at。

普通读用短 READ COMMITTED 事务检查 user/session、更新 session 并加载权限；不使用跨请求缓存。撤权前开始并通过身份检查的读响应允许完成；撤权提交后的新读必须失败。写则使用 §4 全流程，在业务提交前持安全锁。

会话列表只含按当前策略仍有效项；返回 id、is_current、设备摘要、IP、created_at、last_seen_at、absolute_expires_at。本人可以撤销指定自己的 session，其他用户 ID 返回 404；重复撤销自己历史 session 返回成功，绝不清空 revoked_at。

### 6.3 近期验证与修改密码

POST `/auth/reauthenticate`：验证当前密码，在 SHARE 协调事务重查 password_version/身份，再更新当前 session.reauthenticated_at。失败受账号与 IP 限流，不刷新任何成功时间。

近期验证有效区间为 `[reauthenticated_at, reauthenticated_at+5分钟)`；未来时间戳视为异常拒绝。只对当前 session 生效，不随页面活动刷新。

本人改密每次都验证原密码；新哈希在事务外计算，UPDATE 协调事务比较旧 password_version 和 expected_version，更新 hash/password_version/user.version/authorization_version、撤销会话和重置凭证、入队通知。返回 200 `{login_required:true}` 并清 Cookie；不自动创建新会话。重新验证通过但未提交原操作时不触发任何业务变化。

### 6.4 Token、epoch 与凭证页面

Session 和一次性 Token 使用 CSPRNG 32 字节、base64url 无 padding（43 字符）；严格格式解码，DB SHA-256 摘要查找。`credential_epoch` 为外部文件生成的随机代次，web/worker/ops 全部一致；每次校验都比较。普通重启不生成新 epoch。

凭证页面从 fragment 读取 Token 到内存并 history.replaceState 清 URL；不写 localStorage/sessionStorage、Query 持久缓存或日志。GET 页面不消费；preview 仅 POST 查询最少信息。页面 no-store、no-referrer，无第三方脚本；用户刷新后需重新打开原邮件。

预览可能成功后提交失败，提交总是重新检查全部规则。失效统一 400 CREDENTIAL_INVALID；邀请资格变化对有效持有人可返回 409 INVITE_REISSUE_REQUIRED，但不返回内部角色权限详情。消费比较 purpose、对象版本、签发邮箱、epoch、到期、撤销/消费状态后条件 UPDATE，影响行数必须等于 1；与业务同事务。

### 6.5 Cookie、CSRF 与退出

生产 Cookie 为 `__Host-honocraft_session`，Secure、HttpOnly、SameSite=Lax、Path=/、无 Domain，浏览器会话 Cookie。开发 HTTP 名为 `honocraft_dev_session`，生产拒绝开发配置。

登录后的 CSRF = 独立密钥对固定格式的 session.id + epoch 做 HMAC，再 base64url；GET `/me` 返回该值，写操作常量时间比较。多标签页共享同 session 的相同值，不含 session Token。CSRF 密钥轮换停止旧进程后统一切换，前端重读 `/me` 后由用户重新提交。

logout 始终校验 Origin：有效 session 必须提供 CSRF 后撤销；没有或已失效 session 可幂等清 Cookie 返回 200。不能因 logout 要求有效身份而让过期用户无法清理客户端状态。网络失败时前端只可清自身内存，提示退出尚未确认，不能谎称已撤销服务器会话。

## 7. 业务状态机与用例详细流程

### 7.1 初始化与管理员恢复

system_state：uninitialized → pending → initialized。ops:init 只在本机运行，UPDATE 协调锁下创建 creation_source=bootstrap、status=pending、无角色/无密码的专用用户及 bootstrap 邮件。重复同邮箱不新建；`--resend` 撤销旧凭证并递增 bootstrap_version；不同邮箱拒绝。

本轮补充命令 `pnpm ops:init -- --cancel --reason=...`：仅在尚未初始化时取消旧 bootstrap，撤销凭证/任务并删除该无业务关联专用用户，保存审计快照，回 uninitialized；不用于删除正常用户。取消后才可换邮箱重启初始化。

完成接口预先计算密码 hash，事务内验证 bootstrap 用户/版本/epoch/期限，绑定 super_admin、验证邮箱、Active、设置密码并更新版本、消费 Token、置 initialized、审计。初始化门禁只放行必要静态资源、公开最少品牌、健康与 bootstrap 完成页/API；其他路由 503 SYSTEM_NOT_INITIALIZED。

ops:recover 必须提供 operator_id、reason、evidence_ref；只记录核实记录引用，不录入证件。恢复凭证 30 分钟固定期限，立即撤销目标旧 session 与其他恢复凭证。默认只操作已有 Active 超级管理员；`--restore-access` 仅在无可用超级管理员时允许，限定恢复已有目标，不创建任意新账号。

完成恢复时重查 operator_recovery metadata 和目标版本；普通模式仅换密；restore_access 模式重新确认仍无可用管理员，将目标恢复 Active、验证发送目标邮箱、显式绑定 super_admin。撤销所有其他凭证/session、写完整审计与安全通知；新出现可用管理员时拒绝旧 restore_access 凭证，要求重新核实。此入口不允许普通管理员通过 HTTP 签发凭证。

### 7.2 注册、验证和重新发送

注册 UPDATE 事务：重读注册开关及默认角色资格 → 同邮箱存在则执行同配额/统一 202，不改现有密码 → 新建 Pending 与 registration_role_id → 凭证/邮件/事件共同提交。公开响应始终 `{accepted:true}`，不能返回新 user_id 或任务 ID。

邮箱验证 UPDATE 事务：检查 email_verify → user 为 registration Pending、没有有效待变更邮箱请求 → 校验原 registration_role_id → Active/verified → 建 user_roles、清 registration_role_id → 消费 Token → 事件。失败不切换到当前新默认角色。

重发仅为可用 Pending 注册用户签发；存在有效邮箱变更请求时不签发原邮箱验证凭证，统一 202 并内部记录被抑制，防止绕过正在修正的新邮箱流程。变更已取消或过期后允许原地址重新验证。注册开关关闭不阻止现有 Pending 验证/重发。

### 7.3 邀请

| 动作 | 前置条件 | 原子变化 | 失败结果 |
| --- | --- | --- | --- |
| 创建 | invite:manage；至少一个角色；全部可授予；高权限角色额外检查 | 清理同邮箱过期 Pending；新 invite/角色快照/Token/outbox/audit | 已有用户 409 ACCOUNT_EXISTS；有效 Pending 409 INVITE_EXISTS；不发邮件 |
| 重发 | 仅仍有效 Pending；当前操作者具备创建该角色邀请资格；version 匹配 | inviter 改为当前人；version+1；更新当前角色版本快照；撤销旧 Token/任务；新到期时间/邮件 | 已过期则提示新建邀请；角色不可授予整体拒绝 |
| 撤销 | 当前具备 invite:manage 且可授予其全部角色；高权限邀请要求近期验证 | revoked、version+1、凭证/任务撤销、释放 live role 引用、审计 | accepted 409 INVITE_TERMINAL；同键重放返回原成功 |
| 接受 | Token 有效；邮箱无用户；inviter 当前 Active/verified 且仍具权限；所有 role.version 匹配 | 建 Active/已验证用户、hash、完整 user_roles；accepted、消费凭证、释放 live 引用、审计 | 唯一邮箱竞态整体回滚；资格/版本不符要求重发 |
| 到期 | DB 当前时间已达 expires_at | 读取立即显示 expired；清理任务最终写 expired 并撤销 Token/任务 | 不依赖 worker 才拒绝链接 |

授予 admin/super_admin 的邀请只允许真正 super_admin 且 user:manage-privileged，创建/重发时 5 分钟近期验证和确认；接受时复核邀请人当前资格，不要求其仍在线或仍在 5 分钟窗口，否则 72 小时邀请无法正常使用。

邀请失去资格时，accept 拒绝但不自动替换角色。管理员可重发有效 Pending 刷新快照，或撤销后新建角色集合。修改邀请邮箱/角色不开放 PATCH，避免旧邮件语义变化。inviter 禁用/删除时同步撤销其所有 Pending 邀请；仅普通权限变化则消费时复核。

### 7.4 密码找回与管理员触发

匿名 forgot 对所有合规邮箱统一配额与 202，仅 Active、verified、本地密码存在者签发 password_reset。管理员 reset 需 user:reset-password、目标范围及高权限要求；只发邮件，不撤销当前会话或修改密码。

reset 完成：事务外生成新 hash，UPDATE 事务验证 Token/当前账号状态/authorization_version，更新 hash、password_version、user.version 与授权版本；消费当前凭证、撤销其他重置及恢复凭证、撤销所有 session、事件与通知。任何失败不激活账号。成功后回登录，不将 reset 本身视为正式 session。

### 7.5 邮箱变更

发起：self 近期验证，或 user:update-email + 目标范围 + 操作者近期验证。校验新旧地址不同、当前全局唯一、expected_version；新邮箱不预占。UPDATE 事务取消前项请求与任务，创建新 pending 请求，user.version+1，签发 email_change；对未验证用户立即撤销旧 email_verify；原邮箱发“变更发起”安全通知。

完成：锁 user、发起者、当前请求和 Token；检查请求仍最新、目标 Active 或合法 registration Pending（不含 bootstrap）、邮箱唯一；管理员发起的还要检查发起者 Active/verified、当前权限及管理范围。已禁用/已删除目标拒绝。

成功事务替换邮箱、标记 verified；Pending 按原注册角色规则激活；user.version/password 之外的授权版本递增、撤销所有 session 及旧邮箱凭证、取消旧凭证邮件、completed、审计、原邮箱完成通知。密码本身不改变。唯一冲突 409 EMAIL_CONFLICT，原地址保持可用；用户可取消或换地址发起。

取消：本人或仍具资格的原发起者；不能因为其他人有管理权限就替原发起者取消。expected request_version + user expected_version，变更请求 cancelled、user.version+1、撤销 Token/邮件、审计。到期不替换邮箱；Pending 可重新签发原地址验证。待变更新邮箱在没有验明前不作为登录标识。

### 7.6 用户资料、状态、角色

| 用例 | 变更与校验 |
| --- | --- |
| 资料修正 | 白名单 display_name；本人还可 locale/theme；email/status/roles 字段一律 422；user.version+1 |
| 禁用 | pending/active → suspended；撤销 session、全部凭证及邮箱请求、以其为 inviter 的 Pending 邀请和相关任务；保留角色；授权版本及编辑版本增加；通知与审计 |
| 启用 | suspended → verified 则 active，否则 pending；旧 session/Token 保持无效；未验证用户可走重发；不静默签发凭证 |
| 软删除 | pending/active/suspended → deleted；deleted_at；撤销与取消同禁用；清 user_roles/registration_role_id，保留邮箱与历史业务；头像转 orphaned；版本增加 |
| 分配角色 | 仅 Active，完整替换集合可为空；检查旧/新范围、角色依赖、最后管理员；授权版本/version 增加、撤销 session、审计 |

安全设置不允许直接改 deleted_at/verified_at。P0 对 Pending 不分配角色；对 Suspended 先按正式启用流程恢复再调整角色，避免隐藏授权漂移。管理用户列表包含状态明确筛选，Deleted 缺省隐藏。

## 8. 关键并发时序与落库原子性

### 8.1 事务事件清单

| 事件 | 同一次提交的记录 |
| --- | --- |
| user.roles_changed | user_roles、users 两类版本、sessions 撤销、audit、security、幂等摘要 |
| role.permissions_changed | role_permissions、roles.version、全部关联 users.authorization_version、全部 session 撤销、audit、security、幂等摘要 |
| invite.accepted | 新 user、user_roles、invites、invite_roles 引用释放、credential 消费、audit、安全事件 |
| user.email_changed | user 邮箱/验证/版本、request 状态、凭证及 session 失效、mail 取消/安全通知、audit/security |
| password.changed | hash/版本、credential/session 撤销、notification、security；管理员恢复另有 audit |
| settings.security_changed | 全组配置/version、audit、幂等摘要；后续请求即时读取新策略 |

角色授权影响用户必须同事务集合更新；不能 HTTP 成功后 worker 分批撤权。安全角色批量更新同时递增关联用户编辑 version，避免旧角色分配页面覆盖期间变化。

### 8.2 必须验证的交错

| 场景 | 交错与唯一合法结果 |
| --- | --- |
| 写入 vs 撤权 | A 持 SHARE 完成授权后停住；B UPDATE 等待；A 先提交、B 再撤权。反过来 B 先提交，A 取得锁后 401；不存在撤权后使用旧授权提交 |
| 两名超级管理员互相禁用 | 同时请求，排他协调锁串行；第一个成功后另一人的旧身份失效；最终仍至少一名可用 |
| 同一邀请两次接受 | 排他协调 + credential 条件消费；恰好一名用户，另一个失效，无半完成记录 |
| 注册与邀请争相占邮箱 | UNIQUE 正规邮箱决定唯一结果；注册输的一方仍统一 202；邀请输的一方返回冲突 |
| 两人验证同一新邮箱 | 第一份完成；第二份 409 保留原邮箱，不能出现双重登录标识 |
| 改角色 vs 接受旧邀请 | 角色先变更则版本不符；接受先完成则随后角色变更立即影响新用户并撤销其会话 |
| 密码校验期间改密 | password_version 改变后旧校验结果不能建 session、reauth 或覆盖新 hash |
| 等锁期间 Token 到期 | 锁后实际时间判定，返回失效；不能使用事务开始时间继续消费 |
| worker 旧租约回写 | B 取得新 lease_version 后，A 回写影响 0 行；不能覆盖 B 或 Cancelled |
| staged 回收 vs 文件附着 | 双方锁同一 file_objects；附着先完成则回收跳过；回收先标 deleting 则附着拒绝并保留旧头像 |

### 8.3 原子性故障注入

在业务最后一次 UPDATE 后、审计 INSERT 前制造错误，整个事务回滚；outbox、幂等结果也不能存在。COMMIT 后丢弃 HTTP 响应，重试相同键只得到一次业务结果。SMTP 故障只改变任务状态，不回滚已提交的邀请/用户；文件 IO 故障不先删除旧文件。

## 9. HTTP 接口详细契约

### 9.1 公共类型与响应

API 前缀 `/api/v1`；字段 snake_case；请求与响应分别定义严格 schema，未知输入字段 422，输出采用显式投影。UUID 字段校验合法 UUID；数组去重后校验，角色集合最多 100 项；字符串禁止 NUL，按纯文本处理。

```json
{"data":{"id":"UUID","version":2},"request_id":"UUID"}
```

```json
{"data":{"items":[],"page":1,"page_size":20,"total":0},"request_id":"UUID"}
```

```json
{"error":{"code":"VERSION_CONFLICT","message":"数据已更新，请刷新后重试","field_errors":{}},"request_id":"UUID"}
```

`V` = 正文 `expected_version`，指操作表中指定聚合的编辑版本。`I` = 请求头必需 Idempotency-Key。`R` = 当前会话近期验证；`H` = 目标/授予内容高权限时追加高权限检查与近期验证。所有认证写均有 Origin + CSRF，与表中标记无关。

确认结构 `confirmation:{target_id,typed_label?,reason}`（角色创建采用互斥的 target_code，邀请创建采用 target_email，不接受伪造资源 ID）：reason 1–500 码点，状态/删除/角色/安全设置必填；删除或高权限操作 typed_label 必填。用户确认标签为目标 normalized_email；邀请为 normalized_email；角色为 code；安全配置为固定 `security`。服务端用锁后真实值比较，不能只检查前端传了 true。

列表：page 默认 1 且 >=1，page_size 默认 20、上限 100；sort 仅白名单字段、direction asc/desc，id 同方向次排序；日期 from 含、to 不含，from<to。非法筛选 422，不默默忽略。一次 list/count 使用 REPEATABLE READ 只读快照；身份认证短事务在它之前完成。跨页不承诺快照。

用户/邀请文本 query 为空表示不过滤，否则 trim 后 2–100 字符，ILIKE 通配符 `%/_` 按字面转义；始终参数化。日志时间缺省最近 30 天，允许明确查询保留期内历史；邮件同样分页，不返回所有任务。

### 9.2 公开认证与凭证接口

| 方法 / 路径 | 输入 | 成功 data / 状态 | 主要失败 |
| --- | --- | --- | --- |
| POST `/auth/register` | email,password,display_name | `{accepted:true}` / 202 | REGISTRATION_DISABLED、422、IP 429 |
| POST `/auth/login` | email,password | `{authenticated:true}` + Set-Cookie / 200 | 401 AUTH_FAILED；正确 Pending 403 EMAIL_VERIFICATION_REQUIRED |
| POST `/auth/logout` | 空对象；有效会话需 CSRF | `{logged_out:true}` + 清 Cookie / 200 | 来源或有效会话 CSRF 错误 403 |
| POST `/auth/email/resend` | email | `{accepted:true}` / 202 | 公共格式/来源错误；邮箱配额内部抑制 |
| POST `/auth/email/verify` | token | `{verified:true,login_required:true}` / 200 | CREDENTIAL_INVALID、REGISTRATION_ROLE_INVALID |
| POST `/auth/password/forgot` | email | `{accepted:true}` / 202 | 公共格式/来源错误 |
| POST `/auth/password/reset` | token,new_password | `{reset:true,login_required:true}` / 200 | CREDENTIAL_INVALID、PASSWORD_REJECTED |
| POST `/auth/invites/preview` | token | instance_name、email、expires_at / 200 | CREDENTIAL_INVALID；不暴露角色列表与邀请人私密资料 |
| POST `/auth/invites/accept` | token,password,display_name | `{accepted:true,login_required:true}` / 200 | CREDENTIAL_INVALID、INVITE_REISSUE_REQUIRED、EMAIL_CONFLICT |
| POST `/auth/email-change/confirm` | token | `{changed:true,login_required:true}` / 200 | CREDENTIAL_INVALID、EMAIL_CONFLICT、CHANGE_REQUEST_INVALID |
| POST `/auth/bootstrap/complete` | token,password,display_name | `{initialized:true,login_required:true}` / 200 | CREDENTIAL_INVALID、BOOTSTRAP_CLOSED |
| POST `/auth/operator-recovery/complete` | token,new_password | `{recovered:true,login_required:true}` / 200 | CREDENTIAL_INVALID、RECOVERY_STATE_CHANGED |
| GET `/public/settings` | 无 | instance_name、brand URLs、locale/theme/timezone、registration_open、password_min_length、initialized / 200 | 503 依赖故障 |

没有公网 bootstrap/recovery 创建接口。重置、验证等过期页面可提供重新发送表单，但不将有效邮箱从失效 Token 中泄露给陌生调用者。密码策略通过非敏感公开说明展示最低长度，不公开失败计数、锁定状态等内部值。

### 9.3 本人资料与会话接口

| 方法 / 路径 | 输入与前置 | 成功 data / 状态 |
| --- | --- | --- |
| GET `/me` | 有效身份 | MeDto / 200 |
| PATCH `/me` | V(user)；display_name/locale/theme 至少一项 | SelfProfileDto / 200 |
| POST `/auth/reauthenticate` | current_password | `{reauthenticated_at,valid_until}` / 200 |
| POST `/me/password` | I、V(user)；current_password,new_password | `{changed:true,login_required:true}` / 200 |
| GET `/me/sessions` | 有效身份 | 活跃 SessionDto 数组，page/page_size/total / 200 |
| DELETE `/me/sessions/:id` | I；目标必须属于本人 | `{revoked:true,is_current}` / 200 |
| POST `/me/sessions/revoke-others` | I；空对象 | `{revoked_count}` / 200 |
| POST `/me/email-change` | I、R、V(user)；new_email | `{request_id,request_version,user_version,expires_at}` / 202 |
| DELETE `/me/email-change` | I；V(user)、request_id,request_version | `{cancelled:true,user_version}` / 200 |
| PUT `/me/avatar` | multipart file + V(user)，本人；I | `{avatar_url,user_version}` / 200 |
| DELETE `/me/avatar` | V(user)；I | `{avatar_url:null,user_version}` / 200 |

MeDto：`user:{id,email,display_name,status,email_verified_at,avatar_url,locale,theme,version}`、roles 简要列表、permission_codes、csrf_token、session:{id,reauthenticated_at,absolute_expires_at}、pending_email_change（仅本人，含请求 ID/version/新邮箱/到期）、instance 非敏感展示值。所有认证查询 no-store；MeDto 不返回 password_version、hash、原始 session 或 token_hash。

### 9.4 用户管理接口

| 方法 / 路径 | 权限 | 输入 | 成功 |
| --- | --- | --- | --- |
| GET `/users` | user:read | 分页；query,status,role_id,created_from/to；sort created_at/display_name/email | UserListItem 列表 / 200 |
| GET `/users/:id` | user:read | UUID | UserDetailDto / 200 |
| PATCH `/users/:id/profile` | user:update + 目标范围，H | I、V(user)、display_name；H 时 confirmation | 用户编辑摘要 / 200 |
| POST `/users/:id/status` | user:change-status + 目标范围，H | I、V(user)、action suspend/enable、confirmation | id,status,version / 200 |
| DELETE `/users/:id` | user:delete + 目标范围，H | I、V(user)、confirmation | id,status=deleted,version / 200 |
| POST `/users/:id/password-reset` | user:reset-password + 目标范围，H | I、V(user)、confirmation | `{accepted:true}` / 202；不递增 user.version |
| POST `/users/:id/email-change` | user:update-email + 目标范围，R、H | I、V(user)、new_email、confirmation | request_id/request_version/user_version/expires_at / 202 |
| DELETE `/users/:id/email-change` | user:update-email + 原发起者 + 当前目标范围，H | I、V(user)、request_id,request_version | `{cancelled:true,user_version}` / 200 |
| PUT `/users/:id/roles` | user:assign-role + 新旧集合范围，H | I、V(user)、role_ids（完整集合）、confirmation | id,role_ids,version,login_required / 200 |

UserListItem：id、display_name、email、avatar_url、roles{id,code,name}、status、created_at、last_login_at、version、allowed_actions。高权限目标邮箱对缺乏管理范围者使用 masked_email，email=null；本人或可管理者可见完整 email，DTO 显式 `email_visibility:full/masked`。详情增加 verified、updated_at、可见的邮箱变更摘要与审计入口条件；不返回 session 列表、密码属性及原始安全事件。

读取契约补充：列表与详情均含 `requires_reauth_actions` 和 `requires_typed_confirmation_actions`；动作 Code 为 update、suspend、enable、delete、reset-password、change-email、assign-roles、cancel-email-change。资格同时考虑当前具体权限、完整目标角色范围、本人保护和状态；近期验证摘要描述操作要求，不因本次会话刚验证而省略。输入确认摘要包含删除及高权限目标的可用操作，普通邮箱变更不会因要求近期验证而额外要求输入目标邮箱；拟授予角色造成的新高风险仍在提交时完整校验。Deleted 缺省隐藏，显式 status=deleted 可查询历史详情但没有写操作。排序同值时追加同方向 ID；created_from 包含、created_to 不包含。缺乏范围的邮箱按首字符与域名脱敏，query 的邮箱匹配及 email 排序也只使用可见值，避免通过查询反推隐藏地址。

UserDetailDto 增加 `can_read_audit`（当前 audit:read）和 `pending_email_change:{id,version,new_email,expires_at}|null`。未到期待变更摘要仅本人或当前仍具 user:update-email 和目标范围的原发起者可见；不让其他管理者因拥有读取权限而看到尚未验证的新地址。读取到的动作资格不替代实际写入时的完整校验。

### 9.5 邀请、角色与权限接口

| 方法 / 路径 | 前置 | 输入 | 成功 |
| --- | --- | --- | --- |
| GET `/invites`、`/invites/:id` | invite:read | 列表 query/status/inviter_id/created_from/to | InviteDto 或分页 / 200 |
| POST `/invites` | invite:manage；H | I；email,role_ids（缺省 user，显式空数组拒绝）；高权限 confirmation（target_email/typed_label 均等于规范邮箱） | id,version,status,expires_at,mail_status / 202 |
| POST `/invites/:id/resend` | invite:manage + 当前角色范围，H | I、V(invite)、confirmation | id,version,expires_at,mail_status / 202 |
| POST `/invites/:id/revoke` | invite:manage + 当前角色范围，H | I、V(invite)、confirmation | id,version,status / 200 |
| GET `/roles`、`/roles/:id` | role:read | 分页 query/code/is_builtin | RoleDto 或分页 / 200 |
| POST `/roles` | role:manage + 授予范围 | I；code,name,description,permission_codes；含保留权限时 R + confirmation（创建用 target_code 替代 target_id，等于本次 code） | RoleDto / 201 |
| PATCH `/roles/:id` | role:manage + 角色范围 | I、V(role)；name/description/permission_codes 至少一项；confirmation；当前/拟定含保留权限时 R | RoleDto / 200 |
| POST `/roles/:id/copy` | role:manage + 角色范围 | I、V(source role)；new_code,new_name；含保留权限时 R + confirmation（源角色 ID/Code） | 新 RoleDto / 201 |
| DELETE `/roles/:id` | role:manage + 角色范围 | I、V(role)、confirmation；含保留权限时 R | `{deleted:true,id}` / 200 |
| PUT `/roles/:id/eligibility` | 真 super_admin；变更委派需 role:delegate，变更注册资格需 settings:update-security；R | I、V(role)、is_delegable/is_registration_default_eligible、confirmation | RoleDto / 200 |
| GET `/permissions` | permission:read | module 可选；返回目录版本及模块分组 | `{catalog_version,modules:[{module,permissions:PermissionDto[]}]}` / 200 |

`/roles/:id/eligibility` 是在架构路由族上的明确细分，隔离保留资格字段，不允许通用 PATCH 混入。RoleDto 含资格、version、permission_codes、引用计数、allowed_actions；精确用户明细仍须 user:read。内建角色修改/删除/资格变更统一拒绝。

PermissionDto 含 code/module、name_key/description_key、is_reserved/is_delegable/is_self_assignable、catalog_version 和依赖 Code 数组 dependencies。目录与模块内权限按 module/code 排序；module 严格限定为已注册模块名，已禁用模块返回空 modules。目录版本与条目来自同一个只读快照。

InviteDto 返回 email、邀请人{id,display_name}、角色快照、有效状态、expires_at、version、最近邮件摘要和 allowed_actions；不返回 Token。GET `/:id` 是本轮为详情页补充的只读入口，与列表一致鉴权。

### 9.6 设置、日志、文件、示例与健康

| 方法 / 路径 | 规则与数据 |
| --- | --- |
| GET `/settings` | settings:read；branding/security DTO + 各自 version、allowed_actions、requires_reauth_actions，无部署密钥 |
| PATCH `/settings/branding` | settings:update-branding；I、V(branding)；整组普通字段；200 新组/version |
| PATCH `/settings/security` | 真 super_admin + settings:update-security + R；I、V(security)、完整组和 confirmation；200 新组/version |
| PUT/DELETE `/settings/branding/:asset` | asset=logo/favicon；settings:update-branding；I、V(branding)；上传 file；200 URL/version；无任意 URL 输入 |
| GET `/audit-events`、`/:id` | audit:read；actor_id/action/target_type/target_id/result/from/to；白名单摘要 |
| GET `/security-events`、`/:id` | security-log:read；user_id/event_type/result/from/to；匿名 target_digest 不返回 |
| GET `/email-tasks`、`/:id` | email-task:read；purpose/status/from/to；recipient_masked/attempts/error_code/时间，无载荷和完整地址 |
| GET `/media/avatars/:fileId` | 有效身份；本人，或 user:read 且符合当前用户资料可见范围；只能读取已附着头像；no-store |
| GET `/media/branding/:fileId` | 公开；仅当前已附着品牌资源；内容类型白名单、immutable URL，可缓存 |
| GET `/operations/:operation/:key` | 有效身份、同 actor 当前授权；200 最小摘要，404 不可查询 |
| GET/POST `/example-notes` | read/create；create 201；输入 title/body；列表本人分页 |
| GET/PATCH/DELETE `/example-notes/:id` | read/update/delete + owner；PATCH title/body + V(note)；DELETE V(note)；200 摘要 |
| GET `/health/live` | 无 API 前缀；200 `{status:"ok"}`；仅进程存活 |
| GET `/health/ready` | 无 API 前缀；200 `{status:"ready"}` 或 503 `{status:"unavailable"}`；不输出依赖详情 |

删除接口的 JSON 正文必须由代理/HTTP 客户端端到端支持；OpenAPI 和集成验证覆盖，不使用 URL query 携带确认理由或版本敏感数据。

### 9.7 错误目录

| HTTP | 稳定 Code | 客户端动作 |
| --- | --- | --- |
| 400 | CREDENTIAL_INVALID | 显示失效页面及适用重发/联系管理员入口 |
| 401 | AUTH_FAILED、SESSION_INVALID | 登录失败统一提示；会话失效清保护缓存并登录 |
| 403 | FORBIDDEN、TARGET_NOT_MANAGEABLE、SELF_MANAGEMENT_FORBIDDEN、REAUTH_REQUIRED、CSRF_INVALID、ORIGIN_INVALID、REGISTRATION_DISABLED、EMAIL_VERIFICATION_REQUIRED | 拒绝或明确身份验证/待验证引导 |
| 404 | NOT_FOUND、OPERATION_NOT_FOUND | 隐藏越界资源；结果未知时查询实际资源 |
| 409 | VERSION_CONFLICT、EMAIL_CONFLICT、ROLE_CODE_CONFLICT、ROLE_IN_USE、REGISTRATION_ROLE_IN_USE、INVITE_EXISTS、ACCOUNT_EXISTS、INVITE_TERMINAL、INVITE_REISSUE_REQUIRED、LAST_SUPER_ADMIN_REQUIRED、IDEMPOTENCY_CONFLICT、REQUEST_IN_PROGRESS、CHANGE_REQUEST_INVALID、BOOTSTRAP_CLOSED、RECOVERY_STATE_CHANGED | 保留表单、刷新比较或引导处理；不自动覆盖 |
| 413/415 | PAYLOAD_TOO_LARGE、UNSUPPORTED_MEDIA_TYPE | 指明限制，不回显内容 |
| 422 | VALIDATION_ERROR、PASSWORD_REJECTED、PERMISSION_DEPENDENCY_MISSING、REGISTRATION_ROLE_INVALID、IMAGE_INVALID | field_errors 使用翻译键；不回显密码 |
| 429 | RATE_LIMITED | 使用 Retry-After；邮箱特定匿名限流按 DD-10 隐藏 |
| 503 | SYSTEM_NOT_INITIALIZED、DEPENDENCY_UNAVAILABLE、BUSY_RETRY、AUTH_BUSY、STORAGE_UNAVAILABLE | 显示暂不可用；仅在协议允许时同键重试 |
| 500 | INTERNAL_ERROR | 展示 request_id，内部脱敏记录 |

业务补充错误必须先登记契约和中英文翻译，不向前端泄露数据库约束原文、SQL、堆栈、文件路径或 SMTP 完整响应。

## 10. 邮件任务、审计与限流

### 10.1 邮件状态机与 worker

Queued → Sending → Sent / Failed / Cancelled；可重试失败且 attempts<3 时 Sending → Queued。Sent/Failed/Cancelled 是终态，不能后台强制改回 Queued；用户通过原业务重新发起。

建议每 1 秒轮询，可用并发槽位最多 2，每次领取不超过可用槽位，避免一次领取大量任务却等租约过期。领取使用短事务 `FOR UPDATE SKIP LOCKED`，将状态改 sending、attempts+1、lease_owner=进程 UUID、lease_version+1、lease_expires_at=DB 当前时间+60秒。此模式只用于任务，不用于授权判定。[PostgreSQL SELECT 文档](https://www.postgresql.org/docs/17/sql-select.html) 说明了 SKIP LOCKED 的队列用途。

领取提交后：重新查 task 状态/owner/version/租约 → 校验关联 Token 和对象有效性（状态/用途/版本/epoch/到期）→ 解密并渲染 → SMTP（整个尝试 deadline 20 秒，含 DNS/连接/响应）。不续租；不能在发送期间持数据库事务。

完成写必须同时匹配 id、status=sending、lease_owner、lease_version、lease_expires_at>当前时间。匹配 0 行时丢弃结果、记录无敏感内容的租约丢失指标，不能改写当前任务。

| 结果 | 下个状态 | 时间/清理 |
| --- | --- | --- |
| SMTP 受理 | sent | 保存受限 provider_message_id，清载荷/收件人/租约 |
| 永久失败（如明确拒收） | failed | 保留枚举错误码，清敏感载荷 |
| 第一次可重试失败 | queued | next_attempt_at=失败时间+60秒+0..10秒抖动，清租约 |
| 第二次可重试失败 | queued | +300秒+0..30秒抖动 |
| 第三次失败或未知结果 | failed | 标记 RETRY_EXHAUSTED 或 DELIVERY_UNKNOWN，清载荷 |
| Token 过期/撤销/替换 | cancelled | 取消原因可见，不发送，清载荷 |
| 租约过期 | queued 或 failed | 已消耗本次 attempts；按同一退避规则，耗尽则结果未知失败 |

后台扫租约只锁 task 行，通过租约版本 CAS 转移；取消流程可将 sending 改 cancelled 并递增 lease_version。已进入 SMTP 的邮件无法撤回，收件人可能收到旧邮件，但其 Token 不能消费。

AES-256-GCM 使用库；nonce 12 随机字节、tag 16 字节、key_id，AAD 包含 task_id/purpose/template_version。recipient 与 Token 在加密 payload 内共同认证；任务的明文 recipient 仅 worker 路由核对使用，终态一并清除。每个邮件 event_key 由唯一业务事件 ID + 用途构成；不使用邮箱作为唯一事件 ID。

安全通知的相同事件去重；独立发送节流只延迟 next_attempt_at，不丢弃通知。默认同地址安全通知每分钟发出最多 5 封（本轮建议）；全部仍持久化等待。用户主动重发配额不能阻止安全通知入队。

### 10.2 模板与审计动作

| 模板用途 | 输入允许清单 | 生命周期 |
| --- | --- | --- |
| email_verify/password_reset/invite_accept/email_change/bootstrap/operator_recovery | 实例名称、展示称呼、目标邮箱、受信 URL、到期时间、locale | Token 加密，仅任务存续期可解密 |
| password_changed/email_change_started/email_changed/account_suspended | 实例名称、脱敏对象/时间、安全入口 URL | 不含凭证或完整认证请求 |

模板 zh-CN/en，纯文本与 HTML 双版本，所有动态文本转义。链接仅从 PUBLIC_ORIGIN 和固定页面映射产生；不能接受客户端任意 return URL。语言在入队时快照，格式化时间用实例时区快照。

审计 action 采用 `module.entity.action`，例如 `users.user.suspended`、`access.role.permissions_changed`、`invitations.invite.resent`、`settings.security.updated`、`ops.bootstrap.completed`。每个用例固定 action，客户端不得自行指定。

允许摘要：状态前后值、角色 ID/Code 集合、权限 Code 差集、配置非密钥字段、邮箱掩码、版本、受影响计数。禁止笔记正文、密码/hash、Token、Cookie、CSRF、加密 payload、SMTP 密钥、任意原始请求。用户输入 reason 同样限制长度、纯文本化并做秘密模式脱敏。

request_id 由服务端生成；只信任经过验证的内部链路 ID，不照收公网任意超长值。成功审计在主事务内；失败事件独立，脱敏策略覆盖应用访问日志、代理 URL、任务错误和异常堆栈上下文。

审计的用户 actor_snapshot 在写入同一事务内取得当前 display_name，按审计文本规则脱敏并限制 80 码点；不复制邮箱、角色全集或凭证。以后改名、软删除不重写旧快照；旧记录没有快照时显示其 actor_type/actor_id，不根据当前用户资料伪造历史名称。

日志读取接口对历史 JSON 再做字段白名单投影：未知或不符合当前安全 schema 的变更字段不公开，仍保留其余合法摘要；reason、User-Agent 和名称再次脱敏。安全事件不选择 target_digest/allowed_metadata；邮件任务只选择公开状态列，错误码限稳定枚举，未知历史错误映射 UNKNOWN_ERROR，异常邮箱掩码映射为脱敏占位符。列表与详情使用相同投影，不能以详情权限间接读取敏感载荷。

### 10.3 PostgreSQL 限流算法

IP 配额按滚动时间段统计离散小 bucket：登录采用 1 秒 bucket 汇总最近 60 秒；发送 IP/地址用途采用 1 分钟 bucket 汇总最近 60 分钟。包含整个边界 bucket，最多多限制一个 bucket 宽度，不允许固定整点窗口瞬间翻倍。每 scope/key 另有 sentinel bucket（window_start 为固定 epoch）供 `FOR UPDATE` 串行化求和/递增；清理任务不删除活跃 sentinel。

账号失败窗口：每规范邮箱摘要一个 sentinel，主键 window_start 保持固定；failure_window_started_at 记录首次失败，开始 15 分钟窗口，窗口内第 5 次失败设置 locked_until=此刻+15分钟；暂锁期间不重新延长锁定，不向外暴露锁状态。解锁后新失败开启新窗口；完整成功认证清 count/window/locked_until。不存在账号同样建摘要桶。users.locked_until 仅管理展示镜像，认证以 bucket 为准。

邮件冷却使用地址+用途 sentinel 的 `last_accepted_at` 保存最近受理时间；不足 60 秒不新增邮件。每地址用途滚动 1h 最多 5 次，每来源 IP 滚动 1h 最多 20 次，计用户触发的受理次数；同键重放不扣配额，worker 重试不扣用户配额。

所有需要的 bucket/sentinel 按 scope/key 升序锁。匿名不存在邮箱同样扣受理配额；源 IP 超限 429，目标邮箱配额超限统一 202（内部记录抑制）；管理端配额超限 429。所有匿名 Token preview/complete 建用途+IP 限流，初始每分钟 20 次；猜测无效 Token 不可能通过明文摘要分区绕过源限额。

配额检查、扣减、业务 outbox 在同事务；登录来源限流用独立短事务，失败事务不会抵消已经消耗的尝试。数据库故障返回 503，不降级为进程 Map。摘要使用独立 HMAC 密钥，不能把邮箱/IP 原文当运维 bucket 标签。

### 10.4 维护任务

worker 每分钟处理租约/凭证/请求到期，每小时回收无引用文件和运行记录，每天处理审计留存。使用固定任务类型代码，不提供任意脚本执行或通用任务平台。

到期邀请/邮箱请求变更通过 migrator 定义、仅 runtime_worker 可执行的受限维护函数：固定 search_path、仅接受批大小、只处理已到期对象，不接受任意状态/用户 ID/SQL；函数按 §4 UPDATE 协调锁、每批最多 100 行并重新检查状态；任务载荷清理仅锁 task，不回头申请协调锁。审计 180 天、安全 90 天，以事件发生时间清理，每批最多 1000 条，批间释放事务；记录任务开始/结束/删除条数。

会话与凭证终态元数据建议保留 7 天供受限诊断，邮件任务脱敏终态记录保留 90 天，幂等记录 24h。这些为本轮运行参数；FK 清理顺序先断开/清除终态任务 credential_id，再清过期凭证，不能级联删除审计或未终结业务对象。相关完整收件人和载荷在终态即清，不等待留存期。

## 11. 系统设置与生效规则

### 11.1 分组 schema

| 字段 | 缺省 / 范围 | 生效 |
| --- | --- | --- |
| branding.instance_name | HonoCraft；1–80 码点 | 下次读取；禁止 HTML |
| branding.copyright | 空；0–200 码点 | 下次读取 |
| branding.default_locale/theme/timezone | zh-CN / system / UTC；locale 与 theme 枚举、合法 IANA 时区 | 无用户偏好时使用 |
| branding.logo_file_id/favicon_file_id | null 或已附着专用媒体 | 专用上传接口修改 |
| security.registration_open | false | 新注册即时生效；已有 Pending 可验证 |
| security.registration_default_role_id | 内建 user ID；必须合格 | 只影响以后注册 |
| security.password_min_length | 15；15–64，最大长度固定 128 | 新设密码使用；不强制现有用户周期换密 |
| security.session_idle_minutes | 30；5–30 | 下个请求收紧既有 session；范围为本轮建议 |
| security.session_absolute_minutes | 480；30–480，且 >= idle | 下个请求；延长不复活/延长既有绝对上限 |
| security.email_verify_hours | 24；1–48 | 新凭证 |
| security.password_reset_minutes | 30；10–60 | 新凭证 |
| security.invite_hours | 72；1–168 | 新邀请/重发 |
| security.email_change_hours | 24；1–48 | 新邮箱请求；本轮建议 |
| security.login_ip_per_minute | 20；1–20 | 新请求；不得高于基线 |
| security.account_failures_per_window | 5；1–5 | 新失败判断；窗口固定 15 分钟 |
| security.account_lock_minutes | 15；15–60 | 新触发暂锁；不缩短已设置锁定 |
| security.mail_cooldown_seconds | 60；60–3600 | 新发送受理 |
| security.mail_target_per_hour | 5；1–5 | 新发送受理 |
| security.mail_ip_per_hour | 20；1–20 | 新发送受理 |

近期验证窗口固定 5 分钟；bootstrap/operator_recovery 凭证固定 30 分钟；不暴露为普通后台可调项。审计留存、上传像素/并发、连接池、超时和备份参数属于部署配置，不混入 security API。

安全参数缩紧为缺省值范围之内；若用户以后要求放宽，先评审 PRD 最低约束及验收，不在实现中偷偷增加宽松缺省值。安全字段整组校验，拒绝任何未知项、非法默认角色或跨字段冲突。

### 11.2 配置读取一致性

每请求权威读取安全组；普通展示组可由 Query 缓存，更新后主动失效。环境变量只在首次建设置行时提供缺省；重启不 UPSERT 覆盖用户配置。

配置更新前读取当前版本、校验完整拟定组、近期验证及 confirmation；同事务写 version+1/审计/幂等。更新后前端刷新设置和 me；若会话期限已经缩短到当前 session 过期，下一请求 401。不能清空 created_at/last_seen_at 规避缩短。

安全组以自然键 `security` 标识：`confirmation:{target_id:'security',typed_label:'security',reason}`，reason 1–500 码点；幂等重放的 resource_id 为 null，另带组更新 outcome/version。品牌普通 PATCH 只接收 instance_name/copyright/default_locale/default_theme/timezone，不接收文件 ID 或外部 URL，保留已有专用媒体引用。审计仅记录普通品牌变更的字段名与版本，不复制名称/版权自由文本；安全组记录受严格 schema 限制的布尔、数字及角色 ID 快照。

安全设置提交时，对未撤销会话持久化收紧 absolute_expires_at 和 idle_expires_at，分别以原 created_at、last_seen_at 加新时限取更早值。同一会话即使在策略收紧与再次放宽之间从未请求，也不能因此恢复原来的更晚期限；正常活跃请求仍按现有空闲续期规则处理。

设置页按当前 allowed_actions 显示各组编辑入口；只读用户只看安全值。冲突读取完整当前组供比较，明确采用当前版本后仍保留原草稿，保存会替换完整组。响应不明冻结原正文与幂等键，若重试要求近期验证，验证通过后仍以原键明确重试；已确认写入而后续刷新失败时只重试读取。

## 12. 前端详细设计

### 12.1 页面与数据依赖

| 页面路由 | 主要数据 / 操作 | 权限与关键状态 |
| --- | --- | --- |
| `/login`、`/register` | public settings、认证表单 | 注册关闭隐藏入口；登录密码正确 Pending 才转验证引导 |
| `/verify-email`、`/forgot-password`、`/reset-password` | Token 或 email、新密码表单 | link_invalid/expired/submitting/success；GET 无副作用 |
| `/accept-invite` | preview、password/display_name、accept | 预览清楚显示邮箱/到期；提交不含可改角色 |
| `/change-email`、`/bootstrap`、`/operator-recovery` | 专用 Token 完成表单 | 密码处理只在需要流程；成功去登录 |
| `/` | me、可访问模块入口 | 无管理权限时显示个人中心入口 |
| `/profile`、`/security`、`/sessions` | me、资料、头像、改密、邮箱请求、本人设备 | 各自 loading/error/empty；本设备明显标记 |
| `/users`、`/users/:id` | 分页查询、详情、角色/状态/邮箱对话框 | user:read，操作按 allowed_actions；展示当前版本与风险影响 |
| `/invites` | 列表、创建、重发、撤销 | 邀请状态与邮件状态两列，不用 Sent 表示接受 |
| `/roles`、`/roles/:id`、`/permissions` | 角色、权限目录、引用和资格 | 内建只读；依赖缺失明确提示；资格保留操作单独区域 |
| `/audit`、`/security-events`、`/email-tasks` | 过滤列表与详情抽屉 | 只读；脱敏；无任务强制重放按钮 |
| `/settings` | branding/security 分区 | 普通管理员看可读值，保留操作不显示可提交控件 |
| `/example-notes`、`/example-notes/:id` | 本人笔记列表/编辑 | 模块启用且具有权限；不展示跨用户筛选 |
| `/403`、`/404`、`/unavailable` | 可读错误与可用返回入口 | 不暴露内部异常 |

三类日志页面将当前筛选、排序与分页保存在 URL；`detail=<UUID>` 为前端抽屉状态，不发送给列表 API，详情仍以独立只读接口获取。直接打开带 detail 的地址可恢复抽屉；关闭删除 detail 并保留原列表条件，Escape 与关闭按钮恢复可用的来源焦点。列表/详情分别提供显式重读，详情重读也刷新同类列表，保持正在查看的记录与筛选不变。用户详情的审计入口仅对 audit:read 可见，使用 target_type=user 和 target_id 精确关联。

角色、邀请、用户、邮箱变更和设置操作使用相同的不确定结果规则：NETWORK/5xx、无法解释的成功响应或 REQUEST_IN_PROGRESS 保留原尝试；已经不确定的重试若在读取幂等结果前被近期验证、权限或 CSRF/Origin 前置检查拒绝，仍不能据此断定原操作未提交。保持正文和幂等键，近期验证完成后由用户明确重试；验证期间不可再次提交原业务。只有确定性业务拒绝或已确认结果才结束本次尝试，会话失效则统一清除账号缓存与敏感草稿。

### 12.2 前端状态归属

- TanStack Query 保存服务端快照；query key 包含 actor user ID、资源类型及规范化筛选；切换账号必须清空旧保护数据。
- React Hook Form 保存未提交表单；Zod 客户端校验只改善体验，服务端再次完整验证。
- 搜索、状态、页码、排序保存在 URL；搜索防抖建议 300ms，筛选变化 page 重置 1；列表加载失败保留筛选。
- 密码、CSRF、Token 不进入 URL、持久缓存、埋点和 devtool 自定义日志。关闭敏感表单就清密码；凭证离开页面即丢弃。
- PATCH 采用服务端返回的新 version 更新 Query，不假定客户端加 1 就是真实版本。
- 不对禁用、删除、授权、设置做乐观成功更新；普通按钮提交期间禁用，网络不明显示“结果待确认”。

### 12.3 提交状态机

`editing → validating → submitting → success / field_error / conflict / reauth_required / outcome_unknown`。

一个确定的敏感提交生成一个幂等键，网络失败保留同键及同一正文；用户修改正文后必须创建新键。收到 VERSION_CONFLICT：保留用户输入，拉取最新值提供比较，用户确认后用最新 version 和新键提交。不能对旧键替换正文。

收到 REAUTH_REQUIRED：展示当前操作者验证对话框，验证成功返回原表单，让用户再次确认；不自动重放。验证失败不清掉非密码输入，密码字段重新输入。

收到 401：取消保护查询、清 me 和其他账号数据、清敏感草稿，跳登录；returnTo 只允许路由清单中的站内路径。跨标签页使用 BroadcastChannel 发布 logout/session-invalidated 提示，不共享 Token；未收到广播的标签页仍由服务端拒绝。

### 12.4 组件与可访问性

共享组件：PageState、DataTable、Pagination、StatusBadge、FieldError、ConfirmDialog、ReauthDialog、PermissionGate、VersionConflictPanel、AvatarUploader。组件文案全部翻译键；角色/权限名称采用目录翻译键，自定义名称按用户原文显示。

确认框描述目标和影响，删除输入邮箱/Code；焦点锁在对话框，关闭归还触发按钮，错误与表单标签用 aria 属性关联；状态含文字/图标，不能仅红绿区别。认证/个人中心/会话/用户查询在 360px 视口可完成，表格允许局部滚动或卡片；键盘能完成所有桌面管理操作。

日期显示实例时区并明确时区缩写/偏移，传输仍 UTC。邮件与 UI 都提供 zh-CN/en；构建检查缺失翻译键，人工验证长英文文案、深色模式、可见焦点及读屏关键流程。WCAG 2.2 AA 是验收目标，不将自动扫描等同合规认证。

## 13. 文件与业务模块接入

### 13.1 图片生命周期

1. 流式限制总字节，验证实际格式、解码像素≤1600万、处理 deadline 5秒、进程转换并发 2；拒绝 SVG、动图多帧、伪造签名、损坏内容。
2. sharp 解码并去元数据、按用途缩放重编码。头像中心裁剪 256×256 WebP，Logo 等比限制最长边 512，Favicon 生成 32/64 PNG；不给任意文件公开静态服务。
3. 建 file_objects staged（处理租约最长 10分钟），随机路径写临时文件并原子 rename 到存储 key；失败保留可回收记录，当前头像不变。
4. SHARE 协调事务按锁顺序检查操作者/目标版本，锁 file_objects 且确认 staged 未过期；关联新文件、附着状态、原引用转 orphaned、版本/审计共同提交。
5. 回收只处理 staged/orphaned 从最后状态变更 updated_at 起超过 24小时、租约已过且无引用的对象；每批最多 100 行，用 FOR UPDATE SKIP LOCKED 锁行后以新语句重查全部引用并标 deleting，和开始审计一并提交；事务外删物理文件并同步目录，再同事务删元数据和写成功审计。崩溃重复处理 deleting，文件不存在视为幂等成功。回收不申请用户或 system_state 行锁。

Favicon 的 64px PNG 为主文件，32px PNG 保存在 file_variants，同一父文件的授权、引用和 staged/attached/orphaned/deleting 状态覆盖全部变体。GET `/media/branding/:fileId?size=32|64` 仅对当前 Favicon 支持 size；省略时返回主图，Logo 不接受 size。回收父文件时先处理主文件与全部变体的物理文件，再删除父元数据。

图片工作在独立 Node 工作线程执行，整个处理阶段按墙钟五秒截止并终止停滞线程，槽位在真正退出后才释放；同进程最多两路。只将实际签名为 PNG/JPEG/WebP 的输入交给解码器，多帧拒绝。生成完成后先在同一事务创建主/变体暂存元数据，再写随机临时文件、同步内容、原子 rename 并同步目录，最后进入授权/版本/引用变更事务；任何阶段失败不改原引用。

媒体写入幂等摘要绑定操作、原始图片 SHA-256 和 expected_version，不包含每次生成的随机候选 ID；同键重试产生但未使用的候选保持可回收，不重复附着或递增版本。历史重放只返回 outcome、resource_id、version、completed_at；前端必须再读当前资料/设置。文件名、客户端 MIME、owner_id、storage_key 或外部 URL 不可决定存储或关联。

头像只允许本人，或具有 user:read 且符合当前目标完整资料管理范围者读取；范围外资料摘要同时隐藏 avatar_url，读取接口返回 404。品牌仅当前已附着资源可公开读取，旧引用与未附着候选不可读取。HTTP JSON 与上传分别按 HTTP_TIMEOUT_MS、UPLOAD_TIMEOUT_MS 截止；超限/超时或尚未读完正文的拒绝响应关闭连接，避免客户端复用即将被排空的连接。

写文件前先建元数据，防止 worker 把上传中的无记录文件当孤立文件。崩溃残留的临时文件与无元数据图片按相同 24 小时 mtime 窗口流式扫描，仅接受服务器生成的 UUID.webp/png、UUID-32.png 或 UUID-UUID.tmp 普通文件；存在父元数据或当前引用即跳过，未知名称、目录和符号链接保留。每批最多尝试删除 100 个，先提交审计意图再执行物理删除与完成审计；无元数据扫描在删除后崩溃可留下未完成的意图，不承诺恰好一次事件。不能递归删除媒体根目录或接受客户端相对路径。生产存储根来自部署配置，生成 key 不含 `..` 或路径分隔符。

读取文件先鉴权并确认当前引用，使用已存 content_type + nosniff；头像 no-store，品牌 key 变更产生新 URL。磁盘不足/只读 503 STORAGE_UNAVAILABLE，旧资料版本与文件引用不变。

### 13.2 个人笔记参考模块

启用目录声明 read/create/update/delete，写依赖 read，可委派但不可自助分配；默认不进内建 user。服务契约：listNotes(principal,query)、getNote(principal,id)、createNote(actor,input)、updateNote(actor,id,input,expectedVersion)、deleteNote(actor,id,expectedVersion)。

创建 owner_id 取 principal.userId，拒绝客户端 owner_id。标题 trim 后 1–120 码点，正文保留空白但最多 20000；纯文本渲染。更新/删除同事务授权 + owner 条件 + version，成功审计仅 note ID、动作及 version，不复制内容。

接入新模块的交付清单：module declaration、权限及依赖、迁移、路由 schema、应用用例、owner/范围策略、页面与翻译、审计允许字段、两用户直接 API 用例。不得读写密码/凭证表，不修改 auth 核心。

### 13.3 禁用与移除

新实例生产默认 EXAMPLE_NOTES_ENABLED=false，目录和菜单/API 均不挂载示例；历史建表迁移可运行，空表存在不代表功能启用。

既有实例先维护窗口执行明确权限目录迁移：解除 role_permissions、递增相关 role.version 与用户授权/编辑版本、撤销 session、处理受影响 Pending 邀请，再禁用模块。不能只改 env 造成启用目录与历史授权不一致；启动检查发现这种差异拒绝 ready，要求正式迁移。

彻底移除先明确数据导出/保留/删除，执行前向清理迁移，再删模块代码、注册、导航、专用测试/夹具；保留历史迁移。新库全量迁移与旧库升级必须到相同结构；核心登录、邀请、角色和审计冒烟不受影响。

## 14. 部署、迁移与恢复详细设计

### 14.1 启动与关闭

web 启动：配置校验 → 加载密钥/epoch → 初始化连接池 → 迁移范围与目录版本校验 → 挂载 API/静态页 → ready。worker 相同基础校验后开始领取；初始化未完成仍可投递 bootstrap。禁止自动迁移、自动创建默认密码、自动覆盖设置。

关闭：停止 ready/接收新请求 → 停止新任务领取 → 等待当前 HTTP 事务或 SMTP 尝试结束（建议最多 30秒）→ 关闭连接池。无法完成的 Sending 留租约恢复，不假写 Sent。收到强制终止仍由数据库事务/租约保障可恢复。

镜像非 root、只读根，显式挂载临时目录、媒体卷及只读密钥文件。web 不加载 migration/maintenance 凭证；文件回收使用 runtime_worker，专用留存清理入口单独使用 maintenance，不把维护权限赋给邮件或文件操作。PUBLIC_ORIGIN 生产 HTTPS 且无任意路径/fragment；SMTP 凭证及数据库连接串不能打印。

### 14.2 配置目录与命令

部署配置完整继承架构 §11.2；本文补充 DB_POOL_MAX、HASH_CONCURRENCY、HTTP_TIMEOUT_MS、UPLOAD_TIMEOUT_MS、LOG_RETENTION_DAYS、SECURITY_RETENTION_DAYS 等参数，默认值按本文，禁止在环境变量中提交真实秘密。实施交付 `.env.example` 只包含占位说明与安全开发缺省。

准确命令沿用架构 §11.1；本文补充 `ops:init --cancel`、恢复核实参数与结果格式。所有 ops 命令输出 operation_id、状态、摘要及下一步，不输出 Token、密码、邮箱完整链接或密钥。

| 入口 | 正常行为与退出码约定 |
| --- | --- |
| env:check | 0=通过；2=配置/参数错误，仅报字段名 |
| db:migrate | 0=迁移完成或无变更；3=锁/版本/数据冲突；4=依赖不可用 |
| ops:init | 0=已受理/已初始化；3=邮箱/阶段冲突；重发仍受部署者发送保护 |
| ops:backup | 0=加密备份与清单完成且异地副本确认；非 0 不宣称可恢复 |
| ops:restore | 0=恢复、epoch 轮换、失效处理及检查完成；否则保持维护入口 |
| ops:recover | 0=核实记录落库并邮件入队；无效身份/原因/核实引用为 2 |
| dev:reset | 仅 development、明确库名及同值 confirmation；production 永远拒绝 |

这些是接口约定，不是当前可执行脚本。快速开始最终必须通过干净副本实测，记录命令实际输出，不能把本文中的期望结果当运行记录。

### 14.3 迁移目录与发布

建议迁移分段：0001 核心系统/设置/用户；0002 权限/角色/依赖；0003 会话/凭证/邀请/邮箱请求；0004 审计/安全；0005 邮件/幂等/限流/运行心跳；0006 媒体；0007 示例；0008 基线种子与目录约束。循环 FK 先建表后 ADD CONSTRAINT；迁移序号最终随工程计划确定，不改已发布 SQL。

迁移进程取得独占 advisory lock；migration_history 保存编号/checksum/applied_at/app_version。设置 statement/lock timeout，失败回滚当前迁移，保留准确失败阶段；有意非事务 DDL 必须单独标明并提供恢复步骤。应用只检查支持迁移上下界、checksum 与 catalog_version，不能仅检查“有 users 表”。

发布按维护窗口：关入口/停 worker和写入 → 备份并校验 → migrate/目录同步 → 启动同版本 → ready/核心冒烟 → 开入口。权限变更检查所有自定义角色依赖、注册默认角色与未验证引用；冲突报告 ID/Code 和处理步骤，不自动加权。

若迁移不兼容旧镜像，失败只能恢复匹配数据+媒体+应用版本，并执行凭证恢复失效；禁止只回退镜像碰运气。

### 14.4 备份清单与恢复步骤

每天至少一次，保留至少 7天，复制到与应用机器独立的存储。备份维护窗口停所有写入与 worker，包含数据库快照、媒体、应用/迁移/模板版本、文件大小和 SHA-256 清单；密钥另行安全备份并引用 key_id，不把真实密钥混进普通清单。旧 epoch 可供诊断记录，但不能成为恢复后的当前代次。

恢复按以下步骤执行并留 evidence：

1. 关闭公网业务，停止全部旧 web/worker，确认没有旧进程继续访问数据库。
2. 校验 manifest、文件摘要、版本和密钥可解密性，恢复数据库及媒体；不先启动 SMTP 发送。
3. 在备份外生成新随机 epoch，权限受限临时文件写入后原子替换，全进程一致。
4. 恢复事务撤销所有 sessions/未消费 Token，取消 Pending invites/email_change_requests 和未终结邮件，清载荷及旧幂等记录；保留已完成历史，记录 ops.restore.completed 及操作者核实信息。
5. 校验媒体引用、迁移范围、目录与初始化状态；若未初始化，只允许部署者重新发 bootstrap。
6. 启动 web，使用有效管理员密码重新登录；拿恢复前实际保存的 Cookie 与验证/重置/邀请链接重放，全部失败。
7. 冒烟通过后开启 worker 和公网。用户按正式流程重新邀请/验证；不能自动群发备份中的历史邮件。

恢复记录包含备份时间、故障时间、操作起止、数据缺口、旧凭证测试、人工核实和结果。RPO≤24h、RTO≤4h 仅为目标，实际差距必须记录；全局 epoch 不补回备份之后已丢失的数据。

### 14.5 可观测性

web 池最大 10、worker 5、ops 2；按实际进程数计算连接总额，预留管理连接。新增 `worker_heartbeats(worker_id uuid PK,last_seen_at timestamptz,app_version text,credential_epoch_digest text)` 作为受控运行元数据；每 30秒更新，24小时清理离线行，不存原始 epoch。

内部监测：请求耗时/错误率、DB 池等待、协调锁等待/超时、哈希排队、worker 心跳、最老 Queued 年龄、Failed/未知投递数、磁盘余量、备份年龄、失败审计持久化数。对外 health 只最小状态，不提供公共 metrics 面板。

告警建议：活跃 worker 心跳超过 2分钟、最老待发任务超过 10分钟、备份超过 26小时、持续审计写入失败、媒体卷可用空间低于 10%。SMTP 暂不可用不使 ready 失败，但持续积压可见。日志使用 request_id/operation_id/task_id，禁记请求正文与敏感凭证。

## 15. 验证设计与需求追踪

### 15.1 测试层次及目标文件

| 层次 | 目标测试文件 / 证据 | 检查内容 |
| --- | --- | --- |
| 单元 | `tests/unit/access-policy.test.ts`、`password-policy.test.ts`、`settings-schema.test.ts` | 完整权限子集、依赖闭包、默认角色保护、Unicode 码点、严格字段与脱敏 |
| API 集成 | `tests/integration/auth.test.ts`、`users.test.ts`、`roles.test.ts`、`invites.test.ts` | 真实 PG，事务状态与响应/Cookie，角色与本人边界 |
| 协议安全 | `tests/integration/browser-security.test.ts`、`idempotency.test.ts` | Origin/CSRF/Content-Type、未知字段、同键冲突及撤权后重放 |
| 并发 | `tests/concurrency/security-transactions.test.ts` | 两个真实连接加可控屏障复现 §8.2，不使用随机 sleep 当竞态证据 |
| 邮件/文件故障 | `tests/integration/mail-worker.test.ts`、`files.test.ts` | 可控 SMTP 超时/拒收、终止 worker、租约 CAS、文件 IO/解码/回收竞争 |
| 浏览器 | `tests/e2e/core-journey.spec.ts`、`account-security.spec.ts`、`admin.spec.ts` | Playwright + Mailpit 完成页面/邮件流程、双语和移动核心流程 |
| 迁移 | `tests/migrations/upgrade.test.ts`、版本化旧库夹具 | 空库全量、有业务旧库升级、目录冲突、示例裁剪 |
| 恢复 | `tests/recovery/restore.test.ts`、目标部署演练记录 | 备份清单、epoch、新旧 Cookie/Token、媒体、实际 RPO/RTO |
| 契约/静态 | 路由清单、DTO/翻译/模块边界检查 | 所有 API 明确策略，无 server→web/contract 反向依赖，无原始实体输出 |

测试库单独 DATABASE_URL，命名限制并拒绝生产配置。fixture 密码/Token 只测试环境使用，不进入模板默认账户或生产种子。

时间验证在真实 DB 通过设置边界时间或可控等待完成；生产 SQL 使用 DB 时间不能被测试专用请求头覆盖。SMTP 与文件注入用服务端依赖适配器，不在生产 API 增加故障开关。

### 15.2 PRD 验收矩阵

| PRD ID | 本文设计位置 | 必须保存的证据 |
| --- | --- | --- |
| AC-01 | §7.1、§14 | 并发/重复初始化、重发/取消、未初始化门禁、无默认密码 |
| AC-02 | §7.2、§11 | 页面/直接 API 均拒绝新注册，旧 Pending 可验证 |
| AC-03 | §6.4、§7.2 | Pending 无 session；激活一次、过期/撤销/重放均无副作用 |
| AC-04 | §6.4、§7.2 | 邮件 GET 不改 DB；重发旧 Token 失败 |
| AC-05 | §6.1、§7.4、§10.3 | 四类邮箱统一公开结果；内部原因与敏感日志扫描 |
| AC-06 | §10.3 | 两 web 进程共享限额；窗口、冷却、边界与暂锁到期 |
| AC-07 | §6.3、§7.4 | 新密码可登录、所有旧 session/重置 Token 失败 |
| AC-08 | §6.2、§9.3 | 自己/他人设备边界、退出当前和其他、重复撤销 |
| AC-09 | §7.6 | 禁用后重放失败，启用不复活 |
| AC-10 | §7.3、§10.1 | SMTP 故障不丢邀请；并发接受只一用户/完整角色 |
| AC-11 | §7.3 | 重发/撤销、inviter 被降权/禁用，旧链接不能激活 |
| AC-12 | §7.3 | 四状态已存在账号均不合并/改密/加角色 |
| AC-13 | §2.3、§5、§9 | 猜管理 URL/直接 API、无策略路由构建失败 |
| AC-14 | §5.1–3 | 邮箱/密码邮件/状态/角色每条路径不能接管受保护目标 |
| AC-15 | §4、§8.1 | 用户/角色变更同步撤销全量会话，旧 Cookie 跨进程失败 |
| AC-16 | §5.3、§8.2 | 并发相互禁用/降权后仍有一名可用超级管理员 |
| AC-17 | §3.2–3、§5.2 | 所有引用阻止删除；version 冲突不覆盖 |
| AC-18 | §7.5、§8.2 | 新邮箱验证前不改身份；双用户竞争、禁用后验证失败 |
| AC-19 | §13.1 | 伪格式、像素炸弹、超限、SVG/多帧拒绝，昵称脚本纯文本 |
| AC-20 | §3.2、§7.6 | 软删除占用邮箱、历史目标可识别、业务数据未级联 |
| AC-21 | §4.4、§8.3、§10 | outbox 持久化；审计 INSERT 故障时业务/任务/幂等一起回滚 |
| AC-22 | §9、§10.2 | DTO、日志、任务后台、异常路径的秘密扫描 |
| AC-23 | §5.2、§11 | 默认管理员/弱策略/非法范围均整体拒绝 |
| AC-24 | §12 | 双语、键盘、焦点、移动核心、长文案与状态区分 |
| AC-25 | §14、§15.3 | 指标报告、目标环境恢复、health 脱敏 |
| AC-26–28 | §16 | P1 独立设计后验证；不纳入本 P0 完成声明 |
| AC-29 | §14.2 | 干净副本 30分钟启动目标、真实命令输出及环境记录 |
| AC-30 | §13.2 | 两用户/超级管理员互访笔记拒绝，新增模块 2小时试用目标 |
| AC-31 | §13.3 | 删除示例后无菜单/API/目录残留，空库/升级/核心冒烟 |
| AC-32 | §14.3–4 | 旧库夹具升级、自定义角色/业务保留及回退路径 |
| AC-33 | §14.1–2 | 缺配置/假秘密/生产 Mailpit 拒绝，dev:reset 环境保护 |
| AC-34 | §3.2、§5.2、§7.2 | 默认角色编辑与资格变更保护，旧 Pending 不换角色 |
| AC-35 | §5.1 | 自定义管理员在所有管理入口均受目标完整集合约束 |
| AC-36 | §6.3、§12.3 | 另设备 reauth 不共享；恰好 5分钟失效；不自动重放写请求 |
| AC-37 | §7.3、§8.2 | 角色只改名也使旧邀请失效；重发快照与发起者更新 |
| AC-38 | §10.1 | 领取即崩溃、SMTP 已受理后崩溃、超时未知、三次耗尽、旧租约回写 |
| AC-39 | §7.2、§7.5 | 请求替换/取消/到期，Pending 原验证抑制与恢复，旧邮箱凭证失效 |
| AC-40 | §4.5、§12.3 | 同键并发/不同正文/撤权/过期/响应丢失，不重复邮件或扣配额 |

### 15.3 容量与体验验证

固定 2 vCPU / 4GB，1万用户、100万日志、20并发列表每页20条，记录 P50/P95/P99、错误率、CPU/RSS、DB 查询计划/连接池/锁等待。用户/日志列表 P95≤500ms；5并发完整登录 P95≤1.5s；邮件受理 P95≤500ms（不计外部 SMTP）。

基准单独覆盖精确 COUNT、模糊姓名/邮箱、深分页、角色筛选、最少与最多角色关联撤权、权限变化后登录。测试样本须跨越正常限流窗口或使用合法分散账号/来源，不能把 429 的快速响应算作登录达标；另保存启用真实限流的抗压结果。

开发者体验由未参与实现的人记录，从声明工具已安装的干净副本开始；网络下载单列。30分钟启动、2小时模块接入、裁剪后的构建与核心冒烟分别有操作记录。未达到时说明瓶颈及经评审的调整，不降低密码算法或去掉事务来凑指标。

### 15.4 完成判定

每项证据包含需求 ID、模板/依赖/镜像版本、实际环境、前置数据、步骤、预期/实际、证据路径与遗留问题。发布门槛为全部 P0 通过、安全关键问题清零、目标环境恢复完成；本文只定义检查，不代表这些检查已经运行。

## 16. 扩展点、限制与需确认事项

### 16.1 P1 边界

OAuth 以后增加 ExternalIdentity(provider,subject) 唯一实体，不按邮箱自动合并；MFA 增加短期 AuthenticationTransaction，所有因子完成后才建立当前 Session；批量邀请逐项调用同一个单邀请用例并保存结果。P0 不预建这些表或开放对应路由。

认证扩展必须继续遵守授权版本、epoch、近期验证、最后管理员与同事务审计；不能引入一条跳过当前身份状态的新登录捷径。

### 16.2 评审与验证事项

| 事项 | 本文基线 / 决策负责人 | 截止点 |
| --- | --- | --- |
| 新增产品参数 | DD-01–12、ASCII 邮箱支持边界、安全参数可调范围、图片尺寸、资料脱敏等本轮建议由产品/维护者评审 | 拆实施计划前 |
| 精确依赖版本 | 沿用架构主版本，工程兼容验证后锁定；不声称当前已经安装或通过构建 | M0.5 |
| 密码参数与全局锁容量 | 候选值先通过目标机器压力与并发正确性验证 | M1–M3 |
| 创建角色默认不可委派的体验 | 普通管理员创建后由超级管理员启用资格；若希望自主管理，必须先修改 PRD 防提权边界 | M2 前 |
| 模板/弱密码数据许可 | 维护者选择，发布包附来源与许可；本设计不替其作法律选择 | 发布前 |
| SMTP、域名、异地备份、密钥托管 | 部署者填写实际配置并完成投递/恢复演练 | 发布前 |
| 保留策略和最终个人数据清理 | P0 软删除与 90/180天日志；更严格政策需单独数据清理设计 | 生产使用前 |

以上评审事项不影响交付本文，不据此新增基础设施、购买服务或执行生产操作。

## 17. 文档自检与参考

本次自检范围：与两份输入文档逐项对照；P0 AC-01–25、AC-29–40 的落点；接口命名、状态值、权限 Code、版本与幂等规则；全局锁顺序、角色引用、worker 终态及恢复代次一致性。实际程序测试、迁移、负载与恢复尚未执行。

本轮官方资料核对日期：2026-10-10。下面仅为算法/机制依据，工程参数为本项目建议：

- [PostgreSQL 17：显式锁](https://www.postgresql.org/docs/17/explicit-locking.html)：协调行锁的冲突与事务生命周期。
- [PostgreSQL 17：时间函数](https://www.postgresql.org/docs/17/functions-datetime.html)：事务时间与实际时间差别。
- [PostgreSQL 17：SELECT](https://www.postgresql.org/docs/17/sql-select.html)：任务领取中的 SKIP LOCKED。
- [OWASP：密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)：Argon2id 与工作因子。

后续实施计划以本文件为规格输入，分别落到工程基座、身份闭环、管理闭环和发布验证；改变任何 INV 不变量或 DD 决策时，先更新对应设计与验收记录。
