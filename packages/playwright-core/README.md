# playwright-codegen-pro-core

Internal core engine for [playwright-codegen-pro](https://www.npmjs.com/package/playwright-codegen-pro).

This package is not intended to be installed directly. Install `playwright-codegen-pro` instead:

```bash
npm install -g playwright-codegen-pro
```

This is a fork of `playwright-core` (`1.59.0-next`) with the following additions:
- `NetworkCapture` — classifies browser requests into direct/pageLoad/noise buckets
- `SessionRedactor` — strips passwords, tokens, and credit card numbers from captured data
- `SessionPromptBuilder` — builds structured AI prompts from recorded sessions
- `recorder_get_session` MCP tool — exposes the live session to AI assistants
- `--ai-codegen` always-on codegen mode with live `.playwright-session.md` output
