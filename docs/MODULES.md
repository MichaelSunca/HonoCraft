# 业务模块接入与参考模块生命周期

本文以个人笔记为实际参考，说明模块怎样复用认证、授权、事务、审计及前端基础设施。正式启停已实现；彻底裁剪的前向迁移、干净副本试用和独立开发者接入计时仍待交付，不能把本文当作这些验收的完成证明。

## 当前代码边界

| 位置 | 责任 |
| --- | --- |
| [共享契约](../packages/contracts/src/notes.ts) | 严格输入/输出、查询白名单、DTO 与版本 |
| [权限声明](../packages/contracts/src/permissions.ts) | 四项权限、写依赖读取、不可自行赋予 |
| [模块路由与声明](../apps/server/src/modules/example-notes/routes.ts) | 固定模块名/API 前缀，解析 HTTP，调用服务 |
| [服务](../apps/server/src/modules/example-notes/service.ts) | 当前身份、模块/权限检查、版本、统一写入口及最小重放 |
| [Repository](../apps/server/src/modules/example-notes/repository.ts) | 每次查询显式传入 owner 和 Tx |
| [目录转换](../apps/server/src/modules/example-notes/catalog.ts) | 本机专用的显式启停、授权版本与引用处理 |
| [页面](../apps/web/src/notes.tsx) | 本人列表/详情、纯文本编辑、冲突与不确定结果恢复 |
| [双语文案](../apps/web/src/note-messages.ts) | 中文/英文，与页面字段和错误一一对应 |

HTTP 层只在部署配置开启时注册 API 和页面。导航根据服务端 `/me` 的当前权限显示，不通过内建角色名猜测资格。关闭目录会移除这四项注册权限；持有相同权限的两个用户仍不能互访笔记，真正超级管理员也遵守此 owner 边界。

## 启用与停用

完整操作步骤、退出码与维护窗口要求见[本地运行说明](LOCAL_RUNTIME.md#正式启用或停用参考模块)。执行当前迁移、停止 Web/Worker 后，使用独立迁移连接运行：

```bash
pnpm ops:module -- --enable=example-notes --reason="启用参考模块"
```

成功后同步 `EXAMPLE_NOTES_ENABLED=true`、检查配置并重启；再通过角色管理明确授予普通账号笔记权限。命令不会给 user/admin/自定义角色自动加入权限。超级管理员按注册目录隐式拥有权限，因此目录变化也会使其授权版本变化并撤销会话。

停用使用：

```bash
pnpm ops:module -- --disable=example-notes --reason="停用并保留数据"
```

随后同步环境开关为 false 并重启。停用保留笔记和历史迁移，移除当前模块授权；相关角色和账号版本递增，账号 session 撤销，受影响角色快照的 Pending 邀请、凭证与邮件取消。审计失败则整个事务回滚。无关权限、账号和邀请保持原有状态。重新启用不恢复已移除的授权；原数据只有重新获准的原 owner 才能读取。

## 接入另一个受保护资源

新增业务模块时，应完成以下交付，而不是只增加路由或菜单：

1. 声明模块、权限及依赖。普通业务权限可委派，不默认设为可自行赋予；明确默认角色是否获得权限，并通过显式目录升级完成，不能在启动时补写。
2. 使用版本化前向迁移建表、索引和最小数据库授权，保留历史迁移。记录 owner 或其他实际范围字段，不能从请求身份以外猜测 owner。
3. 在 contracts 定义严格输入、输出、分页、排序和过滤白名单。数值版本、Unicode 字符数与 HTTP 字节上限分别校验；不因为输入是 JSON 就接受额外 owner/id 字段。
4. 将查询放入接收同一 Tx 的 repository，列表、总数、详情、更新和删除均带归属条件。服务器身份验证通过不等于有权读取某个资源。
5. 使用 defineMutation/createMutationGateway 注册服务器拥有的写定义，声明权限、协调锁模式、锁集合、近期验证和幂等策略。HTTP 不能提交回调、SQL、任意 operation 名或 owner。
6. 所有受保护写入遵守协调锁 → 有序用户/角色 → session → 资源/凭证的顺序。版本和授权须在锁后复核；资源、审计和幂等结果在同一事务提交。SMTP、图像处理和磁盘 IO 不进入该事务。
7. 成功审计仅记录必要对象 ID、动作与版本，不默认复制正文或整个请求。历史重放先验证当前资格与原范围，再返回最小摘要；不能把历史 DTO 当当前状态。
8. 注册条件路由、懒加载页面、权限导航与完整双语资源。使用服务器 allowed_actions 决定动作入口；实际请求仍由服务端再次授权。自由文本用 React 文本节点渲染。
9. 补直接 HTTP/PG 及真实浏览器验证，证明两个同权限账号互访失败、版本冲突保留草稿、审计失败回滚、失去资格不能重放，以及禁用后 API/菜单不暴露。

笔记的具体输入规则：标题 trim 后 1–120 Unicode 码点，正文保留空白最多 20000 码点，拒绝 NUL。只有已启用笔记 JSON 请求允许 128 KiB，其他 JSON 保持 64 KiB。owner 取当前账号，DTO 不返回可供选择的 owner。

## 前端恢复契约

- 写入前形成完整正文与 UUID 幂等键；网络/不可解释响应/REQUEST_IN_PROGRESS 不能当作确定失败。结果不明时保留原正文和键，不允许编辑、关闭弹窗或自动换键。
- 当前读取、重连和背景刷新不能替换冻结的操作。合法重放仅有摘要，必须重新读取当前对象；已确认写入后读取失败只能重读，不能重复提交。
- 版本冲突保留输入，展示当前对象；用户明确采用最新版本后，再次提交新操作。采用版本不等于自动保存。
- 退出、账号切换与受保护请求 401 统一清除账号缓存和草稿；请求代次校验阻止旧响应回填。不把笔记内容或身份凭证写入 localStorage、sessionStorage 或 IndexedDB；会话沿用受控 HttpOnly Cookie。
- 字段错误关联 label/aria-describedby，聚焦首个错误；允许关闭时 Escape 恢复触发控件焦点。中文、深色、窄屏和长文本须实际查看。

## 当前验证入口

```bash
pnpm check
pnpm test
pnpm exec vitest run --project integration tests/integration/http-notes.test.ts tests/integration/example-module.test.ts tests/integration/ops-module.test.ts
pnpm build:web
pnpm exec playwright test tests/e2e/notes.spec.ts
```

浏览器后端使用隔离 PostgreSQL，并通过正式目录转换服务启用模块；不会靠不存在的权限或虚构账号绕过模块注册。账号验证、会话与 HTTP 请求走真实应用路径。测试假名与邮件捕获仅用于该隔离环境。

## 彻底裁剪的交付门槛

当前停用不删除数据，也没有已验证的“一键裁剪”命令。彻底移除前应明确导出/保留/删除策略，在隔离副本中执行新的前向数据清理迁移，再移除模块代码、路由、导航、契约、配置与当前权限声明及专用测试/夹具。不能删除或重写已经应用的历史迁移来改变旧库。

裁剪后的全新库全量迁移与旧库升级须达到相同结构；历史审计不能因移除当前权限定义而丢失。需重新构建并实际完成初始化/登录、邀请、角色、审计及核心冒烟，确认没有示例菜单/API/当前权限残留。正式迁移、可复现裁剪步骤和试用证据完成后，本节再补对应文件与命令。

独立开发者的首次启动与新模块接入耗时尚未计量；30 分钟/2 小时是 PRD 建议目标，不是当前已证明的结果。
