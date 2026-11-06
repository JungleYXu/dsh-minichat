/**
 * client.mjs — 用假装载器跑一遍浏览器半区：能执行到这里，就说明 bundle 语法正确、
 * factory 返回了合法的插件对象、三个插槽注册都走到了 register()。
 *
 * 这是「用户看不到界面」那类问题的第一道探针：它不能证明渲染正确，但能证明
 * client.js 本身没有在装载期抛错，也没有悄悄跳过某个入口。
 *
 * 跑法：先说 ELECTRON_RUN_AS_NODE=1，再 & 'DeepSeek Harness.exe' test\client.mjs
 */

import assert from 'node:assert/strict'

let checks = 0
function check(label, fn) {
  fn()
  checks += 1
  console.log(`PASS ${label}`)
}

// --- 1. 装载：window.__ModuleLoader__.load 必须被调用一次，id 等于包名 ---------
let definition
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}

const url = new URL('../client.js', import.meta.url)
await import(url.href)

check('loader 收到一次 load()', () => assert.ok(definition !== undefined))
check('id 等于包名 dsh-minichat', () => assert.equal(definition.id, 'dsh-minichat'))

// --- 2. factory：只允许 React 的 createElement/useState/useEffect ------------
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const plugin = definition.factory((name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require(${name})`)
})

check('factory 返回 { inject, apply }', () => {
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

// --- 3. apply：两个入口都必须注册成功 ---------------------------------------
// 标题栏入口已按用户要求删掉，只剩输入框左侧的 chip 和浮层面板。
const injected = []
const registered = []
const warnings = []
const ctx = {
  slots: {
    inject(name, body) {
      injected.push(name)
      body()
    },
    register(meta, component) {
      registered.push({ meta, component })
    },
  },
  logger: { warn: (line) => warnings.push(line) },
}

plugin.apply(ctx)

check('没有插槽注册失败', () => assert.deepEqual(warnings, []))
check('两个入口都注册了', () => assert.equal(registered.length, 2))
check('入口分别是 input.left / overlay', () => {
  assert.deepEqual(
    registered.map((row) => row.meta.name),
    ['conversation.input.left', 'shell.overlay'],
  )
})
check('每次 register 都带 name/id/order', () => {
  for (const { meta } of registered) {
    assert.equal(typeof meta.name, 'string')
    assert.equal(meta.id, 'dsh-minichat')
    assert.equal(typeof meta.order, 'number')
  }
})
check('每个入口都有组件', () => {
  for (const { component } of registered) assert.equal(typeof component, 'function')
})
check('每个入口都先 inject 再 register', () => assert.equal(injected.length, registered.length))

// --- 4. 插槽抛错时不得让 apply 崩掉 -----------------------------------------
const broken = {
  slots: {
    inject() {
      throw new Error('slot gone')
    },
    register() {},
  },
  logger: { warn: (line) => warnings.push(line) },
}
plugin.apply(broken)

check('插槽消失时只记 warn，不抛错', () => {
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /界面插槽 .* 不可用/)
})

console.log(`\n${checks} checks passed`)
