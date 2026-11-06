/**
 * 快问 dsh-minichat — the browser half.
 *
 * Two surfaces, one shared store:
 *   1. a chip at the left of the composer tool row — the only trigger. It is
 *      also the only place the live input facade (`inputActions`) is available,
 *      which is what makes 「转给主对话」 write into the composer instead of the
 *      clipboard;
 *   2. a floating panel in `shell.overlay` — frame-wide, so it sits above the
 *      conversation without being clipped by the composer's own box.
 *
 * The panel's message area is a fixed height (about three exchanges): it scrolls,
 * it never grows with the answer.
 */
// `id` must be the package name, exactly (`dsh-minichat`). The boot graph looks
// the factory up under the package name; any alias means "loaded without
// registering", the loader re-executes it on its fallback URL, and the second
// registration throws `duplicate factory registration`, failing the Web boot.
window.__ModuleLoader__.load({
  id: 'dsh-minichat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const ENDPOINT = '/dsh-minichat/api'
    const PANEL_WIDTH = 380
    /** A fixed window: tall enough for ~3 exchanges, then it scrolls. */
    const BODY_HEIGHT = 336
    /** The order the 联网 chip cycles through. */
    const WEB_MODES = ['auto', 'on', 'off']
    const WEB_LABEL = { auto: '网络·自动', on: '网络·开', off: '网络·关' }
    /** Search states that mean "the answer you just got has no fresh facts". */
    const SEARCH_MISS = new Set(['failed', 'empty', 'unavailable'])
    const isSearchMiss = (search) => search !== undefined && SEARCH_MISS.has(search.state)

    /** One module-level store, because the chip and the panel are two slots. */
    const store = {
      open: false,
      ready: false,
      messages: [],
      favorites: [],
      draft: '',
      running: false,
      streaming: '',
      search: undefined,
      error: undefined,
      notice: undefined,
      cost: 0,
      timing: undefined,
      turns: 0,
      maxTurns: 10,
      /** 'all' = the rolling window, 'favorites' = the starred list. */
      view: 'all',
      web: 'auto',
      /** 🗑 is destructive, so it arms on the first click and fires on the second. */
      armed: false,
      inputActions: undefined,
      listeners: new Set(),
    }

    function emit() {
      for (const listener of [...store.listeners]) listener()
    }

    function patch(next) {
      Object.assign(store, next)
      emit()
    }

    /** Subscribe a component to the shared store. */
    function useStore() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      }, [])
      return store
    }

    async function post(value) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
      return response.json()
    }

    /** Fold a `state` payload into the store. */
    function absorb(result) {
      if (!result?.ok) return
      patch({
        ready: true,
        messages: Array.isArray(result.messages) ? result.messages : [],
        favorites: Array.isArray(result.favorites) ? result.favorites : [],
        cost: Number(result.cost ?? 0),
        turns: Number(result.turns ?? 0),
        maxTurns: Number(result.maxTurns ?? 10),
      })
    }

    let pollTimer
    function stopPolling() {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
    }

    function pollUntilDone(runId) {
      stopPolling()
      pollTimer = setInterval(async () => {
        let result
        try {
          result = await post({ action: 'poll', runId })
        } catch {
          return
        }
        if (!result?.ok) {
          stopPolling()
          patch({ running: false, error: result?.error?.message ?? '取回答失败' })
          return
        }
        if (result.runId !== runId) return
        if (result.search !== undefined) patch({ search: result.search })
        if (result.state === 'thinking') {
          if (store.streaming !== result.text) patch({ streaming: result.text })
          return
        }
        stopPolling()
        patch({ search: undefined, armed: false })
        if (result.state === 'error') {
          patch({ running: false, streaming: '', error: result.error ?? '模型调用失败' })
          return
        }
        patch({ running: false, streaming: '', timing: result.timing })
        absorb({ ok: true, ...result })
        if (result.messages === undefined) void refresh()
      }, 180)
    }

    async function refresh() {
      try {
        absorb(await post({ action: 'state' }))
      } catch {
        patch({ ready: true })
      }
    }

    /** Open the panel: load the window from disk the first time it is shown. */
    function openPanel() {
      patch({ open: true, notice: undefined, armed: false })
      void refresh()
    }

    function closePanel() {
      patch({ open: false, armed: false })
      stopPolling()
    }

    async function send() {
      const text = String(store.draft ?? '').trim()
      if (text === '' || store.running) return
      const previous = store.messages
      patch({
        draft: '',
        running: true,
        error: undefined,
        streaming: '',
        search: undefined,
        messages: [...previous, { role: 'user', content: text, at: Date.now() }],
      })
      let result
      try {
        result = await post({ action: 'ask', text, web: store.web })
      } catch (error) {
        patch({ running: false, messages: previous, error: `发送失败：${String(error?.message ?? error)}` })
        return
      }
      if (!result?.ok) {
        patch({
          running: false,
          messages: previous,
          draft: text,
          error: result?.error?.message ?? '发送失败',
        })
        return
      }
      pollUntilDone(result.runId)
      // The host assigned the user row its id; without it the star would be dead
      // until the answer lands.
      void refresh()
    }

    /**
     * ⟳ — drop the rolling window, keep what the user chose to keep. This is the
     * difference from 🗑: 刷新 never touches the starred list.
     */
    async function refreshWindow() {
      stopPolling()
      patch({
        messages: [], streaming: '', running: false, error: undefined, search: undefined,
        cost: 0, turns: 0, timing: undefined, view: 'all', armed: false,
      })
      try {
        absorb(await post({ action: 'refresh' }))
        patch({ notice: '已刷新对话（收藏保留）' })
      } catch {
        patch({ notice: '刷新失败，请重试' })
      }
    }

    /** 🗑 — everything, favourites included. Two clicks, because it cannot be undone. */
    async function clearAll() {
      if (store.armed !== true) {
        patch({ armed: true, notice: '再点一次 🗑 清空全部（连收藏一起）' })
        return
      }
      stopPolling()
      patch({
        messages: [], favorites: [], streaming: '', running: false, error: undefined,
        search: undefined, cost: 0, turns: 0, timing: undefined, view: 'all', armed: false,
      })
      try {
        absorb(await post({ action: 'clear' }))
        patch({ notice: '已清空全部' })
      } catch {
        patch({ notice: '清空失败，请重试' })
      }
    }

    /** Star / un-star one message. The list is pinned, so it never eats a round. */
    async function toggleFavorite(id) {
      if (typeof id !== 'string' || id === '') {
        patch({ notice: '这条还没存好，等一下再点' })
        return
      }
      let result
      try {
        result = await post({ action: 'favorite', id })
      } catch (error) {
        patch({ notice: `收藏失败：${String(error?.message ?? error)}` })
        return
      }
      if (!result?.ok) {
        patch({ notice: result?.error?.message ?? '收藏失败' })
        return
      }
      absorb(result)
      patch({ notice: result.starred === true ? '已收藏，不占轮次' : '已取消收藏' })
    }

    /** 150–250 字，本地拼装，不再调模型。 */
    function summaryOf(messages) {
      const pairs = []
      for (let index = 0; index < messages.length; index += 1) {
        const row = messages[index]
        if (row.role !== 'user') continue
        const answer = messages[index + 1]?.role === 'assistant' ? messages[index + 1].content : ''
        if (answer === '') continue
        const question = String(row.content).replace(/\s+/gu, ' ').slice(0, 60)
        const reply = String(answer).replace(/\s+/gu, ' ').slice(0, 90)
        pairs.push(`问：${question}\n答：${reply}`)
      }
      const recent = pairs.slice(-3)
      if (recent.length === 0) return ''
      const body = recent.join('\n\n')
      return `【快问小面板的结论】\n${body.slice(0, 240)}`
    }

    function transfer() {
      // Favourites come first: they are what the user decided to keep.
      const kept = store.favorites.map((row) => `★ ${String(row.content).replace(/\s+/gu, ' ').slice(0, 120)}`)
      const summary = summaryOf(store.messages)
      const text = kept.length === 0 ? summary : [summary === '' ? '' : summary, kept.join('\n')].filter(Boolean).join('\n\n')
      if (text === '') {
        patch({ notice: '还没有可带的问答' })
        return
      }
      const actions = store.inputActions
      if (typeof actions?.captureInsertion === 'function' && typeof actions?.insertText === 'function') {
        try {
          const span = actions.captureInsertion()
          if (actions.insertText(`${text}\n\n`, span) !== false) {
            patch({ notice: '已带到主对话；小面板内容保持不动' })
            return
          }
        } catch {
          // Fall through to the clipboard: a rejected insert is not an error.
        }
      }
      const done = () => patch({ notice: '已复制，粘贴到输入框' })
      try {
        void navigator.clipboard?.writeText(text).then(done, () => patch({ notice: '复制失败，请手动选中' }))
      } catch {
        patch({ notice: '复制失败，请手动选中' })
      }
    }

    const C = {
      border: 'var(--ds-border, #d8dbe0)',
      text: 'var(--ds-text, #1f2937)',
      muted: 'var(--ds-text-secondary, #6b7280)',
      surface: 'var(--ds-surface, #ffffff)',
      accent: '#3b82f6',
      gold: '#d97706',
    }

    const styles = {
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      panel: {
        position: 'fixed',
        zIndex: 2147483000,
        width: PANEL_WIDTH,
        maxWidth: 'calc(100vw - 32px)',
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        background: C.surface,
        color: C.text,
        boxShadow: '0 12px 40px rgba(15, 23, 42, .18)',
        fontSize: 13,
        overflow: 'hidden',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderBottom: `1px solid ${C.border}`,
        cursor: 'grab',
        userSelect: 'none',
        background: 'transparent',
      },
      title: { fontWeight: 600, fontSize: 13, flex: '0 0 auto' },
      /** The rule, in the title row: one line, small, never a second row. */
      hint: {
        flex: '1 1 auto',
        minWidth: 0,
        color: C.muted,
        fontSize: 10,
        lineHeight: '14px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      iconButton: {
        border: 'none',
        background: 'transparent',
        color: C.muted,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '20px',
        padding: '0 4px',
        borderRadius: 6,
      },
      starCount: {
        border: 'none',
        background: 'transparent',
        color: C.gold,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '20px',
        padding: '0 2px',
      },
      body: {
        flex: '0 0 auto',
        height: BODY_HEIGHT,
        overflowY: 'auto',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      empty: { color: C.muted, fontSize: 12, lineHeight: 1.7, padding: '6px 2px' },
      pinBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderRadius: 8,
        border: `1px dashed ${C.border}`,
        color: C.muted,
        fontSize: 11,
        lineHeight: 1.5,
      },
      user: {
        maxWidth: '88%',
        padding: '6px 10px',
        borderRadius: '10px 10px 2px 10px',
        background: 'rgba(59, 130, 246, .10)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      assistant: {
        maxWidth: '94%',
        padding: '2px 4px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.65,
      },
      star: {
        border: 'none',
        background: 'transparent',
        color: C.muted,
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '18px',
        padding: '0 2px',
        flex: '0 0 auto',
      },
      error: { color: '#b91c1c', fontSize: 12, lineHeight: 1.6, padding: '2px 4px' },
      input: {
        resize: 'none',
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: C.text,
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.6,
        padding: '8px 10px',
        minHeight: 56,
        maxHeight: 120,
      },
      foot: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderTop: `1px solid ${C.border}`,
        color: C.muted,
        fontSize: 11,
      },
      link: {
        border: 'none',
        background: 'transparent',
        color: C.accent,
        cursor: 'pointer',
        fontSize: 11,
        padding: 0,
      },
      send: {
        border: 'none',
        borderRadius: 6,
        background: C.accent,
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12,
        padding: '3px 10px',
      },
      webChip: {
        border: `1px solid ${C.border}`,
        borderRadius: 999,
        background: 'transparent',
        color: C.muted,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
      },
    }

    /** The composer-dock chip: opens the panel and holds the input facade. */
    function MiniChip(props) {
      useStore()
      const actions = props?.inputActions ?? props?.actions
      useEffect(() => {
        if (actions !== undefined && actions !== null) {
          store.inputActions = actions
          emit()
        }
      }, [actions])
      return h('button', {
        type: 'button',
        style: styles.chip,
        title: '快问：问一句就走，不占主对话',
        onClick: () => (store.open ? closePanel() : openPanel()),
      }, '快问')
    }

    /**
     * Two pieces of view state that are deliberately NOT React refs: the client
     * bundle is only guaranteed to hand out `createElement` / `useState` /
     * `useEffect`, so a factory that reaches for `useRef` may get `undefined`
     * and crash the panel on first render. The panel is a single instance, so
     * module scope is enough.
     */
    let areaElement
    /** The pointer origin of the in-flight title-bar drag, if any. */
    let dragOrigin

    /** One message with its star. Starred messages are pinned, not counted. */
    function Message(props) {
      const { row, starred, onStar, onDelete } = props
      // The star belongs to the exchange, and an exchange is read from its
      // question: starring an answer would leave the question behind.
      const starButton = typeof row.id === 'string' && row.role === 'user'
        ? h('button', {
          type: 'button',
          style: { ...styles.star, color: starred === true ? C.gold : C.muted },
          title: starred === true ? '取消收藏（一问一答一起）' : '收藏这一问一答（不占轮次）',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.stopPropagation()
            onStar(row.id)
          },
        }, starred === true ? '★' : '☆')
        : null
      // Only the favourites view offers this: from there a row can be dropped
      // without going back to the window it came from.
      const deleteButton = typeof onDelete === 'function'
        ? h('button', {
          type: 'button',
          style: styles.star,
          title: '从收藏里删掉这一条',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.stopPropagation()
            onDelete(row)
          },
        }, '✕')
        : null
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: 4,
          justifyContent: row.role === 'user' ? 'flex-end' : 'flex-start',
        },
      }, starButton, h('div', { style: row.role === 'user' ? styles.user : styles.assistant }, row.content), deleteButton)
    }

    function Panel() {
      const state = useStore()
      const [pos, setPos] = useState({ right: 24, bottom: 96 })

      // Scroll to the newest line while an answer is growing.
      useEffect(() => {
        const area = areaElement
        if (area !== undefined && area !== null) area.scrollTop = area.scrollHeight
      }, [state.messages.length, state.streaming])

      useEffect(() => {
        if (!state.open) return undefined
        const onMove = (event) => {
          const current = dragOrigin
          if (current === undefined) return
          const nextRight = Math.max(8, Math.min(window.innerWidth - 120, current.right - (event.clientX - current.x)))
          const nextBottom = Math.max(8, Math.min(window.innerHeight - 80, current.bottom - (event.clientY - current.y)))
          setPos({ right: nextRight, bottom: nextBottom })
        }
        const onUp = () => {
          dragOrigin = undefined
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
      }, [state.open])

      useEffect(() => {
        if (state.notice === undefined) return undefined
        const timer = setTimeout(() => patch({ notice: undefined, armed: false }), 2600)
        return () => clearTimeout(timer)
      }, [state.notice])

      if (!state.open) return null

      const starredIds = new Set(state.favorites.map((entry) => entry.id))
      const starOf = (id) => starredIds.has(id)

      const rows = []
      if (state.view === 'favorites') {
        if (state.favorites.length === 0) {
          rows.push(h('div', { key: 'empty-fav', style: styles.empty }, '还没有收藏。点问题前面的 ☆，一问一答会一起留在这里。'))
        }
        for (const entry of state.favorites) {
          rows.push(h('div', {
            key: `f${entry.id}`,
            style: { display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 6, borderBottom: `1px dashed ${C.border}` },
          },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 4, justifyContent: 'flex-end' } },
            h('button', {
              type: 'button',
              style: styles.star,
              title: '从收藏里删掉这一问一答',
              onPointerDown: (event) => event.stopPropagation(),
              onClick: () => void toggleFavorite(entry.id),
            }, '✕'),
            h('div', { style: styles.user }, entry.question)),
          entry.answer === '' ? null : h('div', { style: { display: 'flex', gap: 4 } },
            h('span', { style: { width: 14 } }),
            h('div', { style: styles.assistant }, entry.answer))))
        }
      } else {
        for (const row of state.messages) {
          rows.push(h(Message, { key: row.id ?? `${row.role}-${row.at}`, row, starred: starOf(row.id), onStar: (id) => void toggleFavorite(id) }))
        }
        if (state.running) {
          const live = state.streaming ?? ''
          const searching = state.search?.state === 'searching'
          rows.push(h('div', { key: 'live', style: { display: 'flex', gap: 4 } },
            h('span', { style: { width: 14 } }),
            h('div', { style: styles.assistant },
              searching ? h('span', { style: { color: C.muted } }, '正在联网找资料…') : null,
              live === '' && !searching ? h('span', { style: { color: C.muted } }, '思考中…') : null,
              live,
              h('span', { style: { color: C.accent } }, ' ▍'))))
        }
      }

      const cost = state.cost > 0 ? `≈¥${state.cost.toFixed(4)}` : '≈¥0'
      const pace = state.timing === undefined
        ? ''
        : ` · 首字 ${(state.timing.ttftMs / 1000).toFixed(1)}s / 共 ${(state.timing.totalMs / 1000).toFixed(1)}s`
      const searched = state.timing?.searchMs > 0 ? ` · 联网 ${(state.timing.searchMs / 1000).toFixed(1)}s` : ''
      const pinBar = state.view === 'all' && state.favorites.length > 0
        ? h('div', { style: styles.pinBar },
          h('span', { style: { color: C.gold } }, '★'),
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            `收藏 ${state.favorites.length} 条 · ${String(state.favorites[0]?.question ?? '').replace(/\s+/gu, ' ').slice(0, 28)}`),
          h('button', { type: 'button', style: styles.link, onClick: () => patch({ view: 'favorites' }) }, '查看'))
        : null

      return h('div', { style: { ...styles.panel, right: pos.right, bottom: pos.bottom } },
        h('div', {
          style: styles.head,
          onPointerDown: (event) => {
            dragOrigin = { x: event.clientX, y: event.clientY, right: pos.right, bottom: pos.bottom }
          },
        },
        h('span', { style: styles.title }, state.view === 'favorites' ? '收藏' : '快问'),
        h('span', { style: styles.hint, title: `只保留最近 ${state.maxTurns} 轮；收藏的不占轮次。` },
          `只保留最近 ${state.maxTurns} 轮；收藏的不占轮次。`),
        state.favorites.length === 0 ? null : h('button', {
          type: 'button',
          style: styles.starCount,
          title: state.view === 'favorites' ? '回到对话' : '只看收藏（不占轮次）',
          onClick: () => patch({ view: state.view === 'favorites' ? 'all' : 'favorites' }),
        }, state.view === 'favorites' ? '★ 返回' : `★ ${state.favorites.length}`),
        h('button', {
          type: 'button',
          style: styles.iconButton,
          title: '刷新对话（收起本轮，收藏保留）',
          onClick: () => void refreshWindow(),
        }, '⟳'),
        h('button', {
          type: 'button',
          style: { ...styles.iconButton, color: state.armed === true ? '#b91c1c' : C.muted },
          title: state.armed === true ? '再点一次：连收藏一起清空' : '清空全部（含收藏）',
          onClick: () => void clearAll(),
        }, '🗑'),
        h('button', { type: 'button', style: styles.iconButton, title: '关闭（内容保留）', onClick: closePanel }, '✕')),

        h('div', { ref: (element) => { areaElement = element }, style: styles.body },
          pinBar,
          state.ready && rows.length === 0
            ? h('div', { style: styles.empty },
              '问一句就走：这里不建会话、不进侧栏、不写主对话的上下文。',
              h('br'),
              '只保留最近 10 轮，关掉再打开还在。')
            : null,
          rows,
          state.error === undefined
            ? null
            : h('div', { style: styles.error },
              state.error,
              h('button', {
                type: 'button',
                style: { ...styles.link, marginLeft: 6 },
                onClick: () => patch({ error: undefined }),
              }, '知道了')),

          state.view === 'all' && isSearchMiss(state.search)
            ? h('div', {
              style: { fontSize: 11, lineHeight: 1.5, color: '#b45309', padding: '0 2px' },
            }, '这次没连上网络（'
            + (state.search.state === 'empty' ? '没搜到结果' : state.search.state === 'failed' ? '搜索失败' : '本机没有联网搜索')
            + '），所以上面没有最新信息。切成「网络·开」再问一次试试。')
            : null,

          state.view === 'all'
            ? h('div', {
              style: {
                marginTop: 2,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                background: 'transparent',
              },
            },
            h('textarea', {
              style: styles.input,
              value: state.draft,
              placeholder: '问一句…（Enter 发送，Shift+Enter 换行）',
              onChange: (event) => patch({ draft: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  void send()
                }
              },
            }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 6px' } },
              h('button', {
                type: 'button',
                style: { ...styles.webChip, color: state.web === 'off' ? C.muted : C.accent },
                title: '联网：自动=遇到时效问题才搜 / 开=每次都搜 / 关=从不搜',
                onClick: () => {
                  const next = WEB_MODES[(WEB_MODES.indexOf(state.web) + 1) % WEB_MODES.length]
                  patch({ web: next })
                },
              }, WEB_LABEL[state.web]),
              h('span', { style: { flex: 1 } }),
              h('button', {
                type: 'button',
                style: { ...styles.send, opacity: state.running || state.draft.trim() === '' ? 0.55 : 1 },
                disabled: state.running || state.draft.trim() === '',
                onClick: () => void send(),
              }, state.running ? '回答中…' : '发送')))
            : null),

        h('div', { style: styles.foot },
          h('span', null, `本次 ${cost}${searched}${pace} · ${state.turns}/${state.maxTurns} 轮`),
          h('span', { style: { flex: 1 } }),
          state.notice === undefined ? null : h('span', { style: { color: state.armed === true ? '#b91c1c' : C.muted } }, state.notice),
          h('button', {
            type: 'button',
            style: styles.link,
            title: '把收藏和最近几轮的结论带进主对话输入框',
            onClick: transfer,
          }, '转给主对话')))
    }

    /**
     * Register one surface, but never fail activation over it: a slot that
     * disappears must cost the entry, not the whole Web boot.
     */
    function registerSurface(ctx, slot, component) {
      try {
        ctx.slots.inject(slot.name, () => ctx.slots.register({
          name: slot.name,
          id: 'dsh-minichat',
          order: slot.order,
          ...(slot.extra ?? {}),
        }, component))
      } catch (error) {
        const line = `dsh-minichat: 界面插槽 ${slot.name} 不可用（${String(error?.message ?? error)}），该入口已跳过`
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
        else console.warn(line)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The trigger belongs where the user types: `conversation.input.left` is
        // the compact-controls list at the left of the composer tool row, next to
        // attach/model. Same scope as the composer, so the chip is still a child
        // of the bar that hands the slot occupant the live input facade.
        registerSurface(ctx, { name: 'conversation.input.left', order: 5 }, MiniChip)
        // The panel is frame-wide, so the composer's own box cannot clip it.
        registerSurface(ctx, { name: 'shell.overlay', order: 0 }, Panel)
      },
    }
  },
})
