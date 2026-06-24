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

import fs from 'fs';
import path from 'path';

import { z } from '../../mcpBundle';
import { defineTool } from './tool';

const recorderGetSession = defineTool({
  capability: 'core',

  schema: {
    name: 'recorder_get_session',
    title: 'Get recorder session prompt',
    description: 'Read the Playwright recorder session prompt. Returns recorded actions, network events (classified as direct/pageLoad/noise), redacted payloads, and instructions for generating a Playwright test. Two sources feed this: (1) browser tools you drive through THIS MCP are recorded live into .playwright-session.md, with a runnable draft test written to tests/mcp-session.spec.ts; (2) a separate `playwright-codegen-pro codegen <url>` recording (.playwright-session.md live, or .playwright-prompt.md after "Generate Test"). Call this after driving the browser to turn the session into a polished test.',
    inputSchema: z.object({
      path: z.string().optional().describe(
          'Path to the prompt file. Defaults to checking .playwright-session.md (live) then .playwright-prompt.md in the current working directory.'
      ),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const cwd = context.options.cwd || process.cwd();
    if (params.path) {
      try {
        const content = await fs.promises.readFile(params.path, 'utf-8');
        response.addTextResult(content);
        return;
      } catch (err: any) {
        response.addTextResult(err.code === 'ENOENT'
          ? `File not found: ${params.path}`
          : `Failed to read: ${err.message}`);
        return;
      }
    }
    // Try live session file first, then exported prompt file
    for (const file of [path.join(cwd, '.playwright-session.md'), path.join(cwd, '.playwright-prompt.md')]) {
      try {
        const content = await fs.promises.readFile(file, 'utf-8');
        response.addTextResult(content);
        return;
      } catch {
        // try next
      }
    }
    response.addTextResult('No recorder session found. Run `npx playwright codegen --ai-codegen`, record actions, and the session will be available here automatically.');
  },
});

const recorderReset = defineTool({
  capability: 'core',

  schema: {
    name: 'recorder_reset',
    title: 'Start a new recording',
    description: 'Start a fresh recording, clearing the accumulated actions so the next flow becomes its own clean test. Call this between independent flows when testing or documenting a site back-to-back. With a `name`, the draft test is written to tests/<name>.spec.ts and the test is named accordingly (each flow gets its own file); without a name, it resets to the default tests/mcp-session.spec.ts. The previous flow\'s spec file is left in place.',
    inputSchema: z.object({
      name: z.string().optional().describe('Name for the new flow, e.g. "login" or "checkout". Becomes the test name and spec filename tests/<name>.spec.ts.'),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const recorder = context.mcpRecorder;
    if (!recorder) {
      response.addTextResult('Live recording is not active for this server.');
      return;
    }
    const specFile = recorder.reset(params.name);
    response.addTextResult(params.name
      ? `Started new recording "${params.name}". Subsequent actions are recorded into ${specFile} (and .playwright-session.md).`
      : `Recording reset. Subsequent actions are recorded into ${specFile} (and .playwright-session.md).`);
  },
});

export default [recorderGetSession, recorderReset];
