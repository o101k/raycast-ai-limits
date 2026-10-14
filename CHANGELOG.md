# AI Limits Changelog

## [Initial Version] - {PR_MERGE_DATE}

- Show Limits As: percent used or percent left, with colored tags at 70% and 90%
- Usage for Claude, Codex, Cursor, Gemini, GitHub Copilot, OpenRouter, z.ai, Kimi Code, DeepSeek and Moonshot
- Reset times for each window, and balances or credits where the provider reports them
- Detail pane with progress bars, plan, account, source and when the data was updated
- Providers that aren't connected are listed with a Connect action for each
- Connect on each provider: Claude Code, Codex and Gemini CLI sign in through Terminal, Cursor signs in through its app, GitHub signs in with OAuth, and an API key opens its key page
- Connect Claude Code reads Claude Code's login from the macOS Keychain, after you allow it once
- Connect OpenRouter with OpenRouter's sign-in, which creates a new API key on your account each time
- Connect GitHub for Copilot, without a token in preferences
- Disconnect removes what Connect saved
- Fallback actions for a claude.ai session key, a Cursor session cookie and an OpenRouter API key
- The last result of each provider is kept, so the list opens with numbers while it refreshes
- Copy Usage, Open Usage Dashboard and Refresh actions
