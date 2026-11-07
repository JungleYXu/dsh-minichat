/**
 * A host-half smoke test that needs no DSH: it stubs the three services the
 * plugin borrows (`llm`, `webServer`, `web`) and drives the real HTTP handler.
 *
 *   node test/smoke.mjs
 *
 * Covers the acceptance points that can be checked without a browser:
 * T01 no store file → empty state, no throw; T03 twelve turns → ten kept;
 * T05 clear → empty; usage arithmetic; the busy and too-long guards;
 * favourites (pinned as one exchange, toggled, surviving ⟳, wiped by 🗑);
 * 联网 (auto only for time-sensitive questions, off never, on always, the
 * digest reaching the request without being stored, the first page fetched);
 * and the restart rule (a cold start begins empty, favourites included).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'minichat-smoke-'))
process.env.DSH_HOME = home

let failures = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** A fake model: yields one text delta, a usage chunk, then finishes. */
function fakeStream(calls) {
  return async function* stream(request) {
    calls.push(request)
    if (request.signal?.aborted) return
    yield { type: 'text-delta', index: 0, text: `答：${request.messages.at(-1)?.content?.[0]?.text ?? ''}` }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

const calls = []
const routes = []
const searches = []
const fetches = []
/** A fake `web` service: four sources, so a digest can be built. */
const fakeWeb = {
  async search(request) {
    searches.push(request)
    return {
      sources: [1, 2, 3, 4].map((index) => ({
        title: `结果 ${index}`,
        url: `https://example.com/${index}`,
        snippet: `第 ${index} 条摘要`.repeat(40),
      })),
    }
  },
  async fetch(request) {
    fetches.push(request)
    return {
      url: request.url,
      statusCode: 200,
      truncated: false,
      body: { kind: 'html', content: '<html><body><script>bad()</script><p>无锡今天多云 18~25℃</p></body></html>' },
    }
  },
}
const ctx = {
  logger: { info() {}, warn: (line) => console.log(`  [warn] ${line}`) },
  get: (name) => (name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }
    : name === 'web' ? fakeWeb : undefined),
  llm: {
    stream: fakeStream(calls),
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
  },
  inject(dependencies, install) {
    install({ webServer: { register: (route) => routes.push(route) } })
  },
}

const { apply, name, inject } = await import(pathToFileURL(join(process.cwd(), 'index.js')).href)
check('exports name', name === 'minichat', String(name))
check('exports inject', Array.isArray(inject) && inject.includes('llm'), JSON.stringify(inject))

apply(ctx)
check('registered one route', routes.length === 1, `got ${routes.length}`)
const route = routes[0]
check('route path', route?.path === '/dsh-minichat/api', String(route?.path))

/** POST one JSON body through the real handler. */
function makePost(route) {
  return async function post(value) {
    const req = Readable.from([Buffer.from(JSON.stringify(value), 'utf8')])
    req.method = 'POST'
    req.headers = { host: '127.0.0.1:64485' }
    const res = { status: 0, body: '' }
    res.writeHead = (status) => {
      res.status = status
    }
    res.end = (body) => {
      res.body = body
    }
    await route.handler(req, res)
    return JSON.parse(res.body)
  }
}

const post = makePost(route)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ask, then poll until the turn settles, like the panel does. */
async function ask(text, web) {
  const started = await post({ action: 'ask', text, ...(web === undefined ? {} : { web }) })
  if (!started.ok) return started
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(20)
    const polled = await post({ action: 'poll', runId: started.runId })
    if (polled.state !== 'thinking') return polled
  }
  return { ok: false, error: { code: 'timeout', message: 'turn never settled' } }
}

// T01 — no store file yet.
const empty = await post({ action: 'state' })
check('T01 empty state', empty.ok === true && empty.messages.length === 0, JSON.stringify(empty).slice(0, 120))
check('T01 no cost field', empty.cost === undefined, JSON.stringify(empty.cost))

// One turn: the answer echoes the question, usage is recorded.
const first = await ask('你好')
check('ask settles done', first.state === 'done', JSON.stringify(first).slice(0, 200))
check('ask keeps the answer', first.messages?.at(-1)?.content === '答：你好', JSON.stringify(first.messages?.at(-1)))
check('turns counted', first.turns === 1, String(first.turns))
check('usage from tokens', first.usage?.input === 12 && first.usage?.output === 8, JSON.stringify(first.usage))
check('effort off was sent', calls.at(-1)?.reasoningEffort === 'off', JSON.stringify(calls.at(-1)?.reasoningEffort))
check('message carries role', calls.at(-1)?.messages?.at(-1)?.role === 'user', JSON.stringify(calls.at(-1)?.messages?.at(-1)))
check('timing reported', Number.isFinite(first.timing?.ttftMs) && Number.isFinite(first.timing?.totalMs), JSON.stringify(first.timing))
check('system prompt was sent', calls.at(-1)?.system !== undefined, 'system prompt missing')

// T03 — twelve turns keep only the last ten.
for (let index = 2; index <= 12; index += 1) {
  const settled = await ask(`第 ${index} 问`)
  if (settled.state !== 'done') {
    check(`turn ${index} done`, false, JSON.stringify(settled).slice(0, 200))
    break
  }
}
const capped = await post({ action: 'state' })
check('T03 keeps 20 messages', capped.messages.length === 20, String(capped.messages.length))
check('T03 turns capped at 10', capped.turns === 10, String(capped.turns))
const stored = JSON.parse(await readFile(join(home, 'minichat.json'), 'utf8'))
check('T03 file capped too', stored.messages.length === 20, String(stored.messages.length))

// ── 收藏：一问一答一起存、置顶、不占轮次、刷新保留、清空带走 ──────────
const window = await post({ action: 'state' })
const lastQuestion = window.messages.at(-2)
const lastAnswer = window.messages.at(-1)
const starred = await post({ action: 'favorite', id: lastQuestion.id })
check('favourite pins the exchange', starred.starred === true && starred.favorites.length === 1, JSON.stringify(starred.favorites?.length))
check('favourite keeps the answer', starred.favorites[0].answer === lastAnswer.content, JSON.stringify(starred.favorites[0]))
check('favourite does not eat a round', starred.turns === window.turns, `${starred.turns} vs ${window.turns}`)
const notAQuestion = await post({ action: 'favorite', id: lastAnswer.id })
check('answer cannot be starred', notAQuestion.ok === false && notAQuestion.error.code === 'minichat/not-a-question', JSON.stringify(notAQuestion).slice(0, 120))
const unstarred = await post({ action: 'favorite', id: lastQuestion.id })
check('star toggles off', unstarred.starred === false && unstarred.favorites.length === 0, JSON.stringify(unstarred.favorites?.length))
await post({ action: 'favorite', id: lastQuestion.id })
const pinnedFile = JSON.parse(await readFile(join(home, 'minichat.json'), 'utf8'))
check('favourite persisted', pinnedFile.favorites.length === 1 && pinnedFile.favorites[0].question === lastQuestion.content, JSON.stringify(pinnedFile.favorites?.[0]?.question))
const unknownMessage = await post({ action: 'favorite', id: 'nope' })
check('unknown message refused', unknownMessage.ok === false && unknownMessage.error.code === 'minichat/unknown-message', JSON.stringify(unknownMessage).slice(0, 120))

// ⟳ — window drops, favourites stay, usage resets.
const refreshed = await post({ action: 'refresh' })
check('refresh empties the window', refreshed.messages.length === 0, String(refreshed.messages?.length))
check('refresh keeps favourites', refreshed.favorites.length === 1, String(refreshed.favorites?.length))
check('refresh zeroes usage', refreshed.usage.input === 0 && refreshed.usage.output === 0, JSON.stringify(refreshed.usage))

// 🗑 — everything, favourites included.
const wiped = await post({ action: 'clear' })
check('clear wipes favourites', wiped.favorites.length === 0 && wiped.messages.length === 0, JSON.stringify(wiped.favorites?.length))
const wipedFile = JSON.parse(await readFile(join(home, 'minichat.json'), 'utf8'))
check('clear persisted favourites', wipedFile.favorites.length === 0, String(wipedFile.favorites?.length))
check('clear keeps the file schema', wipedFile.schema === 2, String(wipedFile.schema))

// ── 联网：auto 只查时效问题，off 从不查，on 一定查 ────────────────────
const weather = await ask('今天无锡天气')
check('auto search ran', weather.search?.state === 'done', JSON.stringify(weather.search))
check('search got the question', searches.at(-1)?.query === '今天无锡天气', JSON.stringify(searches.at(-1)?.query))
check('search asked for four sources', searches.at(-1)?.maxResults === 4, String(searches.at(-1)?.maxResults))
const asked = calls.at(-1)?.messages?.at(-1)?.content?.[0]?.text ?? ''
check('digest reached the request', asked.includes('资料'), asked.slice(0, 80))
check('digest names four sources', [1, 2, 3, 4].every((index) => asked.includes(`结果 ${index}`)), asked.slice(0, 120))
check('page body was fetched', fetches.length >= 1 && fetches.at(-1)?.url === 'https://example.com/1', JSON.stringify(fetches.at(-1)?.url))
check('page body reached the request', asked.includes('多云 18~25℃'), asked.slice(-120))
check('page body dropped its script', !asked.includes('bad()'), 'script leaked')

// A clock question is answered from the prompt, not from a search.
const beforeClock = searches.length
const clock = await ask('今天几号')
check('clock questions skip search', searches.length === beforeClock, `${searches.length - beforeClock} search(es)`)
check('clock answered', clock.state === 'done', JSON.stringify(clock).slice(0, 120))
check('system carries today', /\d{4} 年 \d{1,2} 月 \d{1,2} 日/.test(calls.at(-1)?.system ?? ''), (calls.at(-1)?.system ?? '').slice(0, 60))

// The digest is per-request only: the stored question stays the plain one.
const afterSearch = JSON.parse(await readFile(join(home, 'minichat.json'), 'utf8'))
const storedQuestion = afterSearch.messages.find((row) => row.content === '今天无锡天气')
check('digest is not stored', storedQuestion !== undefined, JSON.stringify(afterSearch.messages.at(-1)?.content?.slice(0, 60)))

const plain = await ask('1+1 等于几')
check('auto skips plain questions', plain.search?.state === 'skipped', JSON.stringify(plain.search))
const forcedOff = await ask('今天无锡天气', 'off')
check('off never searches', forcedOff.search?.state === 'skipped', JSON.stringify(forcedOff.search))
const forcedOn = await ask('1+1 等于几', 'on')
check('on always searches', forcedOn.search?.state === 'done', JSON.stringify(forcedOn.search))

// Guards.
const blank = await post({ action: 'ask', text: '   ' })
check('empty question refused', blank.ok === false && blank.error.code === 'minichat/empty', JSON.stringify(blank))
const huge = await post({ action: 'ask', text: 'x'.repeat(4001) })
check('oversized question refused', huge.ok === false && huge.error.code === 'minichat/too-long', JSON.stringify(huge).slice(0, 120))
const unknown = await post({ action: 'nope' })
check('unknown action refused', unknown.ok === false && unknown.error.code === 'minichat/unknown', JSON.stringify(unknown))

// ── 重启即清空：上一轮留下的对话、收藏、用量都不会回来 ────────────────
const restartHome = await mkdtemp(join(tmpdir(), 'minichat-restart-'))
await writeFile(join(restartHome, 'minichat.json'), JSON.stringify({
  schema: 2,
  messages: [
    { id: 'm-old-1', role: 'user', content: '上一次的问', at: 1700000000000 },
    { id: 'm-old-2', role: 'assistant', content: '上一次的答', at: 1700000000001 },
  ],
  favorites: [{ id: 'm-old-1', at: 1700000000000, starredAt: 1700000000002, question: '上一次的问', answer: '上一次的答' }],
  usage: { input: 5, output: 7 },
}), 'utf8')
// 改名前的文件留在磁盘上也不该被读回来。
await writeFile(join(restartHome, 'quickchat.json'), JSON.stringify({
  schema: 2,
  messages: [{ id: 'm-legacy', role: 'user', content: '改名前的问', at: 1 }],
  favorites: [],
  usage: { input: 1, output: 1 },
}), 'utf8')
process.env.DSH_HOME = restartHome
const restartRoutes = []
const restartCtx = {
  ...ctx,
  inject: (dependencies, install) => install({ webServer: { register: (entry) => restartRoutes.push(entry) } }),
}
// 冷启动：新模块实例 = 用户重启了 DSH。
const restartPlugin = await import(`${pathToFileURL(join(process.cwd(), 'index.js')).href}?restart=1`)
restartPlugin.apply(restartCtx)
const restartPost = makePost(restartRoutes[0])
const restartState = await restartPost({ action: 'state' })
check('restart starts empty', restartState.messages.length === 0, String(restartState.messages?.length))
check('restart drops favourites', restartState.favorites.length === 0, String(restartState.favorites?.length))
check('restart zeroes usage', restartState.usage.input === 0 && restartState.usage.output === 0, JSON.stringify(restartState.usage))
const restartStarted = await restartPost({ action: 'ask', text: '1+1' })
check('restart can still be asked', restartStarted.ok === true && typeof restartStarted.runId === 'string', JSON.stringify(restartStarted).slice(0, 120))
for (let attempt = 0; attempt < 100; attempt += 1) {
  await wait(20)
  const polled = await restartPost({ action: 'poll', runId: restartStarted.runId })
  if (polled.state !== 'thinking') break
}
const restartFile = JSON.parse(await readFile(join(restartHome, 'minichat.json'), 'utf8'))
check('restart file starts from the new turn', restartFile.messages?.[0]?.content === '1+1', JSON.stringify(restartFile.messages?.[0] ?? null))
check('restart file never carries the old rows', !JSON.stringify(restartFile).includes('上一次的'), 'old row leaked')
await rm(restartHome, { recursive: true, force: true })

await rm(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
