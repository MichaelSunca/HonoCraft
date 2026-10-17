# 当前本地运行说明

当前交付的是 P0 开发中的服务端、邮件 Worker、认证及个人资料页面；完整账号与后台管理仍待交付。`start:web` / `start:worker` 暂时通过 tsx 运行源码，尚不能替代最终编译后的生产部署。

## 首次密钥准备

应用不会生成或重置部署秘密。四份文件必须分别提供，生产文件只允许所有者读写，或所有者读写加受信任组只读（例如 `0600` / `0640`）；其他用户不可访问、组不可写。不要把秘密放进镜像或 Git。

- `MAIL_PAYLOAD_KEYRING_FILE`：JSON，形如 `{"active_key_id":"v1","keys":{"v1":"<32 随机字节的无填充 base64url 编码>"}}`。正常轮换时保留解密历史任务所需的旧 key。
- `DIGEST_KEY_FILE`、`CSRF_KEY_FILE`：各自独立的 32 随机字节，编码为 43 字符 base64url；可有一个末尾换行。
- `CREDENTIAL_EPOCH_FILE`：同样编码的独立随机代次。Web、Worker 与运维进程使用同一份外部文件。禁止在普通重启时重新生成；恢复后的代次轮换须走后续运维流程。

首次本地开发时可在仓库根目录运行以下 Node.js 24 命令。它只创建新文件，不覆盖已有文件，也不输出密钥内容：

```bash
node --input-type=module <<'NODE'
import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const directory = '.local/secrets';
const names = ['mail.json', 'digest', 'csrf', 'epoch'];
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const name of names) {
  try { await access(`${directory}/${name}`); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Secret files already exist; do not regenerate existing deployment secrets.');
}
const fresh = () => randomBytes(32).toString('base64url');
const contents = [JSON.stringify({ active_key_id: 'v1', keys: { v1: fresh() } }), fresh(), fresh(), fresh()];
for (const [index, name] of names.entries()) {
  await writeFile(`${directory}/${name}`, `${contents[index]}\n`, { flag: 'wx', mode: 0o600 });
}
console.log('Created local secret files. Keep them private and backed up separately.');
NODE
```

如果首次创建中途失败，检查已创建文件和权限；不要删除已运行实例的秘密来重试。

## 当前可用入口

1. 安装 Node.js 24 与 pnpm 10，执行 `pnpm install --frozen-lockfile`。
2. 复制 `.env.example` 为 `.env`，准备独立 PostgreSQL 17 数据库及 SMTP 配置；真实连接字符串只保存在本地或部署秘密中。
3. 准备上述秘密，执行 `pnpm env:check -- --mode=development`。
4. 使用迁移账号执行 `pnpm db:migrate`，给应用登录账号授予 `honocraft_web` 角色。应用运行账号不得使用迁移账号的高权限。
5. 当前保持 `EXAMPLE_NOTES_ENABLED=false`，与现有数据库目录一致；示例模块的显式目录迁移后续交付。
6. 执行 `pnpm build:web` 生成同源页面资源；修改前端源码后重新构建。
7. 分别执行 `pnpm start:web` 与 `pnpm start:worker`；开发时也可分别用 `pnpm dev:server` 与 `pnpm dev:worker` 监听源码。Worker 必须使用独立的 `WORKER_DATABASE_URL`，对应登录账号只授予 `honocraft_worker` 运行角色。

当前监听 `127.0.0.1:$PORT`。生产配置仍要求 HTTPS PUBLIC_ORIGIN，应在同机可信反向代理后使用；容器绑定与部署方案尚待交付。`Web ready` 只表示启动检查和监听成功，不表示全部 P0 功能或外部 SMTP 已验证。

可读接口包括 `/health/live`、`/health/ready`、`/api/v1/public/settings`。未初始化时普通 API 返回 `SYSTEM_NOT_INITIALIZED`，不创建默认账号。本机签发后，打开 Worker 投递的邮件链接即可在 `/bootstrap` 设置管理员名称和密码；完成后单独登录。运行时若缺少 `apps/web/dist/index.html`，仅提供 API，因此需先构建前端。

启动会验证外部秘密、密码数据、PostgreSQL 17、全部迁移校验和与权限目录；Web 不使用环境中的迁移、维护或 Worker 连接字符串。生产应分别注入各进程实际需要的环境变量，避免把运维凭证传给 Web。SIGINT/SIGTERM 停止接收请求、等待进行中的连接并关闭数据库池，最长 30 秒。

## 离线密码列表

[data/passwords](../data/passwords/) 随版本保存 100,000 行常见密码样本、SHA-256、来源提交与上游许可。启动只读取本地文件，校验版本、摘要和行数；损坏或缺失会阻止启动。它用于阻断常见弱密码，不代表覆盖全部已泄露密码。用户提交的密码不会被发送到第三方做比对。

## 本机初始化命令

在本机部署环境中使用具有初始化写权限的 `MIGRATION_DATABASE_URL` 执行运维入口（连接池最多 2）；不要把这份连接凭证传给 Web 或 Worker。应用须已完成显式迁移，Web、Worker 与本机命令共用同一份秘密文件。

```bash
pnpm ops:init -- --email=owner@example.com
# 需要重发时，遵守当前发送冷却与配额
pnpm ops:init -- --email=owner@example.com --resend
# 仅用于取消尚未激活的初始化，之后才允许换邮箱
pnpm ops:init -- --cancel --reason="Wrong initial address"
```

命令只创建无密码、无角色的待初始化用户并将加密邮件持久化入队；Worker 在初始化完成前也能投递 bootstrap 邮件。CLI 不返回明文凭证或完整初始化链接。普通重复执行不重发；已初始化后返回 `ALREADY_INITIALIZED`，不新增账号。重发遵守当前策略（默认 60 秒冷却、同地址用途每小时 5 次、本机来源每小时 20 次），成功后替换旧凭证，失败则保留现有有效凭证。

输出 JSON 含 `operation_id`、`status`、`summary` 与 `next_step`；失败时输出固定错误 Code，限流时附 `retry_after` 秒数。退出码：0 已受理或已初始化，2 参数/配置错误，3 阶段/邮箱/版本或配额冲突，4 依赖不可用。取消要求原因并记录审计，不可用于逆转已激活系统。

## 邮件进程

Worker 每秒轮询，单进程最多两个活动投递；邮件/文件/到期工作共用最多 4 个 runtime_worker 连接，留存清理单独使用最多 1 个 maintenance 连接，总上限为 5。启动必须同时提供 `WORKER_DATABASE_URL` 和 `MAINTENANCE_DATABASE_URL`，不回退 Web 或迁移连接；两个连接都先验证迁移/目录，维护连接另检查权限，拒绝用 Worker 或过度授权的 owner 代替。全部检查通过后才领取邮件。每 30 秒写入心跳，保存 epoch 的 SHA-256 而非原始值；启动时及之后每分钟回收过期租约。不同进程通过任务租约和版本隔离结果。SIGINT/SIGTERM 停止继续领取，等待已经领取的投递完成，最长 30 秒；被强制终止后由后续 Worker 回收租约。

安全通知独立使用数据库滚动配额，同一规范地址每分钟最多预留 5 次发送。超额只推迟任务并保留载荷，不消耗 SMTP 重试次数；Worker 无权改写登录或用户主动重发配额。SMTP 返回未知结果时无法保证邮件恰好发送一次，使用稳定 Message-ID 与任务状态诊断。

文件回收与邮件轮询并行运行，启动时恢复并每小时执行；共用最多 4 连接的 Worker 池，不使用 Web 或迁移凭证。邮件投递被阻塞时不妨碍文件回收，退出时一并停止新回收、排空当前工作。

到期维护在启动时及每分钟运行，使用 runtime_worker 连接和固定函数；该工作不使用 maintenance 权限。先应用全部迁移（含 `0007_expiry_functions.sql` 与 `0008_retention_support.sql`），当前版本启动仍只校验迁移，不自动安装函数。

- `expire_pending_invites(integer)`：仅将到期 Pending 邀请更新为 expired、递增版本，撤销相关未消费凭证，取消 queued/sending 邮件并清除完整收件人和加密载荷。
- `expire_email_change_requests(integer)`：终结到期 Pending 邮箱请求，版本递增及凭证/邮件清理与邀请相同；保持用户当前邮箱、状态、密码和账号版本不变。
- `expire_one_time_credentials(integer)`：撤销到期且未消费/未撤销的一次性凭证，取消相关待发邮件；不改变有效后续凭证或账号。

三者只接受 1–100 的批大小，无用户 ID、状态或时间参数；PUBLIC/Web/maintenance 无 EXECUTE，Worker 仍无用户/请求/凭证表的通用 UPDATE 权限。函数固定 search_path，关系均带 public schema，使用 UPDATE 协调后按用户/角色/对象/凭证顺序锁定；等待锁后重新检查当前状态和到期时刻，锁忙的对象跳过。每批状态、凭证撤销、载荷清除、开始/成功审计同事务，审计失败全部回滚。邀请和邮箱请求另记对象 ID 与版本变更，凭证到期仅记批计数，不将 Token 或地址写入审计。

常驻循环每次用独立有预算事务调用固定函数并释放连接；多批对象逐批处理，停止信号到达后不再开始新批。SMTP、文件回收与到期循环并行，共用最多 4 个 Worker 连接；完成日志只有固定事件及邀请/邮箱请求/凭证计数，失败不输出原始异常或私密内容。已进入 SMTP 的邮件不能撤回，但取消会清除租约并递增 lease_version，迟到结果不能覆盖终态。

过期链接始终由消费接口按数据库当前时间即时拒绝，不等待 Worker 才失效。Worker 故障时维护可以延后，不能据此延长链接资格。完整健康诊断仍待交付。

### 运行记录与日志留存

独立 maintenance 池只用于固定留存任务，Web 仍不加载该连接。启动即运行，之后运行记录每小时一轮、日志每天一轮，调度使用单调时间；失败记录固定 failed 事件，日志失败在下一小时重试，不阻止其他清理。SIGTERM 等待当前有事务预算的批次结束，不再开始新批。

- 会话与一次性凭证终态元数据保留 7 天；待处理邀请/邮箱请求及 queued/sending 邮件引用使凭证保留。先将合格终态邮件的 `credential_id` 置空，保持邮件 `updated_at` 不变，再删凭证；不会级联删除用户或业务对象。
- sent/failed/cancelled 邮件按 `updated_at` 保留 90 天；完整地址与载荷仍在终态转换时立即清除。
- 删除已到期幂等记录、过期限流 bucket 和离线超过 24 小时的心跳。未来锁定及有活跃子 bucket 的 sentinel 保留；请求用原子 upsert 持有 sentinel 行锁，清理跳过锁忙行，避免初始化与删旧状态竞争。
- 审计与安全事件按事件 `created_at` 分别保留 180/90 天；`LOG_RETENTION_DAYS` / `SECURITY_RETENTION_DAYS` 可设为 1–3650，不接受任意表名、SQL 或任务脚本。

每批最多 1000 行，批间提交并释放连接；开始/完成审计和计数与删除（或断开引用）同事务，审计失败整批回滚。维护账号没有用户/角色的更新权限，也没有审计 UPDATE 权限；仅 maintenance 能执行的 `lock_retention_candidates` 固定函数提供有界 `SKIP LOCKED` 选择，不能由 Web/Worker 直接调用。Worker 输出只有固定事件、任务数量及中断标记，其中 `task_links` 是断开引用数，其他字段为删除数；不输出连接串、地址或原始异常。


## 操作结果查询

请求响应丢失后，可用原操作名和原 UUID 幂等键查询已提交结果：

```http
GET /api/v1/operations/users.status/00000000-0000-4000-8000-000000000001
```

携带当前有效会话 Cookie，不需要 CSRF 或原写入正文。成功固定返回 200，`data` 只有 `outcome`、`resource_id`、`version`、`completed_at`；其中 ID/版本可为 null，外层仍包含 request_id。即使原写入成功状态是 201/202，查询也是 200，没有 replayed 标记。响应 no-store，不返回姓名、邮件地址、笔记正文、旧资源 DTO、策略上下文、凭证或请求摘要。

可查操作来自 contracts 的 `OPERATION_NAMES` 与服务端固定策略注册表，两者通过类型检查对应；新增操作须补领域历史授权和真实写入后查询测试。

| 分组 | 操作名 |
| --- | --- |
| 会话/本人密码 | auth.session.revoke、auth.sessions.revoke_others、me.password.change |
| 图片 | me.avatar.update/delete、settings.branding.logo.update/delete、settings.branding.favicon.update/delete |
| 设置 | settings.branding、settings.security |
| 邀请 | invitations.create/resend/revoke |
| 角色 | roles.create/update/copy/delete/eligibility |
| 用户管理 | users.profile/status/delete/roles/reset |
| 邮箱请求 | email-change.self-start/self-cancel/admin-start/admin-cancel |
| 参考笔记 | example.notes.create/update/delete |

名称含 `/` 的写法表示分别列出的操作后缀，例如 `roles.create` 与 `roles.update`，不是实际 URL 中的斜杠。共 31 项；参考模块需部署配置和当前目录均开启，并持有对应当前读取/写入权限。

查询只查当前 actor + operation + key 的记录；超级管理员也不能查询另一操作者的键。键 UUID 大小写统一用于摘要查找，不支持 actor_id、owner_id 或其他 query 字段，传入多余字段为 422。未知操作/非法键、尚无已提交可见记录、保留期已过、摘要密钥代次不匹配、缺权限/超出目标范围或历史元数据不足，统一 404 OPERATION_NOT_FOUND。原会话已被密码/授权/状态变更撤销时先返回 401，须重新登录；新会话仍只能查本人记录。

角色/用户/邀请/邮箱请求复核历史与当前保护范围；角色删除后依赖原身份快照，不能因为目标已不存在而放宽检查。用户软删除清空当前角色后，原受保护范围仍保留；已移除的历史角色现在变为不可委派，也会影响读取资格。本人笔记删除后可读取本人的最小成功摘要。查询不需要重交旧版本、原密码或确认文本，也不重新触发写入所需的近期验证；原同键写入重放仍保留原有确认、近期验证和授权规则。

查询使用同一有预算事务，按安全协调 → 当前用户/角色 → 会话顺序验证，再读取结果；等待安全变更提交后重新认证。已提交前提下也不延长结果的 24 小时保留期、不重新发邮件或新增业务审计，沿用正常会话活跃时间更新。锁/语句/事务超时为 503 BUSY_RETRY，Retry-After 为 2 秒；其他数据库故障仍是依赖/内部失败，不伪装成不存在。

404 不能证明原写入一定失败，也不意味着可以自动换新幂等键再次提交。先核对目标实际状态；结果不明时保留原操作及键。当前页面已有的同键重试继续可用，统一的“查询结果”页面交互尚未接入。

## 已接入的公开认证接口

在已初始化实例上，以下同源 JSON POST 接口可用；所有请求须携带与 PUBLIC_ORIGIN 一致的 Origin，遵守大小和来源限流。相应页面已接入同源 API，接口及主要页面流程使用真实 HTTP / Chromium 测试验证。

| 路径（相对 `/api/v1/auth`） | 输入 | 成功结果 |
| --- | --- | --- |
| `/register` | email、password、display_name | 202 accepted；注册开关须打开 |
| `/email/resend` | email | 202 accepted；已有 Pending 注册账号不受注册开关关闭影响 |
| `/email/verify` | token | 200 verified、login_required；不自动登录 |
| `/password/forgot` | email | 202 accepted；不撤销现有会话 |
| `/password/reset` | token、new_password | 200 reset、login_required；撤销目标全部会话并清浏览器 Cookie |
| `/invites/preview` | token | 200 instance_name、email、expires_at；不消费凭证 |
| `/invites/accept` | token、password、display_name | 200 accepted、login_required；不自动登录 |

注册保存当时的默认角色，邮箱验证不会改用新的默认角色；角色后来不再合格则拒绝激活。重复注册不覆盖已有账号密码。存在有效邮箱修正请求时，不重发或消费原邮箱验证链接。

找回密码对不存在、Pending、禁用和有效账号返回相同响应；只有有效且已验证的本地密码账号会入队重置邮件。邮箱特定发送额度内部抑制，来源 IP 超额返回 429。重置凭证用途、版本、邮箱、epoch 和当前用户状态均在提交事务中重查；成功时消费凭证、撤销其他重置/恢复凭证和会话、记录审计、入队安全通知，失败则一起回滚。

邀请邮件指向 `/accept-invite#token=…`。页面立即清除 fragment，仅在当前页面内存中保留凭证；预览显示实例、目标邮箱及到期时间，用户填写名称和密码后明确接受。接受会重新检查邀请人当前资格和全部角色版本，创建已验证账号并分配原角色集合；角色变化要求管理员重发，已占用邮箱返回冲突。账号、角色、邀请终态、凭证消费、邮件取消与审计同事务提交。刷新或离开页面后需重开邮件。当前已交付预览/接受 API 和页面，以及下面的邀请管理 API 与 `/invites` 管理页面。

## 邀请管理接口

以下路径相对 `/api/v1`，要求当前有效会话。GET 需要 `invite:read`；POST 需要 `invite:manage`、Origin、CSRF 和 UUID `Idempotency-Key`，并检查当前可授予角色范围。

| 方法 / 路径 | 输入 | 成功结果 |
| --- | --- | --- |
| GET `/roles`、`/roles/:id` | role:read；分页 query/code/is_builtin | 角色、权限、引用计数及当前操作资格，不含用户明细 |
| GET `/invites` | page/page_size、query、status、inviter_id、created_from/to、sort、direction | 邀请分页及总数 |
| GET `/invites/:id` | UUID | 邀请详情、角色快照、邮件摘要和可用操作 |
| POST `/invites` | email、可选 role_ids、高权限时 confirmation | 202 id/version/status/expires_at/mail_status |
| POST `/invites/:id/resend` | expected_version、confirmation | 202 新版本及到期时间，旧链接失效 |
| POST `/invites/:id/revoke` | expected_version、confirmation | 200 id/version/status=revoked |

创建缺省角色为内建 user，显式空数组拒绝。创建确认使用 `confirmation:{target_email,typed_label,reason}`；重发/撤销使用 `confirmation:{target_id,typed_label?,reason}`。高权限邀请要求真正超级管理员、`user:manage-privileged`、当前设备五分钟近期验证，typed_label 必须等于规范邮箱。服务端比较真实目标，不接受布尔“已确认”。

同一邮箱不能已有任何状态的用户，也不能已有有效 Pending 邀请。过期 Pending 在新建事务内终结，新邀请使用新 ID。重发保持 ID、增加版本，更新邀请人及角色版本快照；撤销释放 live 角色引用并保留历史名称。发送受当前地址用途冷却/小时额度及来源 IP 小时额度保护；配额不足不替换旧链接。相同幂等键与正文的重放不重复发送或扣配额，但仍检查当前授权和历史高权限要求；响应带 `replayed:true` 时 data 是最小操作摘要，应重新查询详情。

query 去除首尾空格后为空或 2–100 码点，`%`、`_` 按字面搜索。sort 只允许 created_at/email/expires_at，direction 为 asc/desc，ID 同方向作为次排序；日期 from 含、to 不含。同次列表和总数来自只读一致快照。已到期邀请直接显示 expired，不依赖维护 Worker；邮件摘要不含 Token、收件人载荷或 SMTP 内容。


## 角色与权限管理接口

以下路径相对 `/api/v1`。角色写入要求有效会话、`role:manage`、Origin、CSRF 和 UUID `Idempotency-Key`；目标操作还检查角色范围和 `expected_version`。

| 方法 / 路径 | 输入 | 成功结果 |
| --- | --- | --- |
| POST `/roles` | code/name/description/permission_codes；含保留权限时 confirmation | 201 RoleDto |
| PATCH `/roles/:id` | expected_version、name/description/permission_codes 至少一项、confirmation | 200 RoleDto |
| POST `/roles/:id/copy` | expected_version、new_code/new_name；含保留权限时 confirmation | 201 新 RoleDto |
| DELETE `/roles/:id` | expected_version、confirmation，typed_label 必须等于角色 Code | 200 `{deleted:true,id}` |
| PUT `/roles/:id/eligibility` | expected_version、is_delegable/is_registration_default_eligible、confirmation | 200 RoleDto |
| GET `/permissions` | permission:read；可选 module | 200 `{catalog_version,modules:[{module,permissions:PermissionDto[]}]}` |

创建/复制得到新的自定义角色，两个资格均为 false，不继承内建身份。非超级管理员创建后可能没有继续编辑该角色的资格，需要超级管理员设置委派资格。权限必须来自已启用目录，必须显式包含前置依赖；非超级管理员只能授予自身拥有的可委派权限，不能维护本人持有或分配给高权限账号的角色。

含保留权限的创建/复制/修改/删除要求真正超级管理员、当前设备五分钟近期验证与角色 Code 确认。创建用 target_code，其余用 target_id；资格变更始终要求真正超级管理员和近期验证，变更委派需 role:delegate，变更注册资格需 settings:update-security。内建角色不可编辑/删除/改资格。当前注册默认及保留注册引用的角色须持续自助合格；删除存在引用时返回 ROLE_IN_USE 及引用计数，不隐式删除关系。

所有角色编辑增加角色版本；权限集合或资格变化在同一事务递增关联用户编辑/授权版本、撤销会话并记录审计与安全事件。纯名称/描述编辑不撤销会话，但旧邀请因角色版本不匹配而不能接受。幂等重放返回最小操作摘要，仍复核当前及历史权限范围；客户端需刷新详情。

`/roles`、`/roles/:id` 提供角色分页筛选、详情及操作对话框；资格设置独立于名称/权限编辑。权限依赖必须明确勾选，创建或复制后提示初始资格关闭。高风险操作先输入角色 Code；近期验证成功后仍需明确再次提交。冲突保留草稿并展示最新版本，新增引用会禁用删除；响应不确定时冻结正文并使用同一幂等键重试。`/permissions` 单独检查 permission:read，支持模块筛选、中英文名称/说明、依赖及权限属性查看。

## 用户管理接口

用户管理已提供下列 API；对应操作可从 `/users` 列表及 `/users/:id` 详情进入。密码重置邮件和邮箱变更接口见下一节。

| API（相对 `/api/v1`） | 输入 | 结果 |
| --- | --- | --- |
| GET `/users` | user:read；page/page_size、query、status、role_id、created_from/to、sort、direction | items、page、page_size、total |
| GET `/users/:id` | user:read；UUID | 用户详情、当前操作资格、近期验证要求、可见邮箱变更摘要及审计入口资格 |
| PATCH `/users/:id/profile` | user:update；expected_version、display_name；高风险时 confirmation | id、display_name、version |
| POST `/users/:id/status` | user:change-status；expected_version、action=suspend/enable、confirmation | id、status、version |
| DELETE `/users/:id` | user:delete；expected_version、confirmation | id、status=deleted、version |
| PUT `/users/:id/roles` | user:assign-role；expected_version、role_ids 完整集合（可为空）、confirmation | id、role_ids、version、login_required=true |

列表默认隐藏 Deleted，显式状态筛选可查询。query 为空或 2–100 码点，`%`、`_` 按字面搜索；sort 仅 created_at/display_name/email，direction 为 asc/desc。日期范围左闭右开，排序同值用 ID 稳定分页。本人或可管理目标邮箱完整显示，范围外目标只显示首字符和域名；邮箱搜索和排序同样使用可见值，不查询隐藏地址。待变更邮箱仅本人或仍具管理资格的原发起者可见，过期项直接排除。返回操作资格表示授权和状态判断；接口交付范围以上表为准。

所有写入需要 Origin、CSRF 和 UUID Idempotency-Key。确认结构为 `confirmation:{target_id,typed_label?,reason}`；删除和高权限操作要求 typed_label 等于锁后目标规范邮箱，高权限操作还要求真正 super_admin、user:manage-privileged 和当前设备五分钟近期验证。后台禁止修改本人角色、状态或删除本人；本人资料使用 `/me`。

资料修正仅接受 display_name，递增编辑版本，使用共享安全事务，不撤销会话。角色替换仅适用于 Active，检查旧角色与完整新集合、依赖和最后可用超级管理员，递增编辑/授权版本并撤销全部会话。Pending、Suspended 不允许直接分配角色。禁用取消目标全部未消费凭证、邮箱请求、其签发的 Pending 邀请和相应邮件，并发送停用通知；启用依据邮箱是否已验证恢复 Active 或 Pending，不恢复旧凭证或会话。软删除保留邮箱占用和历史数据，清除角色/保留注册引用，将头像转为待清理状态。

审计、安全事件、用户版本、撤销与通知入队在同一事务完成。版本冲突不覆盖新值；同键重放只返回最小结果摘要，重新检查当前权限、目标范围及历史角色范围/高风险要求，不重复撤销或发信。

用户页面分别检查 user:read 与 allowed_actions。列表支持搜索、状态、角色、创建时间、排序和 URL 分页；Deleted 默认隐藏，角色标签可直接筛选，日期在实例时区显示。高权限范围外的账号显示 masked_email，操作按钮隐藏；普通成员直接访问同样拒绝。详情返回 requires_typed_confirmation_actions，明确区分输入邮箱确认与仅需近期验证的操作。

角色选择分页搜索完整目录、跨页保留选择，使用当前角色属性、共享权限定义及自身有效权限提示可授予范围；不依赖 invite:manage。允许移除失效选择并明确提交空角色集合。服务器仍在写入时验证完整新旧角色范围。冲突保留名称、理由、角色和邮箱草稿，读取最新详情供比较；被替换的邮箱取消请求不能自动转向新请求。后台刷新和网络重连保留进行中的对话框、原始请求与幂等键，401 则清除整个账号缓存与草稿。头像和详情审计跳转会随媒体/日志模块接入。

## 密码重置邮件与邮箱变更

| API（相对 `/api/v1`） | 输入与权限 | 结果 |
| --- | --- | --- |
| POST `/users/:id/password-reset` | user:reset-password；expected_version、confirmation；高风险目标需近期验证和规范邮箱确认 | 202 `{accepted:true}` |
| POST `/me/email-change` | 本人近期验证；expected_version、new_email | 202 request_id、request_version、user_version、expires_at |
| DELETE `/me/email-change` | 本人；expected_version、request_id、request_version | cancelled、user_version |
| POST `/users/:id/email-change` | user:update-email、完整目标范围、近期验证；expected_version、new_email、confirmation | 与本人发起相同 |
| DELETE `/users/:id/email-change` | user:update-email、原发起者、当前目标范围；expected_version、request_id、request_version；高风险时 confirmation | cancelled、user_version |
| POST `/auth/email-change/confirm` | 无会话；token；同源 Origin | changed、login_required；清 Cookie |

受保护写入均要求 CSRF 和 UUID Idempotency-Key。管理员重置只向目标邮箱发送验证链接，签发时不改密码、用户版本或当前会话；用户完成重置时才修改密码并撤销会话。邮件发送与匿名找回共享来源配额及同地址/用途冷却；限流不会替换旧链接，同键重试不重复发信。失败审计导致签发和配额同事务回滚。

邮箱变更在验证前保留原登录邮箱，新邮箱不预占；完成时再次检查全局唯一性。发起和取消递增用户编辑版本，替换/取消撤销旧链接和任务；管理员修正 Pending 邮箱不会直接激活，先撤销原邮箱验证凭证，新地址验证后再按原注册角色规则激活。取消只允许本人或当前仍具资格的原发起者。旧请求到期后可重新发起；待变更新邮箱从不作为登录地址。

确认再次检查最新请求、用途、版本、epoch、期限、目标状态及管理员发起者当前资格。成功后原子替换邮箱、标记验证、增加编辑/授权版本、撤销所有会话及其他未消费凭证，记录审计/安全事件并向原邮箱发送完成通知；密码保持原值。两个用户申请同一地址时，以实际完成的唯一约束为准，冲突保留原邮箱及未消费请求。新旧邮箱只以脱敏摘要进入审计，凭证和邮件载荷仅保存在加密 outbox。

`/change-email#token=…` 立即清除 fragment，仅在当前页面内存保留凭证。页面不会自动确认；用户明确提交后进入登录页，并向其他标签页广播会话失效。刷新或离开需重新打开原邮件。

`/security` 已提供本人邮箱操作：显示当前地址、待验证地址及实例时区到期时间；发起/替换/取消均先确认目标。服务器要求近期验证时在确认框验证密码，成功后仍需用户明确再次提交。版本冲突保留新邮箱草稿、显示最新账号/请求，用户核对后才能使用新版本；旧取消操作不会自动转向替换后的请求。网络或 5xx 不明结果保留同一请求体和幂等键，并冻结编辑以重试原操作。写入已确认但读取最新状态失败时，只重试刷新；成功前不启用下一次邮箱写入。管理员邮箱操作在用户详情中提供，并按当前目标权限摘要显示。

## 浏览器页面与测试

当前可用 `/login`、`/register`、`/bootstrap`、`/verify-email`、`/forgot-password`、`/reset-password`、`/accept-invite`、`/change-email`、`/`、`/profile`、`/security`、`/sessions`、`/invites`、`/users`、`/users/:id`、`/roles`、`/roles/:id` 和 `/permissions`，支持中文/英文、浅色/深色/系统外观。注册入口遵守公开设置；邀请管理支持分页筛选、详情、自定义角色选择、创建/重发/撤销/再次邀请、版本冲突核对及高权限近期验证；账号安全、角色及权限页面见对应章节，其余管理页面仍待实现。

邮件凭证从 fragment 进入当前页面内存后立即清除地址栏；打开页面不消费凭证，必须主动提交。刷新或离开页面后需重新打开原始邮件。账号切换、退出、密码重置和受保护请求 401 清除保护缓存及草稿，标签页通过不含凭证的 BroadcastChannel 信号同步失效。退出网络失败会保留“尚未确认”提示并提供重试，不声称服务器会话已撤销。

个人资料提交使用服务端版本；409 时保留草稿并展示最新值，用户确认最新版本后再次提交。语言和外观的页头切换仅保存在当前页面内存；个人资料中的偏好通过保存持久化到账号。

`pnpm test:e2e` 先构建前端，再启动隔离 PostgreSQL 与真实 HTTP 服务运行 Chromium；不依赖开发者 `.env` 或业务数据库。首次运行使用 `pnpm exec playwright install --with-deps chromium` 安装浏览器及系统依赖，Linux 截图还需 CJK 字体（例如 Noto CJK）。浏览器资源可通过 `PLAYWRIGHT_BROWSERS_PATH` 自定义；受限环境可使用已准备的共享库和 fontconfig 配置，勿将这些机器路径写入应用配置。

测试关闭 trace，失败截图在忽略的 `test-results/`，可视检查截图在 `.local/previews/`；截图只使用隔离测试数据。未运行完整 P0、Docker、备份恢复与性能验收。


## 本人账号安全与会话

`/security` 提供当前密码验证与本人改密。近期验证只作用于当前 session，有效区间为五分钟，不因浏览页面刷新。输入错误密码不会撤销现有会话；错误受来源 IP 与账号共享失败计数约束。改密每次重新验证原密码，提交时检查用户编辑版本和密码版本；成功后撤销所有会话与尚未消费的重置/恢复凭证，取消相应旧邮件、写审计并发送安全通知，然后要求重新登录。

`/sessions` 分页列出本人当前仍有效的会话，显示当前设备、尽力识别的设备类别/浏览器/系统、来源 IP 和实例时区时间。可以确认撤销指定会话或退出其他设备。撤销自己当前会话会清 Cookie 并回登录；撤销其他设备保留当前会话。过期记录不等待 Worker 清理即可从列表排除。

| API（相对 `/api/v1`） | 输入 | 结果 |
| --- | --- | --- |
| POST `/auth/reauthenticate` | current_password | reauthenticated_at、valid_until |
| POST `/me/password` | expected_version、current_password、new_password；Idempotency-Key | changed、login_required；清 Cookie |
| GET `/me/sessions` | page、page_size | items、page、page_size、total |
| DELETE `/me/sessions/:id` | 空 JSON；Idempotency-Key | revoked、is_current |
| POST `/me/sessions/revoke-others` | 空 JSON；Idempotency-Key | revoked_count |

所有写入均校验 Origin 和当前会话 CSRF。幂等键为 UUID：首次完成返回对应 DTO，合法重放返回最小 operation summary 并标记 `replayed:true`，前端刷新列表获取最新状态。响应不确定时保留同一正文和幂等键，不自动换键重试；编辑正文后使用新键。密码提交的凭证仅留在当前表单内存，离开页面即丢弃。改密成功本身使旧会话失效，响应丢失后也不能用旧 Cookie 重新取得身份，需重新登录。

## 系统设置接口与页面

`/settings` 导航和直接访问要求 settings:read。GET `/api/v1/settings` 返回 branding/security 两组值、各自 version、allowed_actions 和 requires_reauth_actions，不返回部署密钥。普通管理员可读取安全策略，不能提交保留操作。

- PATCH `/api/v1/settings/branding` 要求 settings:update-branding、Origin/CSRF、UUID Idempotency-Key；正文完整包含 instance_name、copyright、default_locale、default_theme、timezone 和 expected_version。文件 ID 与任意 URL 不在普通更新接口内；品牌图片使用下述专用媒体接口。
- PATCH `/api/v1/settings/security` 要求真正的内建超级管理员、settings:update-security、当前设备五分钟近期验证、Origin/CSRF 和 UUID Idempotency-Key。提交完整安全组和 expected_version；confirmation 固定 target_id/typed_label 为 security，另附 1–500 码点 reason。字段范围见详细设计 §11.1。

默认注册角色仅接受仍具注册资格、仅含可自行赋予权限且依赖完整的角色；只影响未来注册，已有 Pending 的角色引用不变。安全设置与审计、安全事件、幂等摘要和已签发会话期限收紧在同一事务完成；任一失败全部回滚。缩短后立刻放宽也不能恢复原先的更晚会话期限，即使期间没有该会话的请求。更新成功但当前会话因新期限过期时，后续读取会清除本地账号状态并转到登录页。

页面分别编辑两组，采用服务端当前版本，不做乐观成功更新；安全组提供合格角色分页搜索、原因与输入确认。重新验证后须再次明确保存；网络结果不明时冻结正文和原幂等键，验证窗口过期也继续保留原操作。冲突展示完整当前组供比较，采用版本时保留草稿；保存会覆盖整组。写入已确认而刷新失败时，只提供重新读取，不重复提交。品牌保存后刷新 me、设置及公共设置缓存，使实例标题、页脚和默认偏好生效。

## 审计、安全事件与邮件任务只读接口

以下 API 均要求当前有效会话，各自独立检查权限；拥有一类读取权限不会取得另一类。它们只提供 GET，不提供后台改写、删除或强制重放任务。

| 路径（相对 `/api/v1`） | 权限 | 额外筛选字段 |
| --- | --- | --- |
| `/audit-events`、`/audit-events/:id` | audit:read | actor_id/action/target_type/target_id/result |
| `/security-events`、`/security-events/:id` | security-log:read | user_id/event_type/result |
| `/email-tasks`、`/email-tasks/:id` | email-task:read | purpose/status |

共同查询项：page（缺省 1）、page_size（缺省 20，上限 100）、from（含）、to（不含）、sort（仅 created_at）、direction（缺省 desc，可 asc）。日期须含时区且 from 早于 to；按 created_at 与同方向 ID 稳定排序，列表与总数来自同一只读快照。未知字段或非法 ID/枚举/范围返回 422；不存在的详情返回 404，未授权时先拒绝读取。响应 no-store。

审计输出严格白名单变更、脱敏名称快照、原因和 User-Agent，不返回历史 JSON 中的未知键；敏感/无效字段单独省略。新审计在同一事务存储当前用户的脱敏名称快照，改名和软删不改写历史快照。没有旧快照时保留类型/ID，不伪造历史名称。

安全事件不返回匿名 target_digest 与 allowed_metadata。邮件任务仅返回脱敏收件人、用途、状态、尝试次数、稳定错误码及时间等公开字段；不返回 recipient、credential_id、加密载荷、key/nonce/tag、租约或 provider_message_id。仅 queued 返回 next_attempt_at，其余状态返回 null；未知历史错误统一 UNKNOWN_ERROR，异常掩码显示 [redacted]。失败验证/重置/邀请仍需使用原业务流程与配额重发。日志页面及用户详情的审计跳转随后接入。

日志页面位于 `/audit`、`/security-events`、`/email-tasks`，导航与直接 URL 访问按对应读取权限独立控制。筛选、排序、分页保留在 URL；前端 `detail=<UUID>` 打开详情抽屉，不传入列表 API。刷新页面可恢复详情，关闭/键盘 Escape 保留原筛选并恢复来源焦点。列表及详情提供显式重读，详情刷新也更新列表；这不改变任务状态或触发邮件发送。用户详情的「查看审计记录」按 user 目标类型/ID 跳转。邮件详情展示稳定错误说明与掩码、任务时间及供应商受理语义，必要时链接邀请或用户管理原流程。

角色、邀请、用户管理、本人邮箱变更和设置表单共享不确定结果判定。除网络/5xx/响应无法解释外，REQUEST_IN_PROGRESS 也保持原请求和幂等键。已不确定的请求重试被近期验证、权限或 CSRF/Origin 等前置门禁拒绝时，继续保留原尝试；这些拒绝不能说明之前没有提交。验证通过后必须再次明确重试，验证期间禁用原业务提交，不能改用新键重新发信或覆盖角色版本。

## 受控头像与品牌图片

先运行 `pnpm db:migrate` 应用全部迁移（含 `0005_file_variants.sql` 和 `0006_file_cleanup_index.sql`），再启动当前版本；应用启动不会自动迁移。当前源码入口会加载 `modules/files/image-worker.mjs`，后续编译/镜像交付须保留该工作线程文件。

| 路径（相对 `/api/v1`） | 权限与输入 | 结果 |
| --- | --- | --- |
| PUT `/me/avatar` | 本人有效会话；multipart 仅一个 file 与 expected_version | avatar_url/user_version |
| DELETE `/me/avatar` | 本人；JSON expected_version | avatar_url=null/user_version |
| PUT `/settings/branding/logo`、`/favicon` | settings:update-branding；同样 multipart，使用 branding 组版本 | url/version |
| DELETE `/settings/branding/logo`、`/favicon` | settings:update-branding；JSON expected_version | url=null/version |
| GET `/media/avatars/:fileId` | 本人或 user:read 且当前完整目标范围允许 | 仅当前附着头像；no-store |
| GET `/media/branding/:fileId` | 公开；仅当前品牌引用 | 主图；public immutable |

所有写入均要求精确 Origin、CSRF 和 UUID Idempotency-Key。输入单文件最多 2 MiB，总请求最多 3 MiB；拒绝未知/重复字段。只接受实际 PNG/JPEG/WebP，拒绝 SVG、多帧、损坏内容及超过 1600 万解码像素。工作线程五秒硬截止、进程并发两路；头像重编码为 256×256 WebP，Logo 等比最长边 512 WebP，Favicon 64px 主 PNG 与 32px 变体。Favicon 可通过 `?size=32` 或 `?size=64` 读取；其他尺寸/Logo size 参数拒绝。

存储 key 由服务器生成，不使用原文件名或客户端路径。先建主/变体 staged 元数据，再写临时文件、同步与原子 rename，最后同事务复核当前权限、组版本、租约、引用、审计和幂等。失败保留原引用，候选转为可回收。相同键重试按原始图片摘要和版本识别，不把随机候选 ID 当作新正文；成功重放仅返回最小结果摘要，随后重读当前 me/settings。

API 请求使用配置中的 JSON/上传两种期限（缺省 15/30 秒），超时返回 BUSY_RETRY；图片自身处理截止更早。未完成正文的早期拒绝、超限与超时会明确关闭 HTTP 连接。

`/profile` 提供文件选择、上传及移除确认；`/settings` 按服务端 allowed_actions 显示品牌写入口。选择文件不立即发送，成功后只展示服务器重编码图片。冲突保留已选文件，明确采用最新版本后再确认；网络结果不明冻结 File、正文和幂等键，重试同一操作。写入成功但读取失败时仅重读图片状态。未编辑的个人资料表单随本人头像版本刷新；已编辑草稿保留原版本，保存时仍须处理冲突。登录页与工作台显示当前 Logo、实例名称和 32/64 Favicon，移除后使用内置标识。

Worker 每批最多锁定 100 个候选，跳过其他进程锁定的行；staged/orphaned 从最后状态变更 updated_at 满 24 小时且租约已过才可回收。锁文件后用新查询重查 users.avatar_file_id 和 branding 两项引用，不申请用户或全局安全行锁。标 deleting 与开始审计提交后，事务外逐个 unlink 主文件及变体并同步目录；元数据删除与成功审计同事务。缺失文件视为成功，IO/审计失败保留 deleting 供后续恢复；不会递归删除目录。

随后流式扫描媒体目录，仅处理严格匹配服务器 UUID 文件名、mtime 满 24 小时的普通临时文件/图片/32px 变体；任何已知父元数据或当前引用都使扫描跳过。未知名称、目录和符号链接保留。每批最多尝试删除 100 个散落文件，删除前提交审计意图；若删除后进程退出或完成审计失败，意图仍可供诊断，不能把缺少完成事件当作未执行。Worker 日志只记录固定事件名和计数，不输出文件路径、图片或凭证。审计留存清理使用独立 maintenance 连接，文件回收仅需 runtime_worker 权限。

## 个人笔记参考模块 API

此开发增量包含契约、模块声明、路由、owner repository、服务、双语页面及正式目录启停命令；彻底裁剪流程仍待交付。实例默认 `EXAMPLE_NOTES_ENABLED=false`；不能只修改环境变量开启，数据库模块标记和权限目录必须先按下述流程同步，否则进程启动拒绝兼容性检查。模块边界和新资源接入清单见 [MODULES](MODULES.md)。

| 路径（相对 `/api/v1`） | 权限与输入 | 结果 |
| --- | --- | --- |
| GET `/example-notes` | example-note:read；page/page_size/query/sort/direction | 本人笔记 items、total 与分页 |
| POST `/example-notes` | example-note:create + read；title/body | 201，当前 note DTO |
| GET `/example-notes/:id` | example-note:read + owner | 当前 note DTO |
| PATCH `/example-notes/:id` | example-note:update + read + owner；完整 title/body、expected_version | 200，递增版本后的 DTO |
| DELETE `/example-notes/:id` | example-note:delete + read + owner；expected_version | 200，id/deleted/最后版本 |

owner 永远来自当前账号，超级管理员同样不能读取、修改或删除其他 owner 的笔记；越界和不存在均返回 404。创建不接受 owner_id，其他写入也不接受客户端 id/version/额外字段。标题先 trim，再校验 1–120 Unicode 码点；正文保留空白，最多 20000 码点，拒绝 NUL。笔记 JSON 总量限 128 KiB，其他 JSON 接口仍为 64 KiB。内容以普通字符串返回，后续页面必须作为纯文本渲染。

query 为空或 2–100 码点，仅匹配标题，百分号/下划线按普通字符处理；sort 仅 created_at/updated_at/title，direction 为 asc/desc，id 同向打破平局。列表与总数同一只读快照，不接受 owner 筛选。DTO 不返回 owner_id，allowed_actions 表示当前可用更新/删除操作。

所有写入要求 Origin、CSRF 和 UUID Idempotency-Key；创建/编辑/删除及审计、最小结果摘要同事务。重放先验证当前会话、模块和权限，只返回 note ID、outcome、version、completed_at；删除后的合法重放仍可返回原完成摘要。审计仅记录笔记 ID、动作及版本，不复制标题/正文。重新创建操作不能借用不同正文的旧键，版本冲突不覆盖原内容。

页面 `/example-notes` 支持 URL 筛选、稳定分页、显式刷新与当前权限下的创建；详情地址保留返回列表的筛选参数。标题、正文用纯文本展示，没有 owner 选择或跨用户筛选。编辑/删除只显示服务端 allowed_actions；冲突保留草稿，展示当前标题/正文/版本后明确采用。网络结果不明冻结正文与原键，即使重连读到了已提交的新版本也不替换原操作；删除重放不要求已删除的资源仍存在。写入已确认但详情/列表读取失败只提供重读，避免再次创建、更新或删除。字段关联错误提示和焦点，支持中文/英文、深色、360px 窄屏与键盘关闭。

## 正式启用或停用参考模块

先执行当前版本 `pnpm db:migrate`，并在维护窗口停止 Web/Worker；不要与其他部署迁移并行执行。本机命令使用独立 `MIGRATION_DATABASE_URL`，不回退使用 Web 连接，也不需要读取邮件、CSRF 或 epoch 密钥内容。它只支持固定的 example-notes 目录转换，不接受任意模块名或 SQL。

```bash
pnpm ops:module -- --enable=example-notes --reason="启用个人笔记参考模块"
```

命令先校验实际数据库结构、迁移 checksum 和当前目录，事务内再次校验后才写入；与环境变量的目标值分离，不从 env 自动推断目录变更。成功后将部署环境 `EXAMPLE_NOTES_ENABLED` 设置为 `true`，运行 `pnpm env:check`，再重启 Web/Worker。全新实例也可在初始化前执行，随后按原流程初始化管理员。

启用加入四项严格权限及写依赖 read 的关系，不自动分配给 user/admin 或自定义角色。真正超级管理员按目录隐式拥有权限；需要给普通账号使用时，通过角色管理明确授权。

```bash
pnpm ops:module -- --disable=example-notes --reason="停用示例并保留笔记数据"
```

成功后把环境开关改回 `false`，检查并重启。停用仅移除该模块权限、依赖及角色授权，不删除笔记或历史迁移；无关角色与权限保留。两种转换都递增受影响角色版本（含隐式全目录的 super_admin）和持有账号的编辑/授权版本，撤销这些账号的所有 session。引用变更角色版本的 Pending 邀请标 revoked，凭证撤销、排队或 Sending 邮件取消并清除敏感载荷；不受影响的邀请保持有效。受影响账号需要重新登录，旧邀请需要按现有流程重新邀请。

整个转换与管理审计、安全事件同一事务，审计不可用则全部回滚。重复设置相同状态为 no-op，不重复递增版本。重新启用不会恢复被移除的角色授权，必须重新明确授予；保留的数据仍按原 owner 隔离。输出包含 operation_id、changed、enabled、角色/账号/邀请/权限计数及下一步，不输出连接串或笔记内容；退出码 0 成功/无需变化、2 参数/配置错误、3 结构/目录或业务冲突、4 依赖失败。连接结果不明时可按同一目标状态重试。

彻底裁剪模块的前向数据处理迁移、代码/导航移除与全新/升级副本验证仍待交付；停用不能当作已经删除数据或完成裁剪验收。
