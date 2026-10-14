# AI Limits

See how much of your AI coding limits you've used, when they reset, and what credit is left, in one Raycast list. It covers Claude, Codex, Cursor, Gemini, GitHub Copilot, and API accounts for OpenRouter, z.ai, Kimi Code, DeepSeek and Moonshot.

Run **Show AI Usage**. Each provider shows its headline limit as a colored tag (green below 70% used, yellow below 90%, red from 90%), with the time until it resets. The detail pane has every window with a progress bar, balances, and any notes.

## Supported providers

| Provider           | What you need                                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude**         | The `sessionKey` cookie from claude.ai, pasted into **Claude Session Key**. On macOS, Claude Code usually keeps its login in the Keychain, which this extension doesn't read, so most Mac users need the cookie. If `~/.claude/.credentials.json` exists, it is used instead. |
| **Codex**          | Sign in with `codex login`. The extension reads `~/.codex/auth.json`.                                                                                                                                                                                                         |
| **Cursor**         | The Cursor app signed in on this Mac, or the `WorkosCursorSessionToken` cookie from cursor.com pasted into **Cursor Session Cookie**.                                                                                                                                         |
| **Gemini**         | Sign in with the Gemini CLI (Google login). The extension reads `~/.gemini/oauth_creds.json`. Google retired Gemini CLI sign-in for personal Google accounts in June 2026. It still works with Google Workspace and Gemini Code Assist Standard accounts.                     |
| **GitHub Copilot** | Choose **Sign in with GitHub** from the Copilot item, which uses Raycast's GitHub OAuth with the `read:user` scope. Or paste a token (for example from `gh auth token`) into **GitHub Token for Copilot**.                                                                    |
| **OpenRouter**     | An API key in **OpenRouter API Key**.                                                                                                                                                                                                                                         |
| **z.ai**           | A GLM Coding Plan API key in **z.ai API Key**, and the region it was issued in.                                                                                                                                                                                               |
| **Kimi Code**      | A Kimi Code (coding plan) API key in **Kimi Code API Key**.                                                                                                                                                                                                                   |
| **DeepSeek**       | An API key in **DeepSeek API Key**.                                                                                                                                                                                                                                           |
| **Moonshot**       | An API key in **Moonshot API Key**, and the region it was issued in.                                                                                                                                                                                                          |

Providers without credentials appear under **Not Connected**, with the steps to connect them. Turn that section off with the **Providers** preference.

## Preferences

- **Show Limits As**: percent used (default) or percent left.
- **Providers**: show or hide providers that aren't connected.
- The provider keys and cookies listed above. Each is optional, and only needed when the extension can't find the credentials on this Mac.

## How to copy a session cookie

The Claude and Cursor preferences need a browser cookie. This is how to copy one in Chrome or Safari:

1. Sign in to the site (claude.ai or cursor.com) in your browser.
2. Open the developer tools: in Chrome, press Cmd+Option+I, then open the **Application** tab. In Safari, enable the Develop menu in Settings > Advanced, then press Cmd+Option+I.
3. In the left sidebar, open **Cookies** and choose the site.
4. Click the cookie (`sessionKey` for claude.ai, `WorkosCursorSessionToken` for cursor.com) and copy its **Value**.
5. Paste it into the matching preference in Raycast.

Cookies expire when the site signs you out. When a provider says the credentials were rejected, copy a fresh one.

## Privacy

- Your credentials stay on this Mac. They are only sent to the provider they belong to, over HTTPS.
- Claude Code stores its login in the macOS Keychain. This extension doesn't read it: Raycast extensions shouldn't read other apps' Keychain items, and doing so would prompt for your password. Claude's usage comes from `~/.claude/.credentials.json` when it exists, or from the session cookie.
- The extension never writes to other apps' files. It never refreshes a token in a way that would sign out Claude Code or Codex, since those CLIs rotate their refresh tokens.
- Cursor's local database is opened read-only, with the system `sqlite3` tool.
- The usage numbers are cached on this Mac so the list opens instantly. Nothing is sent anywhere else. There is no analytics.

## Inspired by CodexBar

This extension is inspired by [CodexBar](https://github.com/steipete/CodexBar), a menu bar app for the same kind of usage numbers. The provider endpoints and credential locations follow the way CodexBar reads them.
