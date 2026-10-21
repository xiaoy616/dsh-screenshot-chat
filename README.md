# dsh-screenshot-chat

A DeepSeek Harness plugin that adds a **Screenshot** entry to the chat composer's **`+` menu**, so a region captured on your Mac lands in the input box as an image attachment.

## Features

- **One-click region capture** — opens the native macOS selection overlay (the same one as `⇧⌘4`), and the selected region arrives in the current conversation's composer as an **image attachment**, ready to send with your next message. Pressing `Esc` or right-clicking cancels silently.
- **Hide-window capture** — hover the *Screenshot* row and a small toggle appears on the right (`○ Hide window`). Turn it on and the window that is frontmost when you click is hidden first, then the selection overlay appears; when the capture finishes or is cancelled, the window is restored and brought back to the front.
- **Mode is remembered** — the toggle state is stored in `localStorage` and survives page reloads. While it is on, the menu item's description also shows the active mode, so you can see it without hovering.
- **Platform-aware** — the menu entry is hidden automatically on platforms without `screencapture` (anything other than macOS).

## Install

```bash
dsh plugin add dsh-screenshot-chat
```

Then restart DeepSeek Harness (or reload the web client) so the bundle is composed.

### Local development

Point a profile at a checkout instead of the published package:

```json
{
  "dependencies": {
    "dsh-screenshot-chat": "link:/absolute/path/to/dsh-screenshot"
  },
  "dsh": { "profile": { "bundles": ["...", "dsh-screenshot-chat"] } }
}
```

Run `pnpm install` in the profile. With HMR enabled, config changes apply immediately; otherwise restart DSH. Host-side edits (`index.js`) take effect after touching the profile's `cordis.patch.yml` (any change re-composes the tree without a restart); client-side edits (`client.js`) are hot-replaced by the client HMR poll.

## Usage

1. Click **`+` → Screenshot** in the composer.
2. Drag to select a region on screen.
3. The capture appears in the composer as an image attachment — send it as usual.

To capture without the DSH window in the shot, hover the menu entry, switch on **Hide window**, then click *Screenshot*. The window disappears during selection and comes back afterwards.

## Configuration

Override the defaults from your profile patch, keyed by the plugin id:

```yaml
- id: dsh-screenshot-chat
  name: 'dsh-screenshot-chat'
  config:
    timeoutMs: 180000   # how long the region selection may stay open
```

## How it works

### Host side (`index.js`)

Registers same-origin routes under `/.dsh-screenshot` on the host web server:

- `POST /capture` with body `{ "hide": true | false }`
  - Runs `screencapture -i -x -o <tempfile>`, waits for the selection, then returns the PNG as base64 and deletes the temp file immediately. A cancelled selection returns `{ cancelled: true }`.
  - With `hide: true` it first resolves the **frontmost process name** through AppleScript (System Events) and hides it (the equivalent of `⌘H`, with a system-level denylist — Finder, Dock, System Settings and friends are never hidden), waits for the hide animation to settle (350 ms), then captures. A `finally` block restores and re-focuses the window whether the capture succeeded, was cancelled, or timed out.
- `GET /health` lets the browser half probe platform support (the entry is hidden off macOS).

Only one capture may run at a time. A capture that stays open longer than `timeoutMs` (default 180 s) is terminated, and `osascript` calls time out after 60 s.

### Browser side (`client.js`)

Contributes a `screenshot` command to the `+` menu through `commandUi.register` (`kind: 'action'`, so a click runs the current mode). A document-level `mouseover` delegate spots the menu row carrying the `data-dsc-icon` marker and mounts the hover toggle inside it, using native listeners and inline styles so it does not depend on the menu component's internal class names. `mousedown` and `click` on the toggle stop propagation so the row is not selected.

The returned image is wrapped in a `File` and handed to `conversation.createDrafts` plus the composer's `addFiles` — the exact same attachment path as pasting an image, so previews, size limits, and upload encoding all run through the host's existing logic.

## Permissions (macOS)

1. **Screen Recording** — the first capture may prompt for authorization, or grant it under **System Settings → Privacy & Security → Screen Recording** for the app running the DSH host. Without it, captures can come out as wallpaper only.
2. **Automation** (hide-window capture only) — hiding and restoring the window uses System Events, so macOS asks to allow controlling System Events on first use; the same switch lives under **System Settings → Privacy & Security → Automation**. Denying it leaves plain region capture working; hide-window capture shows an authorization hint instead.

## Limitations

- Interactive region selection relies on macOS `screencapture -i`, so the plugin works on macOS only; the menu entry hides itself elsewhere.
- Capture runs on the Mac hosting the DSH process, not on the machine running the browser. For a local deployment these are the same machine.
- *Hide window* hides whichever app is frontmost at the moment you click. If you switch to another app immediately after clicking, that app is the one hidden.

## License

MIT