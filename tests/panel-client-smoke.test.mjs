// 离屏冒烟：把 client.js 在假 ModuleLoader + 假 React + 假 ctx 下跑一遍
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let captured = null
const registered = []
const disposed = []

// 极简 React 替身：只需要 createElement / useState
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

const effects = []
const ctx = {
  effect: (cb) => {
    const cleanup = cb()
    effects.push(cleanup)
    return () => cleanup?.()
  },
  locale: {
    register: (ns, locale, dict) => {
      registered.push([ns, locale, Object.keys(dict).length])
      return () => disposed.push(`${ns}:${locale}`)
    },
    bind: (ns) => (key) => `[${ns}]${key}`,
  },
  slots: {
    inject: (name, factory) => {
      const meta = factory()
      registered.push(['slot', name, meta.id])
      return () => {}
    },
    register: (meta, Component) => {
      // 记录组件，稍后调用一次确认能渲染
      registered.component = Component
      return meta
    },
  },
}
mod.apply(ctx)
console.log('  注册记录:', JSON.stringify(registered.filter((r) => r[0] === 'slot' || r[0] === 'memory-es-panel')))
console.log('  字典:', JSON.stringify(registered.filter((r) => r[0] === 'memory-es-panel')))

const Component = registered.component
if (!Component) throw new Error('没有注册组件')
const tree = Component({ close: () => {}, t: (k) => `[${k}]` })
console.log('  组件渲染出的根节点:', tree.type, '| 子节点数:', tree.children.length)

// 清理路径
for (const cleanup of effects) cleanup?.()
console.log('  卸载时释放的字典:', JSON.stringify(disposed))
console.log('SMOKE OK')
