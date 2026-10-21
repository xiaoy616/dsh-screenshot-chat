window.__ModuleLoader__.load({
  id: 'dsh-screenshot-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'screenshot'
    const PREFIX = '/.dsh-screenshot'
    /** The native overlay has no deadline of its own; give the user room. */
    const REQUEST_TIMEOUT_MS = 200000
    /** Sticky per-browser choice of the hide-window capture mode. */
    const HIDE_KEY = 'dsh-screenshot:hide-window'

    const DICT = {
      en: {
        'command.label': 'Screenshot',
        'command.description': 'Capture a screenshot into the conversation',
        'toggle.label': 'Hide-window capture',
        'toggle.title': 'When on, the current window is hidden before the selection overlay and restored after the capture',
        'error.unavailable': 'The screenshot service is unavailable.',
        'error.busy': 'A screen capture is already in progress.',
        'error.timeout': 'The screen capture timed out. Try again.',
        'error.blocked': 'The input box is busy right now; the capture was discarded.',
        'error.empty': 'No image was captured.',
        'error.inject': 'Could not place the capture into the input box.',
      },
      zh: {
        'command.label': '截屏',
        'command.description': '截图上传对话',
        'toggle.label': '隐藏窗口截图',
        'toggle.title': '开启后：截屏前自动隐藏当前窗口，截完自动恢复',
        'error.unavailable': '截屏服务不可用。',
        'error.busy': '已经有一个截屏正在进行。',
        'error.timeout': '截屏超时，请重试。',
        'error.blocked': '输入框正忙，本次截图已放弃。',
        'error.empty': '没有获得截图。',
        'error.inject': '无法把截图放进输入框。',
      },
    }

    const styles = `
.dsc-toast-stack {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.dsc-toast {
  max-width: min(480px, calc(100vw - 48px));
  box-sizing: border-box;
  padding: 9px 14px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35));
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, #26262a);
  color: var(--dsw-alias-label-primary, #f2f2f2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 12.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  animation: dsc-toast-in 160ms ease-out;
}
.dsc-toast-error { border-color: var(--dsw-alias-state-error-primary, #e5484d); }
@keyframes dsc-toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.dsc-aug {
  display: none;
  flex: none;
  align-items: center;
  gap: 5px;
  margin-left: 8px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 999px;
  /* Font metrics match the menu row's description text exactly. */
  color: var(--dsw-alias-label-tertiary, #8e8e93);
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.dsc-aug:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18));
}
.dsc-aug-dot {
  box-sizing: border-box;
  width: 9px;
  height: 9px;
  flex: none;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}
.dsc-aug-on .dsc-aug-dot {
  background: var(--dsw-alias-state-success-primary, #30a46c);
  border-color: var(--dsw-alias-state-success-primary, #30a46c);
}
`

    /** The sticky hide-window mode, shared by the row toggle and the action. */
    const mode = { hide: readHide() }

    function readHide() {
      try {
        return window.localStorage.getItem(HIDE_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeHide(value) {
      try {
        window.localStorage.setItem(HIDE_KEY, value ? '1' : '0')
      } catch {
        // Private mode or a full store: the toggle still works for this page.
      }
    }

    /** A region-capture glyph drawn to match the menu's 16px outline icons. */
    function GlyphScreenshot({ size = 14 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': true,
          'data-dsc-icon': '1',
          fill: 'none',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M1.2 5V2.7c0-.83.67-1.5 1.5-1.5H5', stroke: 'currentColor' }),
        h('path', { d: 'M11 1.2h2.3c.83 0 1.5.67 1.5 1.5V5', stroke: 'currentColor' }),
        h('path', { d: 'M14.8 11v2.3c0 .83-.67 1.5-1.5 1.5H11', stroke: 'currentColor' }),
        h('path', { d: 'M5 14.8H2.7c-.83 0-1.5-.67-1.5-1.5V11', stroke: 'currentColor' }),
        h('rect', { x: 5.1, y: 5.1, width: 5.8, height: 5.8, rx: 1.1, stroke: 'currentColor' }),
      )
    }

    let toastStack = null
    function toast(text, kind) {
      if (typeof document === 'undefined') return
      if (toastStack === null || !toastStack.isConnected) {
        toastStack = document.createElement('div')
        toastStack.className = 'dsc-toast-stack'
        document.body.appendChild(toastStack)
      }
      const element = document.createElement('div')
      element.className = kind === 'error' ? 'dsc-toast dsc-toast-error' : 'dsc-toast'
      element.setAttribute('role', 'status')
      element.textContent = text
      toastStack.appendChild(element)
      window.setTimeout(() => element.remove(), 4200)
    }

    /** base64 → bytes without pulling in any external module. */
    function base64ToBytes(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return bytes
    }

    /** @param {boolean} hide whether the Host should hide the GUI window first */
    async function requestCapture(hide) {
      const response = await fetch(`${PREFIX}/capture`, {
        method: 'POST',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ hide }),
        signal:
          typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : undefined,
      })
      const raw = await response.text()
      let body = {}
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {}
      } catch {
        body = {}
      }
      return { ok: response.ok, status: response.status, body }
    }

    /**
     * Place one captured PNG into the session's composer draft through the
     * same conversation-service path a pasted image takes: create the draft
     * attachment, then hand its id to the session's input shell.
     */
    function attachCapture(conversation, sessionId, file) {
      const drafts = conversation.createDrafts(sessionId, [file])
      let added = false
      try {
        const shell = conversation.input.shell(sessionId)
        added = shell.addFiles([], drafts.map((draft) => draft.id)) === true
      } catch {
        added = false
      }
      if (!added) {
        try {
          conversation.releaseDraftAttachments(drafts)
        } catch {
          // Nothing else to clean up; the drafts die with the service fiber.
        }
      }
      return added
    }

    function makeRunner(conversation, t) {
      let inFlight = false
      return async function run(session, hide) {
        const sessionId = session?.sessionId
        if (inFlight || typeof sessionId !== 'string' || sessionId.length === 0) return
        inFlight = true
        try {
          let result
          try {
            result = await requestCapture(hide)
          } catch (cause) {
            const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError'
            toast(timedOut ? t('error.timeout') : t('error.unavailable'), 'error')
            return
          }
          if (!result.ok) {
            if (result.status === 409) toast(result.body?.error || t('error.busy'), 'error')
            else toast(result.body?.error || t('error.unavailable'), 'error')
            return
          }
          // Esc / right-click in the native overlay: the user changed their
          // mind, so stay completely silent.
          if (result.body?.cancelled === true) return
          if (typeof result.body?.image !== 'string' || result.body.image.length === 0) {
            toast(t('error.empty'), 'error')
            return
          }
          const name =
            typeof result.body.name === 'string' && result.body.name.length > 0
              ? result.body.name
              : `screenshot-${Date.now()}.png`
          const file = new File([base64ToBytes(result.body.image)], name, { type: 'image/png' })
          let added = false
          try {
            added = attachCapture(conversation, sessionId, file)
          } catch {
            added = false
          }
          if (!added) toast(t('error.inject'), 'error')
        } finally {
          inFlight = false
        }
      }
    }

    /** Reflect the sticky mode onto one row toggle (green filled vs hollow). */
    function syncAug(aug) {
      aug.classList.toggle('dsc-aug-on', mode.hide)
      aug.setAttribute('aria-checked', mode.hide ? 'true' : 'false')
    }

    /**
     * The hover reveal on the menu row: a pill reading "○ 隐藏窗口截图".
     * Clicking flips the sticky mode and repaints the dot green (or back to
     * hollow). The row itself is a <button role="option"> whose pick fires on
     * mousedown, so every pointer event here stops propagation natively —
     * before React's delegated root listener ever sees it.
     */
    function makeAug(t) {
      const aug = document.createElement('span')
      aug.className = 'dsc-aug'
      aug.setAttribute('role', 'checkbox')
      aug.setAttribute('tabindex', '-1')
      aug.setAttribute('aria-label', t('toggle.label'))
      aug.title = t('toggle.title')
      const dot = document.createElement('span')
      dot.className = 'dsc-aug-dot'
      const text = document.createElement('span')
      text.textContent = t('toggle.label')
      aug.append(dot, text)
      syncAug(aug)
      const swallow = (event) => {
        event.stopPropagation()
        event.preventDefault()
      }
      aug.addEventListener('mousedown', swallow)
      aug.addEventListener('mouseup', (event) => event.stopPropagation())
      aug.addEventListener('click', (event) => {
        swallow(event)
        mode.hide = !mode.hide
        writeHide(mode.hide)
        syncAug(aug)
      })
      return aug
    }

    /**
     * The row's description span: the contribution's description text, which
     * is also the only child stretched to fill the row (flex: 1). Located
     * structurally so nothing depends on the menu's hashed CSS class names.
     */
    function findDescription(row, aug, t) {
      const wanted = t('command.description')
      for (const child of row.children) {
        if (child === aug || child.tagName !== 'SPAN') continue
        if (child.textContent === wanted) return child
      }
      for (const child of row.children) {
        if (child === aug || child.tagName !== 'SPAN') continue
        try {
          if (window.getComputedStyle(child).flexGrow === '1') return child
        } catch {
          // Computed style unavailable in this runtime; the text pass above
          // is the only identification then.
        }
      }
      return null
    }

    /** Attach the hover toggle to one menu row, once per row element. */
    function augmentRow(row, t) {
      if (row.dataset.dscAug === '1' || !row.isConnected) return
      row.dataset.dscAug = '1'
      const aug = makeAug(t)
      row.appendChild(aug)
      const description = findDescription(row, aug, t)
      const show = () => {
        aug.style.display = 'inline-flex'
        // While the toggle is revealed, the description steps aside.
        if (description !== null) description.style.visibility = 'hidden'
      }
      const hide = () => {
        aug.style.display = 'none'
        if (description !== null) description.style.visibility = ''
      }
      // Native listeners + inline styles: React rewrites the row's className
      // on every highlight change, so nothing here may depend on row classes.
      row.addEventListener('mouseenter', show)
      row.addEventListener('mouseleave', hide)
      try {
        if (row.matches(':hover')) show()
      } catch {
        // :hover unsupported in this runtime; the toggle stays hover-revealed.
      }
    }

    /**
     * Delegation hook: entering ANYWHERE inside the marked menu row arms the
     * hover toggle. Row-level (not icon-level) on purpose — the 14px icon is
     * far too small an entry target, and rows are recreated on every menu
     * open, so this re-arms by itself.
     */
    function installRowAugmenter(ctx, t) {
      return ctx.effect(() => {
        const onMouseOver = (event) => {
          const target = event.target
          if (!(target instanceof Element) || typeof target.closest !== 'function') return
          const row = target.closest('[role="option"]')
          if (row === null || row.dataset.dscAug === '1') return
          if (row.querySelector('svg[data-dsc-icon]') === null) return
          augmentRow(row, t)
        }
        document.addEventListener('mouseover', onMouseOver)
        return () => document.removeEventListener('mouseover', onMouseOver)
      }, 'screenshot: menu row hover toggle')
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'screenshot: dictionaries')
      const t = ctx.locale.bind(NS)

      /** Stays true unless the Host explicitly reports an unsupported platform. */
      const supported = { value: true }
      ctx.effect(() => {
        let disposed = false
        fetch(`${PREFIX}/health`, { cache: 'no-store', headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((body) => {
            if (!disposed && body && body.supported === false) supported.value = false
          })
          .catch(() => {})
        const element = document.createElement('style')
        element.dataset.dshPlugin = NS
        element.textContent = styles
        document.head.appendChild(element)
        return () => {
          disposed = true
          element.remove()
        }
      }, 'screenshot: host probe + styles')

      installRowAugmenter(ctx, t)

      ctx.inject(['commandUi', 'conversation'], (scope) => {
        const commands = scope.get('commandUi')
        const conversation = scope.get('conversation')
        const run = makeRunner(conversation, t)
        scope.effect(
          () =>
            commands.register({
              name: 'screenshot',
              label: () => t('command.label'),
              description: () => t('command.description'),
              icon: GlyphScreenshot,
              available: () => supported.value,
              ui: {
                kind: 'action',
                run: (session) => {
                  void run(session, mode.hide)
                },
              },
            }),
          'screenshot: composer command',
        )
      })
    }

    return {
      inject: ['locale'],
      apply,
    }
  },
})
