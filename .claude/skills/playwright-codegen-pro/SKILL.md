---
name: playwright-codegen-pro
description: Record a real browser flow into a polished Playwright test using the playwright-codegen-pro MCP server (tools recorder_get_session / recorder_reset). Use whenever the user wants to write, record, generate, or "codegen" a Playwright test by driving a live browser. This is NOT the standard Playwright MCP — recording is always-on and you finish by reading back the recorded session.
---

# Playwright Codegen Pro — record a browser flow into a test

This is a **portable agent skill**. It teaches any AI coding tool (Claude Code, Cursor, GitHub Copilot, Cline, Windsurf, Aider, …) how to use the **`playwright-codegen-pro`** MCP server. Drop this file where your tool reads instructions (see "Install this skill" at the bottom) — the content is what matters, not the tool.

## What this MCP is (and how to recognize it)

`playwright-codegen-pro` is an **AI-ready fork of the Playwright recorder**, exposed over MCP. It has the same `browser_*` automation tools as the standard Playwright MCP **plus two tools that no other server has**:

- **`recorder_get_session`** — read back the session recorded so far (actions + classified API calls + redacted payloads + a best-practices prompt).
- **`recorder_reset`** — start a fresh recording; optionally named, to split back-to-back flows into separate test files.

**If you see `recorder_get_session` in your available tools, you are on Codegen Pro — use this skill.** If you only see `browser_*` tools and no `recorder_*`, you are on the *standard* Playwright MCP; tell the user to configure `playwright-codegen-pro` instead (see setup) — this workflow will not work there.

**The defining behavior: recording is always-on.** Every `browser_*` tool you call is captured automatically into:
- `.playwright-session.md` — the structured prompt (actions, API calls classified direct / page-load / noise, redacted request+response bodies, cleanup hints).
- `tests/mcp-session.spec.ts` — a runnable draft test that grows with each action.

You do **not** write a script and run-fail-fix. You **drive the browser**, and a test falls out.

## When to use

Any request shaped like: "write a test for <flow>", "record a test", "generate a Playwright test for logging in / checkout / creating X", "codegen this page". Use it by **acting in the browser**, not by hand-authoring a spec from memory.

## Golden workflow

1. **Drive the scenario with the `browser_*` tools.** `browser_navigate` to the start, then `browser_snapshot` to see the accessibility tree, then `browser_click` / `browser_fill_form` / `browser_type` / `browser_select_option` etc. **Read each tool's returned snapshot before deciding the next step** — that is how you locate elements. Do the whole user scenario end to end.
2. **Call `recorder_get_session`.** This returns the accumulated session prompt, including the captured API calls and the target file name.
3. **Produce ONE polished final test** from that session, following the best practices below, and **save it to the target file named in the session** (default `tests/mcp-session.spec.ts`, or the name you passed to `recorder_reset`). The draft file is a starting point — replace it with the cleaned-up version.

### Back-to-back flows

Recording several independent flows in one session? Call **`recorder_reset({ name: "<flow>" })` between them** so each becomes its own clean test file instead of piling into one. Typical loop:

> drive flow A → `recorder_get_session` → write test A → `recorder_reset({ name: "checkout" })` → drive flow B → `recorder_get_session` → write test B

`recorder_reset({ name: "login" })` writes that flow's draft to `tests/login.spec.ts`; the previous flow's file is left in place.

### Also works with `codegen`

`recorder_get_session` also reads a session from a separate **`playwright-codegen-pro codegen <url>`** run a human is recording by hand (`.playwright-session.md` live, or `.playwright-prompt.md` after they click "Generate Test"). Same step 2→3.

## Best practices for the final test (follow exactly)

- **No hard waits.** Never `page.waitForTimeout()`, `waitForLoadState()`, or `waitForNavigation()`.
- **Web-first assertions.** Use `await expect(locator).toBeVisible()` / `.toHaveText()` etc. Add a meaningful assertion **before and after** each significant action.
- **Role-based locators.** Prefer `getByRole`, `getByLabel`, `getByPlaceholder`, `getByTestId` over CSS/XPath.
- **Wrap API-triggering clicks.** For actions the session marks with `direct` API calls, wrap the click in `Promise.all([page.waitForResponse(...), locator.click()])`.
- **Never assert on generated values** — no auto IDs, UUIDs, or timestamps from response bodies.
- **Clean up created data.** For any `POST … → 201` in the session, add an `afterEach` that deletes the created record by its response ID.
- **Secrets via env.** Use `process.env.TEST_*` for credentials (the session already redacts real secrets).
- Structure as `test.describe` with one clear `test` per scenario. File starts with `import { test, expect } from '@playwright/test';`.

## Anti-patterns (do NOT do these)

- ❌ Hand-writing the spec from memory instead of driving the browser and reading the session. The recording captures the real selectors and the real API calls — your guess won't.
- ❌ Treating this like the standard Playwright MCP and ignoring `recorder_get_session`. You'll skip all the captured API context and cleanup hints.
- ❌ Piling multiple unrelated flows into one recording. Use `recorder_reset` between them.
- ❌ Adding `waitForTimeout` to "fix" flakiness. Use web-first assertions.

## Install this skill (any tool)

The MCP server must be configured first (see the project README's "MCP Setup"). Then make this file visible to your assistant:

- **Claude Code / Claude apps** — already a skill at `.claude/skills/playwright-codegen-pro/SKILL.md`; it loads automatically.
- **Cursor** — copy this file's body into `.cursor/rules/playwright-codegen-pro.mdc`.
- **GitHub Copilot** — append it to `.github/copilot-instructions.md`.
- **Cline / Windsurf / Aider / other** — append it to your project's `AGENTS.md` (or the tool's rules file).

The server also sends this workflow as MCP `instructions` on connect and prints a one-line reminder on the first browser action, so a tool that reads neither still gets the essentials — this file just makes it reliable.
