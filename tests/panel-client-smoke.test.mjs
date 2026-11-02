// 离屏冒烟：把 client.js 在假 ModuleLoader + 假 React + 假 ctx 下跑一遍
//
// 阶段 8 之后客户端会往三个槽位注册：设置节、主区（main）、侧栏入口（sidebar.panellist）。
// 这个测试只验证「注册契约」与「外壳能构造」，不渲染页面内部（那要真 React 与真 DOM）。
import { readFileSync } from 'node:fs'

let captured = null

// 极简 React 替身：只需要 createElement / useState / Fragment。
// 注意组件都是 h(Comp, props) 构造 element 而不是被调用，所以不需要 useEffect 等 hook。
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  Fragment: 'Fragment',
}

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}

// 用相对本文件的 URL：node --test 的 cwd 取决于调用方式，不能假设是仓库根
const src = readFileSync(new URL('../panel/client.js', import.meta.url), 'utf8')
new Function('window', src)(globalThis.window)
if (!captured) throw new Error('client.js 没有调用 __ModuleLoader__.load')
console.log('  module id:', captured.id)

const mod = captured.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`未预期的 require: ${name}`)
})
console.log('  inject:', JSON.stringify(mod.inject))

/**
 * 跑一次 apply，返回这次运行里发生的注册。
 * `withLayout=false` 模拟宿主没有 layout 服务（精简布局）：这时只应剩设置节。
 */
function run(withLayout = true) {
  const injected = []
  const registered = []
  const localeDictionaries = []
  const disposed = []
  const effects = []
  const panelSelections = []
  const layout = { selectPanel: (id) => panelSelections.push(id) }

  const ctx = {
    effect: (cb) => {
      const cleanup = cb()
      effects.push(cleanup)
      return () => cleanup?.()
    },
    // 真实 cordis 里 ctx.get 对未注入的服务静默返回 undefined
    get: (name) => (name === 'layout' && withLayout ? layout : undefined),
    locale: {
      register: (ns, locale, dict) => {
        localeDictionaries.push([ns, locale, Object.keys(dict).length])
        return () => disposed.push(`${ns}:${locale}`)
      },
      bind: (ns) => (key) => `[${ns}]${key}`,
    },
    slots: {
      inject: (name, factory) => {
        injected.push(name)
        const result = factory()
        // factory 的正常返回值是清理函数（见面板里 main 的注册）
        return typeof result === 'function' ? result : () => {}
      },
      register: (meta, Component) => {
        registered.push({ meta, Component })
        return () => {}
      },
    },
  }

  mod.apply(ctx)
  return { injected, registered, localeDictionaries, disposed, effects, panelSelections }
}

// ── 1. 有 layout：主区与侧栏入口都要注册，且**不再注册设置节** ──────────
// 2026-11-01 用户定：功能全部放主区，不要"设置里一份、主区一份"。
const full = run(true)
console.log('  注入的槽位:', JSON.stringify(full.injected))
console.log('  注册项:', JSON.stringify(full.registered.map((item) => item.meta.name)))
if (!full.injected.includes('main')) throw new Error('缺少 main 注册（主区面板）')
if (!full.injected.includes('sidebar.panellist')) throw new Error('缺少 sidebar.panellist 注册（侧栏入口）')
if (full.injected.includes('settings.section')) {
  throw new Error('settings.section 不应再注册——功能已经统一到主区，两处各一份是这次要去掉的状态')
}

const byName = (name) => full.registered.find((item) => item.meta.name === name)
const mainSlot = byName('main')
const sidebarSlot = byName('sidebar.panellist')
for (const [label, item] of [['main', mainSlot], ['sidebar.panellist', sidebarSlot]]) {
  if (!item) throw new Error(`没有注册组件：${label}`)
}

// ── 2. 契约：main.key 与 sidebar.id 必须是同一个面板 id，order 紧跟 mnemon(30) ──
if (mainSlot.meta.key !== 'memory-es') throw new Error(`main.key 应为 memory-es，实际 ${mainSlot.meta.key}`)
if (sidebarSlot.meta.id !== mainSlot.meta.key) {
  throw new Error(`sidebar.id(${sidebarSlot.meta.id}) 必须等于 main.key(${mainSlot.meta.key})`)
}
if (sidebarSlot.meta.order !== 31) throw new Error(`侧栏 order 应为 31，实际 ${sidebarSlot.meta.order}`)
console.log('  主区面板 id:', mainSlot.meta.key, '| 侧栏 order:', sidebarSlot.meta.order)

// ── 3. 两个组件都能构造出元素 ────────────────────────────────────────
const t = (key) => `[${key}]`
const mainTree = mainSlot.Component({ t, close: () => {} })
if (!mainTree || mainTree.type !== 'div') throw new Error('主区外壳没有渲染出根节点')
const iconTree = sidebarSlot.Component({ size: 18 })
if (!iconTree || iconTree.type !== 'svg') throw new Error('侧栏图标没有渲染出 svg')
console.log('  主区外壳根节点:', mainTree.type, '| 子节点数:', mainTree.children.length)
console.log('  侧栏图标根节点:', iconTree.type)

// ── 4. 返回会话：inject 出来的 close 必须切回会话（selectPanel(null)）──────
const mainProps = mainSlot.meta.inject()
if (typeof mainProps.close !== 'function') throw new Error('main.inject() 没有给出 close')
mainProps.close()
if (full.panelSelections.length !== 1 || full.panelSelections[0] !== null) {
  throw new Error(`close 应调用 selectPanel(null)，实际 ${JSON.stringify(full.panelSelections)}`)
}
console.log('  返回会话 → selectPanel:', JSON.stringify(full.panelSelections))

// ── 6. layout 服务缺席（初始化顺序晚于本插件）时，注册照样完成、close 只是不做事 ──
// 这是 2026-11-01 实测踩到的真因：先前用 `if (ctx.get('layout'))` 守卫整组注册，
// layout 尚未 provide 时 side 栏就永远没有入口。现在改成靠 slots.inject 等槽位。
const bare = run(false)
console.log('  [无 layout 服务] 注入的槽位:', JSON.stringify(bare.injected))
if (!bare.injected.includes('main') || !bare.injected.includes('sidebar.panellist')) {
  throw new Error('layout 服务缺席时也应该注册主区/侧栏入口（槽位存在就够）')
}
const bareMain = bare.registered.find((item) => item.meta.name === 'main')
const bareProps = bareMain.meta.inject()
bareProps.close()
if (bare.panelSelections.length !== 0) {
  throw new Error('layout 缺席时 close 应该静默跳过，不能抛错或误调')
}
console.log('  [无 layout 服务] close 静默跳过 OK')

// ── 7. 清理路径 ─────────────────────────────────────────────────────
for (const cleanup of full.effects) cleanup?.()
console.log('  卸载时释放的字典:', JSON.stringify(full.disposed))
if (full.disposed.length !== 2) throw new Error(`字典应释放 2 份，实际 ${full.disposed.length}`)

console.log('  字典:', JSON.stringify(full.localeDictionaries))
console.log('SMOKE OK')

