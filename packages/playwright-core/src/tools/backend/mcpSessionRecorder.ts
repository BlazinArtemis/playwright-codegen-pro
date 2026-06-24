/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Records a live MCP browser session as the agent drives the browser, and
 * writes two artifacts (throttled) after every tool call:
 *   - .playwright-session.md  — the structured prompt (read by recorder_get_session)
 *   - <outputDir>/tests/<scenario>.spec.ts — a runnable draft test
 *
 * Recording is always-on; the agent fires MCP tools and a test falls out.
 */

import fs from 'fs';
import path from 'path';

import { McpNetworkCapture } from './mcpNetworkCapture';

import type { CurrentActionRef, McpNetworkEvent } from './mcpNetworkCapture';
import type * as playwright from '../../..';

export type McpRecorderOptions = {
  cwd: string;
  scenarioName: string;
  specFile: string;
  secrets?: Record<string, string>;
};

type McpAction = {
  index: number;
  toolName: string;
  code: string;
  pageUrl?: string;
  pageTitle?: string;
  startTime: number;
  networkEvents: McpNetworkEvent[];
};

const WRITE_THROTTLE_MS = 250;
const MAX_DIRECT = 20;
const MAX_PAGELOAD = 8;
const MAX_URL_LEN = 140;

function truncUrl(url: string): string {
  return url.length > MAX_URL_LEN ? url.slice(0, MAX_URL_LEN) + '…' : url;
}

/** Turn a human flow name into a safe spec filename stem, e.g. "Login Flow" → "login-flow". */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'mcp-session';
}

export class McpSessionRecorder {
  private _options: McpRecorderOptions;
  private _network: McpNetworkCapture;
  private _actions: McpAction[] = [];
  private _current: CurrentActionRef | null = null;
  private _sessionStart = Date.now();
  private _sessionFile: string;
  private _writeTimer: NodeJS.Timeout | undefined;
  private _disposed = false;
  private readonly _defaultScenario: string;
  private readonly _defaultSpecFile: string;

  constructor(context: playwright.BrowserContext, options: McpRecorderOptions) {
    this._options = options;
    this._defaultScenario = options.scenarioName;
    this._defaultSpecFile = options.specFile;
    this._sessionFile = path.join(options.cwd, '.playwright-session.md');
    this._network = new McpNetworkCapture(context, () => this._current, () => this._scheduleWrite());
    this._network.start();
  }

  /**
   * Begin a fresh recording. Clears accumulated actions so the next flow becomes its own
   * test. With a name, the draft is written to tests/<slug>.spec.ts (so back-to-back flows
   * each get their own file); without a name, resets to the default mcp-session.spec.ts.
   * Returns the relative path of the spec the new flow will be written to.
   */
  reset(name?: string): string {
    this._actions = [];
    this._current = null;
    this._sessionStart = Date.now();
    if (name) {
      this._options.scenarioName = name;
      this._options.specFile = path.join(this._options.cwd, 'tests', `${slugify(name)}.spec.ts`);
    } else {
      this._options.scenarioName = this._defaultScenario;
      this._options.specFile = this._defaultSpecFile;
    }
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = undefined;
    }
    this._writeFiles();
    return path.relative(this._options.cwd, this._options.specFile);
  }

  /** Called before a tool runs, so network events attribute to it. */
  beginAction(toolName: string): void {
    this._current = { toolName, startTime: Date.now(), events: [] };
  }

  /** Called after a tool runs with the Playwright code it executed (if any). */
  completeAction(code: string | undefined, pageUrl?: string, pageTitle?: string): void {
    const current = this._current;
    if (!current)
      return;
    const trimmed = (code ?? '').trim();
    if (trimmed) {
      this._actions.push({
        index: this._actions.length,
        toolName: current.toolName,
        code: trimmed,
        pageUrl,
        pageTitle,
        startTime: current.startTime,
        // Same array reference the network capture pushes into — late responses still land here.
        networkEvents: current.events,
      });
    } else if (current.events.length && this._actions.length) {
      // Observation-only tool (snapshot/wait) — fold its network into the previous action.
      this._actions[this._actions.length - 1].networkEvents.push(...current.events);
    }
    this._scheduleWrite();
  }

  async dispose(): Promise<void> {
    if (this._disposed)
      return;
    this._disposed = true;
    this._network.dispose();
    if (this._writeTimer)
      clearTimeout(this._writeTimer);
    this._writeFiles();
  }

  // ─── Writing ─────────────────────────────────────────────────────────────

  private _scheduleWrite(): void {
    if (this._disposed || this._writeTimer)
      return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = undefined;
      this._writeFiles();
    }, WRITE_THROTTLE_MS);
  }

  private _writeFiles(): void {
    try {
      fs.writeFileSync(this._sessionFile, this._redact(this._buildPrompt()), 'utf-8');
      const spec = this._redact(this._buildSpec());
      fs.mkdirSync(path.dirname(this._options.specFile), { recursive: true });
      fs.writeFileSync(this._options.specFile, spec, 'utf-8');
    } catch {
      // Best-effort live write; ignore transient FS errors.
    }
  }

  private _redact(text: string): string {
    let out = text;
    for (const value of Object.values(this._options.secrets ?? {})) {
      if (value)
        out = out.split(value).join('[redacted]');
    }
    // Redact obvious secrets in captured bodies: password/token/secret/authorization values and bearer tokens.
    out = out.replace(/("(?:password|token|secret|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2');
    out = out.replace(/\bBearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]');
    return out;
  }

  // ─── Prompt (.playwright-session.md) ─────────────────────────────────────

  private _buildPrompt(): string {
    const relSpec = path.relative(this._options.cwd, this._options.specFile);
    let session = '';
    let lastPageUrl: string | undefined;
    for (const action of this._actions) {
      if (action.pageUrl && action.pageUrl !== lastPageUrl) {
        session += `### Page: ${action.pageUrl}\n`;
        lastPageUrl = action.pageUrl;
      }
      const codeLine = action.code.split('\n')[0];
      session += `- ${action.toolName}: ${codeLine} at t=${action.startTime - this._sessionStart}ms\n`;
      const direct = action.networkEvents.filter(e => e.bucket === 'direct');
      const pageLoad = action.networkEvents.filter(e => e.bucket === 'pageLoad');
      if (direct.length) {
        session += `  API calls (direct):\n`;
        for (const e of direct.slice(0, MAX_DIRECT)) {
          const op = e.operationName ? ` (${e.operationName})` : '';
          const payload = e.requestBodySnippet ? ` (payload: ${e.requestBodySnippet})` : '';
          const body = e.bodySnippet ? ` (body: ${e.bodySnippet})` : '';
          session += `    - ${e.method} ${truncUrl(e.url)}${op}${payload} → ${e.status ?? (e.aborted ? 'aborted' : 'pending')}${body}\n`;
        }
        if (direct.length > MAX_DIRECT)
          session += `    - ...and ${direct.length - MAX_DIRECT} more\n`;
      }
      if (pageLoad.length) {
        session += `  API calls (page load context):\n`;
        for (const e of pageLoad.slice(0, MAX_PAGELOAD))
          session += `    - ${e.method} ${truncUrl(e.url)} → ${e.status ?? 'pending'}\n`;
        if (pageLoad.length > MAX_PAGELOAD)
          session += `    - ...and ${pageLoad.length - MAX_PAGELOAD} more\n`;
      }
    }

    const creates = this._actions.flatMap(a =>
      a.networkEvents.filter(e => e.bucket === 'direct' && e.method === 'POST' && e.status === 201).map(e => ({ a, e })));
    let cleanup = '## Data Created During Session\n';
    if (creates.length) {
      for (const { a, e } of creates)
        cleanup += `- Step ${a.index + 1} (${a.toolName}): POST ${e.url} → 201 Created. Add afterEach cleanup using the response ID.\n`;
    } else {
      cleanup += 'No data was created. No cleanup needed.\n';
    }

    return `# Playwright Test Generation Request (live MCP session)

## Scenario
Name: ${this._options.scenarioName}
Target file: ${relSpec}

This session was recorded live while an AI agent drove the browser through the Playwright Codegen Pro MCP. A runnable draft test has already been written to the target file; use this context to produce a polished final test.

## Recorded Session
${session.trimEnd() || '(no actions recorded yet)'}

${cleanup}
## Best Practices (follow exactly)
- Do NOT use page.waitForTimeout(), page.waitForLoadState(), page.waitForNavigation()
- DO use await expect(locator).toBeVisible() and similar web-first assertions
- Prefer getByRole, getByLabel, getByPlaceholder, getByTestId over CSS selectors
- Add a meaningful assertion BEFORE and AFTER each significant action
- For actions with 'direct' API calls, wrap the click in Promise.all with waitForResponse
- Never assert on auto-generated IDs, UUIDs, or timestamps from response bodies
- Use process.env.TEST_* variables for any credentials (secrets are already redacted)
- For data-creating actions (201), add afterEach cleanup using the response ID
- Structure as test.describe with one clear test per scenario

## Output Format
Generate a complete Playwright test file in TypeScript.
The file should start with: import { test, expect } from '@playwright/test';
Save the result to: ${relSpec}`;
  }

  // ─── Draft spec (<scenario>.spec.ts) ─────────────────────────────────────

  private _buildSpec(): string {
    const body = this._actions.map(a => a.code.split('\n').map(l => `    ${l}`).join('\n')).join('\n');
    return `import { test, expect } from '@playwright/test';

// Draft test recorded live via the Playwright Codegen Pro MCP.
// Review and add assertions — see .playwright-session.md for captured API calls.
test('${this._options.scenarioName.replace(/'/g, "\\'")}', async ({ page }) => {
${body || '    // No actions recorded yet.'}
});
`;
  }
}
