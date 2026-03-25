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
 * Pure prompt-building module — no Chat/transport/bundle dependencies.
 * Extracted so unit tests can import this without requiring the built bundle.
 */

import path from 'path';

import type { ActionInContext } from '@recorder/actions';
import type { RedactedSession } from './sessionRedactor';

export interface ExportOptions {
  scenarioName: string;
  outputFile: string;
  wsEndpoint?: string;
  pageHasWebSockets: boolean;
  mode?: 'ai-endpoint' | 'clipboard';
}

export interface ExportResult {
  code: string;
  warnings: string[];
}

export function buildPrompt(session: RedactedSession, options: ExportOptions): string {
  const { actions, dataCreatingActions, hasWebSockets } = session;

  // Group actions by page URL segments, skipping about:blank
  const segments: Array<{ url: string; actions: ActionInContext[] }> = [];
  for (const action of actions) {
    const a = action.action;
    const url = (a.name === 'navigate' || a.name === 'openPage') ? (a as any).url : undefined;
    // Skip about:blank openPage — it's the initial blank tab, not a real navigation
    if (a.name === 'openPage' && (a as any).url === 'about:blank')
      continue;
    if (url || !segments.length)
      segments.push({ url: url ?? '', actions: [action] });
    else
      segments[segments.length - 1].actions.push(action);
  }

  const relativeOutput = path.relative(process.cwd(), options.outputFile);

  let sessionSection = '';
  for (const seg of segments) {
    if (seg.url)
      sessionSection += `### Page: ${seg.url}\n`;
    for (const ctx of seg.actions) {
      const a = ctx.action;
      const location = (a as any).selector ? `${(a as any).selector}` : (a as any).url ?? '';
      sessionSection += `- ${a.name}: ${location} at t=${ctx.startTime}ms\n`;
      const direct = (ctx.networkEvents ?? []).filter(e => e.bucket === 'direct');
      const pageLoad = (ctx.networkEvents ?? []).filter(e => e.bucket === 'pageLoad');
      if (direct.length) {
        sessionSection += `  API calls (direct):\n`;
        for (const e of direct) {
          const op = e.operationName ? ` (${e.operationName})` : '';
          const body = e.bodySnippet ? ` (body: ${e.bodySnippet.slice(0, 200)}...)` : '';
          sessionSection += `    - ${e.method} ${e.url}${op} → ${e.status ?? 'pending'}${body}\n`;
        }
      }
      if (pageLoad.length) {
        sessionSection += `  API calls (page load context):\n`;
        for (const e of pageLoad)
          sessionSection += `    - ${e.method} ${e.url} → ${e.status ?? 'pending'}\n`;
      }
    }
  }

  let cleanupSection = '';
  if (dataCreatingActions.length) {
    cleanupSection = '## Data Created During Session\n';
    for (const idx of dataCreatingActions) {
      const ctx = actions[idx];
      const creates = (ctx.networkEvents ?? []).filter(e => e.bucket === 'direct' && e.method === 'POST' && e.status === 201);
      for (const e of creates)
        cleanupSection += `- Step ${idx + 1} (${ctx.action.name}): POST ${e.url} → 201 Created. Add afterEach cleanup using the response ID.\n`;
    }
  } else {
    cleanupSection = '## Data Created During Session\nNo data was created. No cleanup needed.\n';
  }

  const wsSection = hasWebSockets
    ? '## WebSocket Note\nThis page uses WebSocket connections. Assert on UI state changes that reflect server pushes rather than trying to intercept WS frames.\n\n'
    : '';

  return `# Playwright Test Generation Request

## Scenario
Name: ${options.scenarioName}
Target file: ${relativeOutput}

## Recorded Session
${sessionSection.trimEnd()}

${cleanupSection}
${wsSection}## Best Practices (follow exactly)
- Do NOT use page.waitForTimeout(), page.waitForLoadState(), page.waitForNavigation()
- DO use await expect(locator).toBeVisible() and similar waiting assertions
- Prefer getByRole, getByLabel, getByPlaceholder, getByTestId over CSS selectors
- Add a meaningful assertion BEFORE and AFTER each significant action
- For actions with 'direct' API calls, wrap the click in Promise.all with waitForResponse
- Never assert on auto-generated IDs, UUIDs, or timestamps from response bodies
- Use process.env.TEST_* variables for any credentials (already done by redaction)
- For data-creating actions (201), add afterEach cleanup using the response ID
- Use randomised test data (append Date.now()) to avoid collision on re-runs
- Structure as test.describe with one clear test per scenario

## Output Format
${options.mode === 'clipboard' ? `Generate a complete Playwright test file in TypeScript.
The file should start with: import { test, expect } from '@playwright/test';
Save the result to: ${relativeOutput}` : `Return the TypeScript code as a raw JSON string. Your entire response must be valid JSON parseable by JSON.parse().
Example: "import { test, expect } from '@playwright/test';\\n\\ntest.describe(..."
Do not include any explanation, markdown fences, or wrapper objects.
The code must start with: import { test, expect } from '@playwright/test';`}`;
}
