# playwright-codegen-pro

A fork of [Playwright](https://playwright.dev) that supercharges the codegen recorder with AI-ready output — network capture, data redaction, structured prompt export, and MCP integration.

Record your browser session and get a structured prompt that any AI tool (Claude Code, Cursor, ChatGPT) can use to generate a complete, production-ready Playwright test file.

## Install

```bash
npm install -g playwright-codegen-pro
playwright-codegen-pro install chromium
```

## Usage

```bash
playwright-codegen-pro codegen https://myapp.com
```

AI features are always on. The recorder will:
- Capture all API calls triggered by your actions (classified as direct/pageLoad/noise)
- Capture request payloads and response bodies
- Redact passwords, tokens, and credit card numbers automatically
- Write a live session file (`.playwright-session.md`) updated every 250ms
- Take a screenshot after every recorded action — saved under `.playwright-session-screenshots/` and referenced inline in the prompt
- Record a full session video (1280×720 WebM) — finalized as `.playwright-session.webm` when the recorder window closes

## Files Created During a Session

| File / Directory | When | Purpose |
|---|---|---|
| `.playwright-session.md` | Updated live (250ms throttle) | Structured prompt with actions, API calls, screenshot paths |
| `.playwright-session-screenshots/NNN-{action}.png` | After each action commit | Visual context for vision-capable AI |
| `.playwright-session.webm` | After recorder closes | Full session video for vision models |
| `.playwright-prompt.md` | When you click "Generate Test" | Snapshot copy of the prompt |

### Workflow 1 — Click "Generate Test"

Interact with your app, then click **Generate Test** in the recorder toolbar. The structured prompt is copied to your clipboard. Paste it into Claude, Cursor, or ChatGPT.

### Workflow 2 — AI reads the session via MCP

Configure the MCP server once (see below), then while codegen is running just tell your AI:

> "There's a codegen session running. Read the session and write a test for it."

The AI calls `recorder_get_session`, reads the live `.playwright-session.md`, and generates the test — no copy/paste needed.

## MCP Setup

The MCP server registers itself as **`playwright-codegen-pro`** (not `playwright`), so it sits alongside the official Playwright MCP without clashing — and your AI tool can tell them apart. On connect it sends instructions describing the recorder, so the assistant knows about `recorder_get_session` and how to turn a recording into a test without you explaining it.

> Use a **distinct key** (`playwright-codegen-pro`) in your config. Reusing the `playwright` key collides with the official Playwright MCP and is what makes AI tools think the server is "fake" or fall back to the wrong one.

### Claude Code

One-liner (recommended):

```bash
claude mcp add playwright-codegen-pro -- npx playwright-codegen-pro mcp
```

Or edit `~/.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "playwright-codegen-pro": {
      "command": "npx",
      "args": ["playwright-codegen-pro", "mcp"]
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "playwright-codegen-pro": {
      "command": "npx",
      "args": ["playwright-codegen-pro", "mcp"]
    }
  }
}
```

### VS Code (`.vscode/mcp.json` or user settings)

```json
{
  "servers": {
    "playwright-codegen-pro": {
      "type": "stdio",
      "command": "npx",
      "args": ["playwright-codegen-pro", "mcp"]
    }
  }
}
```

After adding it, restart/reload your AI tool and confirm the `recorder_get_session` tool is listed. If the assistant claims the server doesn't exist, it almost always means the config wasn't picked up (wrong file, not reloaded) — not that the package is missing.

## What the prompt includes

- Every recorded action (click, fill, navigate) with timing
- API calls linked to each action — method, URL, request payload, response body
- Sensitive values redacted (`[redacted]` for passwords and tokens)
- Playwright best practices baked in (no `waitForTimeout`, use `getByRole`, wrap clicks with `waitForResponse`)
- Data cleanup instructions when POST 201 creates test data

## Example output

```
## Visual Context
Per-action screenshots: 3 file(s) under .playwright-session-screenshots/ — referenced inline below. Read them as visual context for each step.
Full session video: .playwright-session.webm (finalized when the recorder window is closed).

## Recorded Session
### Page: https://myapp.com/login
- click: Sign In button at t=1200ms
  Screenshot: .playwright-session-screenshots/003-click.png
  API calls (direct):
    - POST /api/auth/login (payload: {"email":"user@example.com","password":"[redacted]"}) -> 200
      (body: {"token":"[redacted]","user":{"email":"user@example.com"}})
    - GET /api/dashboard -> 200 (body: {"items":[...]})
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `recorder_get_session` | Read the current or last recorded session |
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element |
| `browser_snapshot` | Get the accessibility tree |
| + 30 more | Full Playwright browser automation via MCP |

## Based on

Playwright `1.59.0-next` — all standard Playwright APIs and test runner features work as normal.

---

## [Playwright Documentation](https://playwright.dev) | [API reference](https://playwright.dev/docs/api/class-playwright)

Playwright is a framework for Web Testing and Automation. It allows testing [Chromium](https://www.chromium.org/Home)<sup>1</sup>, [Firefox](https://www.mozilla.org/en-US/firefox/new/) and [WebKit](https://webkit.org/) with a single API. Playwright is built to enable cross-browser web automation that is **ever-green**, **capable**, **reliable**, and **fast**.

|          | Linux | macOS | Windows |
|   :---   | :---: | :---: | :---:   |
| Chromium<sup>1</sup> <!-- GEN:chromium-version -->146.0.7680.31<!-- GEN:stop --> | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| WebKit <!-- GEN:webkit-version -->26.0<!-- GEN:stop --> | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Firefox <!-- GEN:firefox-version -->148.0.2<!-- GEN:stop --> | :white_check_mark: | :white_check_mark: | :white_check_mark: |

Headless execution is supported for all browsers on all platforms. Check out [system requirements](https://playwright.dev/docs/intro#system-requirements) for details.

Looking for Playwright for [Python](https://playwright.dev/python/docs/intro), [.NET](https://playwright.dev/dotnet/docs/intro), or [Java](https://playwright.dev/java/docs/intro)?

<sup>1</sup> Playwright uses [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) by default.

## Installation

Playwright has its own test runner for end-to-end tests, we call it Playwright Test.

### Using init command

The easiest way to get started with Playwright Test is to run the init command.

```Shell
# Run from your project's root directory
npm init playwright@latest
# Or create a new project
npm init playwright@latest new-project
```

This will create a configuration file, optionally add examples, a GitHub Action workflow and a first test example.spec.ts. You can now jump directly to writing assertions section.

### Manually

Add dependency and install browsers.

```Shell
npm i -D @playwright/test
# install supported browsers
npx playwright install
```

You can optionally install only selected browsers, see [install browsers](https://playwright.dev/docs/cli#install-browsers) for more details. Or you can install no browsers at all and use existing [browser channels](https://playwright.dev/docs/browsers).

* [Getting started](https://playwright.dev/docs/intro)
* [API reference](https://playwright.dev/docs/api/class-playwright)

## Capabilities

### Resilient • No flaky tests

**Auto-wait**. Playwright waits for elements to be actionable prior to performing actions. It also has a rich set of introspection events. The combination of the two eliminates the need for artificial timeouts - a primary cause of flaky tests.

**Web-first assertions**. Playwright assertions are created specifically for the dynamic web. Checks are automatically retried until the necessary conditions are met.

**Tracing**. Configure test retry strategy, capture execution trace, videos and screenshots to eliminate flakes.

### No trade-offs • No limits

Browsers run web content belonging to different origins in different processes. Playwright is aligned with the architecture of the modern browsers and runs tests out-of-process. This makes Playwright free of the typical in-process test runner limitations.

**Multiple everything**. Test scenarios that span multiple tabs, multiple origins and multiple users. Create scenarios with different contexts for different users and run them against your server, all in one test.

**Trusted events**. Hover elements, interact with dynamic controls and produce trusted events. Playwright uses real browser input pipeline indistinguishable from the real user.

Test frames, pierce Shadow DOM. Playwright selectors pierce shadow DOM and allow entering frames seamlessly.

### Full isolation • Fast execution

**Browser contexts**. Playwright creates a browser context for each test. Browser context is equivalent to a brand new browser profile. This delivers full test isolation with zero overhead. Creating a new browser context only takes a handful of milliseconds.

**Log in once**. Save the authentication state of the context and reuse it in all the tests. This bypasses repetitive log-in operations in each test, yet delivers full isolation of independent tests.

### Powerful Tooling

**[Codegen](https://playwright.dev/docs/codegen)**. Generate tests by recording your actions. Save them into any language.

**[Playwright inspector](https://playwright.dev/docs/inspector)**. Inspect page, generate selectors, step through the test execution, see click points and explore execution logs.

**[Trace Viewer](https://playwright.dev/docs/trace-viewer)**. Capture all the information to investigate the test failure. Playwright trace contains test execution screencast, live DOM snapshots, action explorer, test source and many more.

Looking for Playwright for [TypeScript](https://playwright.dev/docs/intro), [JavaScript](https://playwright.dev/docs/intro), [Python](https://playwright.dev/python/docs/intro), [.NET](https://playwright.dev/dotnet/docs/intro), or [Java](https://playwright.dev/java/docs/intro)?

## Examples

To learn how to run these Playwright Test examples, check out our [getting started docs](https://playwright.dev/docs/intro).

#### Page screenshot

This code snippet navigates to Playwright homepage and saves a screenshot.

```TypeScript
import { test } from '@playwright/test';

test('Page Screenshot', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await page.screenshot({ path: `example.png` });
});
```

#### Mobile and geolocation

This snippet emulates Mobile Safari on a device at given geolocation, navigates to maps.google.com, performs the action and takes a screenshot.

```TypeScript
import { test, devices } from '@playwright/test';

test.use({
  ...devices['iPhone 13 Pro'],
  locale: 'en-US',
  geolocation: { longitude: 12.492507, latitude: 41.889938 },
  permissions: ['geolocation'],
})

test('Mobile and geolocation', async ({ page }) => {
  await page.goto('https://maps.google.com');
  await page.getByText('Your location').click();
  await page.waitForRequest(/.*preview\/pwa/);
  await page.screenshot({ path: 'colosseum-iphone.png' });
});
```

#### Evaluate in browser context

This code snippet navigates to example.com, and executes a script in the page context.

```TypeScript
import { test } from '@playwright/test';

test('Evaluate in browser context', async ({ page }) => {
  await page.goto('https://www.example.com/');
  const dimensions = await page.evaluate(() => {
    return {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
      deviceScaleFactor: window.devicePixelRatio
    }
  });
  console.log(dimensions);
});
```

#### Intercept network requests

This code snippet sets up request routing for a page to log all network requests.

```TypeScript
import { test } from '@playwright/test';

test('Intercept network requests', async ({ page }) => {
  // Log and continue all network requests
  await page.route('**', route => {
    console.log(route.request().url());
    route.continue();
  });
  await page.goto('http://todomvc.com');
});
```

## Resources

* [Documentation](https://playwright.dev)
* [API reference](https://playwright.dev/docs/api/class-playwright/)
* [Contribution guide](CONTRIBUTING.md)
* [Changelog](https://github.com/microsoft/playwright/releases)
