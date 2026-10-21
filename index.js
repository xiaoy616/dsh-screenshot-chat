/**
 * Host half of the Screenshot bundle.
 *
 * It exposes one same-origin HTTP route under `/.dsh-screenshot`:
 *
 *   GET  /health   platform/busy probe used by the browser half to decide
 *                  whether the composer command should be offered at all
 *   POST /capture  runs the native macOS interactive screen capture
 *                  (`screencapture -i`), waits for the user to drag out a
 *                  region (Esc cancels), then answers with the PNG as base64.
 *                  Body `{ "hide": true }` first hides the frontmost app
 *                  (the window the capture was requested from) through
 *                  System Events, and always restores it afterwards.
 *
 * The captured bytes are handed to the browser, which turns them into an
 * ordinary composer image attachment; the temporary file is removed right
 * after it is read, so nothing persists on disk.
 *
 * @module dsh-screenshot
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-screenshot-chat'

/** Services this bundle reads; a profile without one leaves it inactive. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/.dsh-screenshot'
const ROUTE_HEALTH = `${ROUTE_PREFIX}/health`
const ROUTE_CAPTURE = `${ROUTE_PREFIX}/capture`
/** The native selection overlay stays open until the user acts; cap it anyway. */
const DEFAULT_TIMEOUT_MS = 180_000
/** A sane upper bound so one giant display cannot blow up the JSON response. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_BODY_BYTES = 4 * 1024
/** Hiding a window runs its genie animation; give it a beat before capturing. */
const HIDE_SETTLE_MS = 350
/** osascript itself is instant, but the first Automation prompt waits on the user. */
const OSCRIPT_TIMEOUT_MS = 60_000
/** System processes that must never be hidden even if one is frontmost. */
const HIDE_DENYLIST = new Set([
  'Dock',
  'Finder',
  'Window Server',
  'System Events',
  'System Settings',
  'System Preferences',
  'loginwindow',
  'Spotlight',
  'Control Center',
  'NotificationCenter',
])

/** The single in-flight native capture, if any (the OS overlay is modal). */
let active = null

/** @param {unknown} error */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** @param {number} status @param {string} message */
function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Refuse a browser request that did not originate from this same Web origin. */
function assertSameOrigin(req) {
  const origin = req.headers.origin
  if (origin !== undefined) {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      throw httpError(403, 'Cross-origin request rejected.')
    }
    if (parsed.host !== req.headers.host) throw httpError(403, 'Cross-origin request rejected.')
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw httpError(403, 'Cross-origin request rejected.')
  }
}

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    throw httpError(400, 'Request body must be JSON.')
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `screenshot-20261021-004512.png` in local time. */
function captureName() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
  )
}

/**
 * Run one osascript and resolve with its outcome (never rejects).
 * @param {string} script
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function osascript(script) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (cause) {
      resolve({ code: -1, stdout: '', stderr: errorText(cause) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), OSCRIPT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (cause) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr || errorText(cause) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Quote one AppleScript string literal. */
function appleQuoted(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Turn one System Events failure into a user-facing diagnostic. */
function oscriptError(stderr) {
  if (/(-1743|Not authorized|not authorized)/.test(stderr)) {
    return (
      'Automation permission is required to hide the window: allow this app to control ' +
      '"System Events" in System Settings → Privacy & Security → Automation, then retry.'
    )
  }
  return `Could not control System Events: ${stderr.trim().slice(0, 200) || 'unknown error'}`
}

/**
 * The name of the frontmost (user-facing) process — the app hosting the GUI
 * the capture was requested from.
 * @returns {Promise<string>}
 */
async function frontmostAppName() {
  const result = await osascript(
    'tell application "System Events" to get name of first process whose frontmost is true',
  )
  const name = result.stdout.trim()
  if (result.code !== 0 || name.length === 0) throw httpError(500, oscriptError(result.stderr))
  if (HIDE_DENYLIST.has(name)) {
    throw httpError(409, `Refusing to hide the frontmost system app "${name}".`)
  }
  return name
}

/**
 * Hide (or reveal) one app through System Events; revealing also brings it
 * back to the front so the user lands on the composer with the new capture.
 * @param {string} name @param {boolean} visible @param {boolean} [front]
 */
async function setAppVisible(name, visible, front = false) {
  const quoted = appleQuoted(name)
  const script =
    visible && front
      ? `tell application "System Events"\nset visible of process ${quoted} to true\nset frontmost of process ${quoted} to true\nend tell`
      : `tell application "System Events" to set visible of process ${quoted} to ${visible}`
  const result = await osascript(script)
  if (result.code !== 0) throw httpError(500, oscriptError(result.stderr))
}

/**
 * Run one interactive capture and resolve with its outcome.
 *
 * `screencapture -i` shows the native crosshair/region overlay (the same one
 * the system shortcut uses); dragging a rectangle and releasing captures it,
 * Esc or a right-click cancels. Cancellation exits non-zero without writing
 * the file, which is reported as `{ cancelled: true }`, never as an error.
 *
 * @param {number} timeoutMs
 * @returns {Promise<{image?: string, name?: string, bytes?: number, cancelled?: boolean, error?: string}>}
 */
function captureInteractive(timeoutMs) {
  const file = join(tmpdir(), `dsh-screenshot-${Date.now()}-${randomBytes(4).toString('hex')}.png`)
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      // -i interactive region/window selection, -x no shutter sound,
      // -o no window shadow when a window is clicked instead of dragged.
      child = spawn('screencapture', ['-i', '-x', '-o', file], { stdio: 'ignore' })
    } catch (cause) {
      resolve({ error: `Could not start screencapture: ${errorText(cause)}` })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      active = null
      child.kill('SIGKILL')
      void fs.unlink(file).catch(() => {})
      resolve({ error: 'Screen capture timed out.' })
    }, timeoutMs)
    active = { child }
    child.once('error', (cause) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active = null
      void fs.unlink(file).catch(() => {})
      resolve({ error: `screencapture failed to start: ${errorText(cause)}` })
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active = null
      void fs
        .stat(file)
        .then(async (stat) => {
          if (code === 0 && stat.isFile() && stat.size > 0) {
            if (stat.size > MAX_IMAGE_BYTES) {
              return { error: 'Captured image is too large.' }
            }
            const buffer = await fs.readFile(file)
            return { image: buffer.toString('base64'), name: captureName(), bytes: buffer.length }
          }
          // Any non-zero exit (Esc, right-click, denied permission) or a
          // missing/empty file is a user cancellation, not a failure.
          return { cancelled: true, code }
        })
        .catch(() => ({ cancelled: true, code }))
        .then((result) => {
          void fs.unlink(file).catch(() => {})
          resolve(result)
        })
    })
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config = {}) {
  const timeoutMs =
    Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? Number(config.timeoutMs)
      : DEFAULT_TIMEOUT_MS

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname
        try {
          assertSameOrigin(req)
          if (route === ROUTE_HEALTH && req.method === 'GET') {
            return sendJson(res, 200, {
              supported: process.platform === 'darwin',
              platform: process.platform,
              hideSupported: process.platform === 'darwin',
              version: '0.2.0',
              busy: active !== null,
            })
          }
          if (route === ROUTE_CAPTURE && req.method === 'POST') {
            if (process.platform !== 'darwin') {
              throw httpError(400, 'Interactive screen capture requires macOS.')
            }
            if (active !== null) {
              throw httpError(409, 'A screen capture is already in progress.')
            }
            const body = await readJson(req)
            const hide = body.hide === true
            /** @type {string | null} */
            let hiddenApp = null
            /** @type {{image?: string, name?: string, bytes?: number, cancelled?: boolean, error?: string}} */
            let result
            try {
              if (hide) {
                hiddenApp = await frontmostAppName()
                await setAppVisible(hiddenApp, false)
                await delay(HIDE_SETTLE_MS)
              }
              result = await captureInteractive(timeoutMs)
            } finally {
              // Whatever happened — capture, cancel, timeout, or a thrown
              // error — a hidden window always comes back to the front.
              if (hiddenApp !== null) {
                try {
                  await setAppVisible(hiddenApp, true, true)
                } catch {
                  // The app is gone or System Events refused; nothing left to
                  // restore, and the user can re-focus it from the Dock.
                }
              }
            }
            if (result.error !== undefined) throw httpError(500, result.error)
            return sendJson(res, 200, { ...result, ...(hiddenApp !== null ? { hidApp: hiddenApp } : {}) })
          }
          return sendJson(res, 404, { error: 'Not found.' })
        } catch (cause) {
          const status = Number.isInteger(cause?.status) ? cause.status : 500
          return sendJson(res, status, { error: errorText(cause) })
        }
      },
    }),
  )
}
