# P0 验收证据与缺口

核对日期：2026-10-17。范围以 [PRD §13](../superpowers/specs/2026-10-10-honocraft-prd.md#13-核心验收场景) 为准：AC-01–25、AC-29–40，共 37 项；AC-26–28 为 P1，不计入本轮。

此表是验收索引，不是通过证明。候选测试文件存在、局部测试通过或整套断言通过，都不能自动证明一项 AC 的全部条件。每项最终还须保存环境/版本、前置数据、步骤、实际结果、运行证据及遗留问题；在完成逐条覆盖核对、完整浏览器与发布环境验证前，不标“通过”。运行结果和已知时钟问题见[实施记录](implementation-progress.md)。

“候选覆盖”表示已有相关实现/测试可供核对；“缺验证”表示还缺完整场景或环境证据；“缺交付物”表示明确仍有功能/发布物未实现。下列测试链接不声称覆盖该行所有分支。

| ID | 验收目标 | 当前判定 | 候选证据入口 | 仍需核验或补交 |
| --- | --- | --- | --- | --- |
| AC-01 | 初始化唯一超级管理员，无默认密码，重复不新增 | 候选覆盖 | [bootstrap](../../tests/integration/bootstrap.test.ts)、[本机命令](../../tests/integration/ops-init.test.ts) | 干净发布副本初始化/登录与完整页面记录 |
| AC-02 | 注册关闭同时约束页面/API，不影响邀请/旧账号 | 候选覆盖 | [公开认证](../../tests/integration/public-auth.test.ts)、[认证页面](../../tests/e2e/auth.spec.ts) | 同一部署配置下完整三条路径 |
| AC-03 | Pending 无会话、验证只激活一次、异常无副作用 | 候选覆盖 | [公开认证](../../tests/integration/public-auth.test.ts)、[凭证](../../tests/integration/credentials.test.ts) | 有效/过期/重复及后续入口的完整页面回归 |
| AC-04 | 重发使旧链接失效，扫描 GET 不消费 | 候选覆盖 | [公开认证](../../tests/integration/public-auth.test.ts)、[认证页面](../../tests/e2e/auth.spec.ts) | 扫描器 GET 前后数据库与真实链接证据 |
| AC-05 | 四类账号登录/找回防枚举，内部原因可审计 | 候选覆盖 | [登录](../../tests/integration/login.test.ts)、[公开认证](../../tests/integration/public-auth.test.ts) | 四状态公开响应与异常输出统一核对 |
| AC-06 | 登录/发送配额、恢复窗口、多进程共享 | 缺验证 | [共享限流](../../tests/integration/rate-limit.test.ts)、[通知配额](../../tests/integration/mail-notification-limit.test.ts) | 两个真实 Web 进程共享配额的完整证据；边界/暂锁恢复 |
| AC-07 | 重置后新密码可用，旧链接/全部旧会话无效 | 候选覆盖 | [公开认证](../../tests/integration/public-auth.test.ts)、[账号安全](../../tests/integration/account-security.test.ts) | 新旧 Cookie/链接及无自动登录的页面闭环 |
| AC-08 | 本人会话列表/单设备撤销/退出其他设备 | 候选覆盖 | [会话管理](../../tests/integration/session-management.test.ts)、[安全页面](../../tests/e2e/security.spec.ts) | 逐设备下一请求失败及他人会话不可见 |
| AC-09 | 禁用阻断，启用不复活旧会话 | 候选覆盖 | [用户管理](../../tests/integration/http-users.test.ts)、[用户页面](../../tests/e2e/user-management.spec.ts) | 禁用/启用/重新登录的跨请求记录 |
| AC-10 | 邀请邮件可恢复，并发接受只有完整单账号 | 候选覆盖 | [公开邀请](../../tests/integration/public-invitations.test.ts)、[Worker](../../tests/integration/mail-worker.test.ts) | SMTP 故障至接受的组合流程及并发角色快照 |
| AC-11 | 重发/撤销/邀请人失权后旧邀请不可接受 | 候选覆盖 | [邀请管理](../../tests/integration/invitation-management.test.ts)、[公开邀请](../../tests/integration/public-invitations.test.ts) | 降权/禁用/重发各分支与页面后续入口 |
| AC-12 | 四种已有邮箱不合并、不改密、不加角色 | 候选覆盖 | [邀请管理](../../tests/integration/invitation-management.test.ts) | 四状态独立断言及对应管理入口 |
| AC-13 | 直接管理 URL/API 均按权限拒绝 | 缺交付物 | [权限查询](../../tests/integration/permission-queries.test.ts)、[角色页面](../../tests/e2e/role-management.spec.ts) | 路由策略登记/构建清单与完整页面导航回归 |
| AC-14 | 高权限目标及保留权限不可间接接管 | 候选覆盖 | [角色写入](../../tests/integration/role-management.test.ts)、[用户接口](../../tests/integration/http-users.test.ts) | 邮箱/密码邮件/状态/角色所有入口的保护与拒绝审计核对 |
| AC-15 | 用户/角色撤权同步撤销全部会话 | 缺验证 | [角色写入](../../tests/integration/role-management.test.ts)、[会话](../../tests/integration/sessions.test.ts) | 两个 Web 进程重放旧 Cookie 与重新登录的权限证据 |
| AC-16 | 并发操作仍保留一名可用超级管理员 | 候选覆盖 | [角色写入](../../tests/integration/role-management.test.ts)、[用户接口](../../tests/integration/http-users.test.ts) | 并发禁用/降权及最终账号可登录组合核对 |
| AC-17 | 全部角色引用阻删，旧版本不能覆盖 | 候选覆盖 | [角色写入](../../tests/integration/role-management.test.ts)、[角色查询](../../tests/integration/role-queries.test.ts) | 用户/注册保留/默认角色/邀请引用及前端冲突恢复 |
| AC-18 | 邮箱验证前保留旧身份，竞争/禁用不误激活 | 候选覆盖 | [邮箱接口](../../tests/integration/http-email-change.test.ts)、[邮箱页面](../../tests/e2e/email-change.spec.ts) | 竞争胜负、禁用后验证及实际登录地址 |
| AC-19 | 非法图片拒绝，合法图片可用，脚本文本不执行 | 候选覆盖 | [媒体接口](../../tests/integration/http-media.test.ts)、[媒体页面](../../tests/e2e/media.spec.ts) | 格式/尺寸/像素/多帧与昵称脚本逐项核对 |
| AC-20 | 软删除保留历史身份与邮箱占用 | 候选覆盖 | [用户接口](../../tests/integration/http-users.test.ts)、[日志接口](../../tests/integration/http-logs.test.ts) | 删除后登录/重新注册/审计识别与业务数据保留 |
| AC-21 | SMTP 故障可重试，审计失败不假成功 | 候选覆盖 | [SMTP](../../tests/integration/smtp.test.ts)、[统一写入口](../../tests/integration/mutation-gateway.test.ts)、[留存](../../tests/integration/retention.test.ts) | 各高风险写入的审计故障回滚及邮件持久化完整映射 |
| AC-22 | 响应/日志/后台任务/异常不泄露秘密 | 缺验证 | [日志接口](../../tests/integration/http-logs.test.ts)、[Worker 进程](../../tests/integration/worker-process.test.ts) | 所有公开/异常路径统一秘密扫描；测试运行器输出另行脱敏 |
| AC-23 | 默认管理员角色、弱策略/非法参数整组拒绝 | 候选覆盖 | [设置接口](../../tests/integration/http-settings.test.ts)、[设置页面](../../tests/e2e/settings.spec.ts) | 原配置不变、审计及新旧会话生效规则 |
| AC-24 | 桌面/移动、键盘、中英文核心流程 | 缺验证 | [浏览器用例](../../tests/e2e)、[实施记录](implementation-progress.md) | 稳定环境完整浏览器绿色；键盘/焦点/长文案与语言逐项验收 |
| AC-25 | 性能、真实备份恢复及脱敏健康检查 | 缺交付物 | [现有进程启动测试](../../tests/integration/web-process.test.ts) | 备份/恢复/epoch、健康诊断、容量报告、目标环境 RPO/RTO |
| AC-29 | 干净副本按快速开始初始化登录并计时 | 缺交付物 | [README](../../README.md)、[本地源码运行](../LOCAL_RUNTIME.md) | 完整编译/镜像/组合命令；无隐藏配置的新副本与独立试用计时 |
| AC-30 | 按指南接入完整模块，两个用户越权拒绝 | 缺验证 | [模块指南](../MODULES.md)、[笔记接口](../../tests/integration/http-notes.test.ts)、[笔记页面](../../tests/e2e/notes.spec.ts) | 未参与实现者新增另一模块的完整步骤与 2 小时目标记录 |
| AC-31 | 彻底移除示例，无菜单/路由/权限残留 | 缺交付物 | [现有启停测试](../../tests/integration/ops-module.test.ts)、[模块指南](../MODULES.md) | 前向清理迁移、代码裁剪、空库/旧库结构一致与核心冒烟；关闭开关不算移除 |
| AC-32 | 有自定义数据的旧库升级不重置，可恢复 | 缺交付物 | [迁移机制](../../tests/integration/migrations.test.ts)、[目录转换](../../tests/integration/ops-module.test.ts) | 版本化旧库夹具、完整升级/媒体/配置保留与真实恢复路径 |
| AC-33 | 缺配置可定位、生产拒绝危险配置、重置有保护 | 缺交付物 | [Web 进程](../../tests/integration/web-process.test.ts)、[配置单元](../../tests/unit/config.test.ts) | 受保护 dev:reset、编译/容器中的真实生产配置验证 |
| AC-34 | 默认角色/自助资格变更不注入管理权限 | 候选覆盖 | [角色写入](../../tests/integration/role-management.test.ts)、[设置接口](../../tests/integration/http-settings.test.ts) | Pending 原角色保留、角色失效拒绝及默认变更不追溯 |
| AC-35 | 自定义管理员的所有操作遵守完整目标范围 | 候选覆盖 | [用户接口](../../tests/integration/http-users.test.ts)、[邮箱接口](../../tests/integration/http-email-change.test.ts) | 资料/邮箱/重置邮件/状态/角色逐入口全目标集合核对 |
| AC-36 | 当前设备近期验证，另设备与超过 5 分钟无效 | 候选覆盖 | [账号安全](../../tests/integration/account-security.test.ts)、[安全页面](../../tests/e2e/security.spec.ts) | 恰好边界、其他设备、超时页面与不自动重放写入 |
| AC-37 | 邀请角色版本变化使旧链接失效，重发快照正确 | 候选覆盖 | [公开邀请](../../tests/integration/public-invitations.test.ts)、[邀请管理](../../tests/integration/invitation-management.test.ts) | 只改名/改权限/邀请人变化、旧新链接及单次消费 |
| AC-38 | Worker 崩溃/接管/并发/耗尽尝试状态正确 | 缺验证 | [Worker 进程](../../tests/integration/worker-process.test.ts)、[投递](../../tests/integration/mail-worker.test.ts)、[SMTP](../../tests/integration/smtp.test.ts) | 实际 kill、供应商已受理后崩溃与三次耗尽组合证据；不承诺恰好一次 |
| AC-39 | 邮箱请求替换/取消/Pending 修正及旧凭证失效 | 候选覆盖 | [邮箱接口](../../tests/integration/http-email-change.test.ts)、[本人邮箱页面](../../tests/e2e/self-email.spec.ts)、[到期维护](../../tests/integration/expiry.test.ts) | 请求与旧邮箱验证/重置凭证的完整状态矩阵 |
| AC-40 | 同键不重复、换正文冲突、撤权不能取历史结果 | 缺交付物 | [幂等](../../tests/integration/idempotency.test.ts)、[写入口](../../tests/integration/mutation-gateway.test.ts)、[不确定结果页面](../../tests/e2e/uncertain-mutations.spec.ts) | GET operations 结果查询、当前授权与已删目标历史范围；逐写入口与丢响应回归 |

## 不由局部测试替代的发布门槛

- 完整服务端/Worker 编译、图片工作线程和迁移/模板/密码资源分发，路由登记/策略与 OpenAPI 导出；组合开发命令和生产镜像/Compose/Caddy/CI。
- 管理员恢复签发/消费与 restore_access，备份/恢复及外部 epoch 轮换；真实旧 Cookie/Token 重放失败、媒体完整性和升级保留数据。
- Drizzle schema 映射与实际数据库一致；全部配置、命令、支持矩阵、许可及可复现发布包。
- 固定容量环境的真实 P50/P95/P99、错误率、资源/查询/锁等待报告；限流拒绝不能充当快速成功样本。
- 稳定环境完整浏览器、键盘/移动/双语核对，未参与实现者的新副本启动/接入/裁剪计时。
- 整个分支的独立新上下文评审；所有重要问题修复后再核对 37 项及完整发布物。上述任一项缺失时，开发目标保持未完成。
