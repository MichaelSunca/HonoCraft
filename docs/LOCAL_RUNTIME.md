# 当前服务端运行说明

当前交付的是 P0 开发中的服务端入口，前端、初始化页面、初始化 CLI 和邮件 Worker 常驻入口仍待交付。`start:web` 暂时通过 tsx 运行源码，尚不能替代最终编译后的生产部署。

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
6. 执行 `pnpm start:web`，或开发时执行 `pnpm dev:server`。

当前监听 `127.0.0.1:$PORT`。生产配置仍要求 HTTPS PUBLIC_ORIGIN，应在同机可信反向代理后使用；容器绑定与部署方案尚待交付。`Web ready` 只表示启动检查和监听成功，不表示全部 P0 功能或外部 SMTP 已验证。

可读接口包括 `/health/live`、`/health/ready`、`/api/v1/public/settings`。未初始化时普通 API 返回 `SYSTEM_NOT_INITIALIZED`，不创建默认账号。初始化服务已有数据库和 HTTP 测试，但本机签发命令及浏览器设密页面尚未提供，因此这里不宣称完整快速开始已经可用。

启动会验证外部秘密、密码数据、PostgreSQL 17、全部迁移校验和与权限目录；Web 不使用环境中的迁移、维护或 Worker 连接字符串。生产应分别注入各进程实际需要的环境变量，避免把运维凭证传给 Web。SIGINT/SIGTERM 停止接收请求、等待进行中的连接并关闭数据库池，最长 30 秒。

## 离线密码列表

[data/passwords](../data/passwords/) 随版本保存 100,000 行常见密码样本、SHA-256、来源提交与上游许可。启动只读取本地文件，校验版本、摘要和行数；损坏或缺失会阻止启动。它用于阻断常见弱密码，不代表覆盖全部已泄露密码。用户提交的密码不会被发送到第三方做比对。
