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

Worker 每秒轮询，单进程最多两个活动投递、数据库池最多 5 个连接。每 30 秒写入心跳，保存 epoch 的 SHA-256 而非原始值；启动时及之后每分钟回收过期租约。不同进程通过任务租约和版本隔离结果。SIGINT/SIGTERM 停止继续领取，等待已经领取的投递完成，最长 30 秒；被强制终止后由后续 Worker 回收租约。

安全通知独立使用数据库滚动配额，同一规范地址每分钟最多预留 5 次发送。超额只推迟任务并保留载荷，不消耗 SMTP 重试次数；Worker 无权改写登录或用户主动重发配额。SMTP 返回未知结果时无法保证邮件恰好发送一次，使用稳定 Message-ID 与任务状态诊断。

待交付：每分钟凭证/邀请/邮箱请求到期维护、无引用文件回收、运行记录及日志留存清理、完整健康诊断与运维指标。


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

用户管理已提供下列 API；管理页面仍待实现。密码重置邮件和邮箱变更接口见下一节。

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

`/change-email#token=…` 立即清除 fragment，仅在当前页面内存保留凭证。页面不会自动确认；用户明确提交后进入登录页，并向其他标签页广播会话失效。刷新或离开需重新打开原邮件。目前本人邮箱变更发起/取消界面与后台用户操作界面仍待接入。

## 浏览器页面与测试

当前可用 `/login`、`/register`、`/bootstrap`、`/verify-email`、`/forgot-password`、`/reset-password`、`/accept-invite`、`/change-email`、`/`、`/profile`、`/security`、`/sessions`、`/invites`、`/roles`、`/roles/:id` 和 `/permissions`，支持中文/英文、浅色/深色/系统外观。注册入口遵守公开设置；邀请管理支持分页筛选、详情、自定义角色选择、创建/重发/撤销/再次邀请、版本冲突核对及高权限近期验证；角色及权限页面见对应章节，其余管理页面及本人邮箱变更操作界面仍待实现。

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
