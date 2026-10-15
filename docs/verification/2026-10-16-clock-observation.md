# 独立测试环境时钟观测

2026-10-16，日本时区。此记录只适用于本次 WSL/Linux 开发环境，不代表其他宿主或生产环境的时钟行为。

## 观测

笔记浏览器目标运行中，一次版本冲突提交先被会话检查拒绝，返回 SESSION_INVALID；响应后的采样已落后于 last_seen_at 约 15.6ms，不能仅凭该采样确定当时的拒绝原因。该用例的首次运行及随后独立重跑均通过，期间未修改会话或笔记产品逻辑。

随后运行独立 Node 进程及全新 PostgreSQL 17 临时集群，不加载业务账号、Cookie、CSRF 或 epoch，不调用认证逻辑。循环读取 clock_timestamp() 和 Node Date.now()，以 performance.now() 记录单调间隔，持续 90 秒、66864 次采样。

| 观测 | Node 墙钟变化 | PostgreSQL 墙钟变化 | 单调间隔 |
| --- | --- | --- | --- |
| 第一次 | -592ms | -592ms | +1.478ms |
| 第二次 | -581ms | -581ms | +1.406ms |

完整数值见[原始 JSON](2026-10-16-clock-observation.json)。两个独立进程同时观测到相同回退，证明本次运行环境的墙钟存在倒退；这不是浏览器模拟 Date.now() 或笔记版本处理造成的。它解释了此前捕获的未来 last_seen_at 场景，但不能据此断言所有 SESSION_INVALID 都只由同一原因触发。

## 应用处理与验收边界

未删除 now < last_seen_at 的会话拒绝规则，未增加任意宽限或重写测试中的认证时间以获得通过。已有绝对/空闲期限、未来时间与撤销/epoch 测试继续验证真实规则。会话检查发生在业务版本判断之前，所以环境时间异常可以使预期 VERSION_CONFLICT 的请求先被拒绝。

最终浏览器结果须按各轮实际输出分别报告；单独重跑通过不等于整套通过。生产部署、容量测试与恢复演练仍需在时钟稳定的目标环境验证，本记录不替代这些验收。

## 复现方法

已安装项目声明的 Node.js 24、pnpm 和 Linux x64 测试依赖后，将以下脚本临时保存为仓库内 `.tools/clock-probe.ts`，在仓库根目录运行 `pnpm exec tsx .tools/clock-probe.ts`。它只创建并清理 `.local/tests/` 下的隔离集群，不使用 `.env` 中的实例数据库。

```ts
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {startTestPostgres} from '../tests/helpers/postgres.js';
const database = await startTestPostgres();
const events: unknown[] = [];
let samples = 0, nodeBackwards = 0, pgBackwards = 0;
let lastNode = Date.now(), lastPg = 0, lastMono = performance.now();
const until = performance.now() + 90_000;
try {
  while (performance.now() < until) {
    const pg = (await database.pool.query('SELECT clock_timestamp() AS now'))
      .rows[0].now.getTime();
    const node = Date.now(), mono = performance.now();
    samples++;
    for (const [source, previous, current] of [
      ['node', lastNode, node], ['postgres', lastPg, pg],
    ] as const) {
      if (previous && current < previous) {
        if (source === 'node') nodeBackwards++; else pgBackwards++;
        if (events.length < 100) events.push({source, previous, current,
          delta: current - previous, monotonic_delta: mono - lastMono});
      }
    }
    lastNode = node; lastPg = pg; lastMono = mono;
    await delay(1);
  }
  await writeFile('.tools/clock-probe.json', JSON.stringify({samples,
    nodeBackwards, pgBackwards, events}, null, 2));
} finally {
  await database.close();
}
```

未发生倒退的一轮采样不能证明环境始终稳定；本次原始观测保留，不用后续平稳样本覆盖它。
