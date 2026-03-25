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
    description: 'Read the Playwright recorder session prompt. Returns recorded actions, network events, and instructions for generating a Playwright test. Available live during recording (via .playwright-session.md) or after clicking "Generate Test" (via .playwright-prompt.md). Requires `npx playwright codegen --ai-codegen`.',
    inputSchema: z.object({
      path: z.string().optional().describe(
          'Path to the prompt file. Defaults to checking .playwright-session.md (live) then .playwright-prompt.md in the current working directory.'
      ),
    }),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const cwd = context.options.cwd;
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

export default [recorderGetSession];
