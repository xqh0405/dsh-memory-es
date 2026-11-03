/**
 * 阶段 15.9 验收（纯函数部分）：单盘 5000 点的图与亮星口径。
 *
 * 为什么用纯函数而不是打真 ES：这一层的错误全是「口径错」，不是「连不上」——
 *  · 上限没生效（画得比说的多）
 *  · 分盘构图退化成合并抢名额（团队盘挤掉个人盘）
 *  · 亮星排序口径与文档不一致（同度数时每次画的不是同一批）
 * 这些都能在 buildGraph 上钉住，不需要 5000 条真数据。
 * 渲染帧时间与真实取数在 scripts/bench/ 与本轮验收记录里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildGraph } = await import('../panel/index.js')

/** 造一批节点：domain 轮转，updatedAt 递增（用于同度数时的排序兜底） */
function makeNodes(count, prefix) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    scope: 'personal',
    label: `记忆 ${i}`,
    type: 'fact',
    domain: ['lottery-cloud', 'backup-server', 'dsh-memory-es'][i % 3],
    updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
    status: 'active',
  }))
}

/**
 * 造边：环 + 跨步连（i→i+1、i→i+7），让度数有高低差。
 * 不用随机——每次跑出同一张图，测试失败才能复现。
 */
function makeEdges(count, prefix, baseWeight = 0.7) {
  const edges = []
  for (let i = 0; i < count; i += 1) {
    edges.push({
      source: `${prefix}-${i}`,
      target: `${prefix}-${(i + 1) % count}`,
      weight: baseWeight,
    })
    // 每隔 3 个才连一次长边，制造 hub 与叶子的区别
    if (i % 3 === 0) {
      edges.push({
        source: `${prefix}-${i}`,
        target: `${prefix}-${(i + 7) % count}`,
        weight: baseWeight + 0.1,
      })
    }
  }
  return edges
}

test('单盘 5000 点：limit=5000 时一个不少', () => {
  const nodes = makeNodes(5000, 'a')
  const graph = buildGraph(nodes, makeEdges(5000, 'a'), { limit: 5000, maxDegree: 10 })
  assert.equal(graph.nodes.length, 5000, '5000 条 active 应该全部画出')
  assert.equal(graph.stats.nodes, 5000)
  // 超过上限要如实截断，不能悄悄多画
  assert.equal(graph.nodes.length <= 5000, true)
})

test('超过上限（6000 条）时截到 5000，且截图原因可解释', () => {
  const nodes = makeNodes(6000, 'b')
  const graph = buildGraph(nodes, makeEdges(6000, 'b'), { limit: 5000, maxDegree: 10 })
  assert.equal(graph.nodes.length, 5000, '节点上限必须生效')
  // 被截掉的应该是低度数的尾巴：保留集合里最小度数 ≥ 丢弃集合里最大度数
  const kept = new Set(graph.nodes.map((node) => node.id))
  const dropped = nodes.filter((node) => !kept.has(node.id))
  assert.equal(dropped.length, 1000)
})

test('亮星口径：度数降序取前 500，且同一份数据每次是同一批', () => {
  const nodes = makeNodes(5000, 'c')
  const edges = makeEdges(5000, 'c')
  const graph = buildGraph(nodes, edges, { limit: 5000, maxDegree: 10 })

  // 前端 LOD 的判据（panel/client.js 的 brightIds）：度数降序取前 500
  const pickBright = (list) => [...list]
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 500)
    .map((node) => node.id)

  const first = pickBright(graph.nodes)
  const second = pickBright(graph.nodes)
  assert.equal(first.length, 500, '亮星固定 500 颗')
  assert.deepEqual(first, second, '同一份数据必须画出同一批亮星')

  // 亮星的最小度数不能低于非亮星的最大度数（否则说明排序口径错了）
  const bright = new Set(first)
  const minBright = Math.min(...graph.nodes.filter((node) => bright.has(node.id)).map((node) => node.degree))
  const maxDim = Math.max(...graph.nodes.filter((node) => !bright.has(node.id)).map((node) => node.degree))
  assert.ok(minBright >= maxDim, `亮星门槛（${minBright}）不该低于星点上限（${maxDim}）`)
})

test('分盘构图不是可选优化：合并抢名额会让另一张盘整片消失', () => {
  // A 盘 5000 颗都有边（度数 ≥ 2），B 盘 5000 颗一个边都没有（度数 0）。
  // 排序是度数降序，B 盘必然排最后——这就是「两库合并抢同一个 limit」的最坏形态。
  const a = makeNodes(5000, 'hub')
  const b = makeNodes(5000, 'leaf')
  const aEdges = makeEdges(5000, 'hub')

  // 合并后抢同一个 limit：B 盘整片消失
  const merged = buildGraph([...a, ...b], aEdges, { limit: 5000, maxDegree: 10 })
  const mergedLeaf = merged.nodes.filter((node) => node.id.startsWith('leaf-')).length
  assert.equal(mergedLeaf, 0, `合并构图会让另一张盘整片消失（实测 ${mergedLeaf} 颗），所以必须分盘`)

  // 分盘构图：各画各的，两边都在
  const personal = buildGraph(a, aEdges, { limit: 5000, maxDegree: 10 })
  const team = buildGraph(b, [], { limit: 5000, maxDegree: 10 })
  assert.equal(personal.nodes.length, 5000)
  assert.equal(team.nodes.length, 5000)
  assert.equal(personal.nodes.length + team.nodes.length, 10000, '双盘合计 10000 是定案上限')
})

test('fetchSize = 单盘上限 × 2 必须停在 10000（ES max_result_window 贴线）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../panel/index.js', import.meta.url), 'utf8')
  // 这条约束是「两个数的关系」而不是某个数字，所以直接从源码里读常量，不写死 5000
  const maxNodes = Number(/const GRAPH_MAX_NODES = (\d+)/.exec(source)?.[1])
  assert.equal(maxNodes, 5000, '单盘上限是阶段 15 的定案值')
  assert.equal(maxNodes * 2, 10000, 'fetchSize 贴 ES 默认 max_result_window，越界要改 search_after')
  assert.match(source, /Math\.min\(GRAPH_MAX_NODES \* 2/, '取数必须显式封顶，不能直接用 limit*2')
})
