# DQ Workspace

DataQuartz work tools in one Mac app. Each app (GitLab, Plane, Google Chat, and any you add) runs in its own signed-in panel, with native notifications, unread badges and link routing.

## Install a prebuilt build

1. Unzip `DQ Workspace-0.1.0-arm64-mac.zip` (Apple silicon) or `DQ Workspace-0.1.0-mac.zip` (Intel).
2. Move **DQ Workspace.app** to **Applications**.
3. The build is not signed with an Apple Developer ID, so run this once in Terminal before the first launch:

   ```bash
   xattr -cr "/Applications/DQ Workspace.app"
   codesign --force --deep --sign - "/Applications/DQ Workspace.app"
   ```

   The first line removes the "downloaded from the internet" quarantine flag. The second gives the app a local (ad-hoc) signature, which Apple silicon Macs need before they will run it.
4. Open the app. When macOS asks, allow notifications.

GitLab and Plane need **Tailscale** to be connected. If it isn't, their panels show "Can't reach the tailnet" and retry every 30 seconds.

## Build it yourself (on a Mac)

```bash
npm install
npm start              # run from source
npm run build:mac      # .dmg and .zip for Apple silicon and Intel, in dist/
```

On a Mac, electron-builder signs the app ad hoc by itself, so the `codesign` step above is not needed for your own builds. With an Apple Developer ID certificate in your keychain it signs with that; add notarization to remove the first-launch warning for everyone.

## Using it

| Shortcut | Action |
| --- | --- |
| ⌘1 – ⌘9 | Switch to app 1–9 |
| ⌥⌘↑ / ⌥⌘↓ | Previous / next app |
| ⌘K | Quick switcher |
| ⌘[ / ⌘] | Back / forward |
| ⌘R | Reload |
| ⇧⌘H | App's start page |
| ⇧⌘C | Copy current link |
| ⌘L | Open current page in your browser |
| ⌘, | Settings |
| ⌥⌘I | Developer tools for the current app |

- **Right-click an app icon** in the sidebar to mute its notifications, refresh its icon, edit it, or clear its data and sign out.
- **Links:** a link to GitLab, Plane or Chat opens in that app's panel. Any other link opens in your default browser.
- **Closing the window** keeps the app running so notifications still arrive. Quit with ⌘Q.
- **Deep links:** `dqws://gitlab/group/project/-/merge_requests/12` opens that path in GitLab; `dqws://open?url=<encoded url>` routes any URL.

## Adding apps

Use **Settings → Add app**, or edit `~/Library/Application Support/DQ Workspace/apps.json`. The app reloads that file when it is saved. The team defaults are in `config/default-apps.json`; **Settings → Reset apps to team defaults** restores them.

```json
{
  "id": "plane",
  "name": "Plane",
  "url": "https://tasks.taild6271e.ts.net",
  "hosts": ["tasks.taild6271e.ts.net"],
  "authHosts": [],
  "icon": "auto",
  "badge": { "from": "title" },
  "network": "tailscale",
  "notifications": true,
  "permissions": ["notifications", "clipboard-sanitized-write", "fullscreen"]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique; also names the app's private session (`persist:<id>`). |
| `url` | Start page. |
| `hosts` | Links to these hosts open in this app (`*.example.com` allowed). |
| `authHosts` | Hosts the sign-in flow may visit inside the app, but which other apps' links don't route to (e.g. `accounts.google.com`). |
| `icon` | `auto` (site icon), an image URL, or a file path. Missing icons show a letter tile. |
| `badge.from` | `title` (number in the page title, optional `pattern` regex), `api` (same-origin request: `path` plus `header` or `json` field), `selector` (CSS selector whose text is the count), or `none`. |
| `network` | `tailscale` shows the offline screen when the tailnet is unreachable. |
| `permissions` | Web permissions granted; add `media` for camera and microphone. |

GitLab's unread count comes from `/api/v4/todos?state=pending` (the `X-Total` header), using your signed-in session.

## Project layout

```
src/main/main.js      window, app panels, routing, notifications, badges, menus
src/main/config.js    apps.json and prefs: load, validate, save, watch
src/preload/app.js    notification bridge injected into each app (sandboxed)
src/preload/shell.js  narrow API for the shell UI
src/shell/            sidebar, toolbar, settings, switcher, About (DataQuartz brand)
config/               team default apps
build/                app icon (from the DataQuartz crystal)
```

## Security

Every app panel runs sandboxed with context isolation and no Node access, in its own session. A panel can only navigate inside its own hosts. Permissions are denied unless listed for that app. The app sends no telemetry.

## Known limits (v0.1)

- **Google sign-in:** the Chat panel presents itself as Chrome, which usually satisfies Google. If Google still says "This browser or app may not be secure", tell us; the fallback is a system-browser sign-in.
- **Plane unread count** reads the page title. If Plane doesn't put a count in its title, switch it to `api` with your workspace's notifications endpoint.
- **Updates** are manual for now: download the new zip. Auto-update needs a signed build and a release feed (planned for milestone 4).
