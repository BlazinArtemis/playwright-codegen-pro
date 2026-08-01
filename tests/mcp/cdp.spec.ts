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

import { spawnSync } from 'child_process';
import { chromium } from 'playwright';

import { test, expect, mcpServerPath } from './fixtures';

test.describe.configure({
  retries: 1,
});

test('cdp server', async ({ cdpServer, startClient, server }) => {
  await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });
});

test('cdp server reuse tab', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  const [page] = browserContext.pages();
  await page.goto(server.HELLO_WORLD);

  expect(await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Hello, world!',
      ref: 'f0',
    },
  })).toHaveResponse({
    error: `Error: Ref f0 not found in the current page snapshot. Try capturing new snapshot.`,
    isError: true,
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    page: `- Page URL: ${server.HELLO_WORLD}
- Page Title: Title`,
    inlineSnapshot: `- generic [active] [ref=e1]: Hello, world!`,
  });
});

test('should throw connection error and allow re-connecting', async ({ cdpServer, startClient, server }) => {
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  server.setContent('/', `
    <title>Title</title>
    <body>Hello, world!</body>
  `, 'text/html');

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    error: expect.stringContaining(`Error: connect ECONNREFUSED`),
    isError: true,
  });
  await cdpServer.start();
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });
});

test('should recover when the browser is closed out-of-band', async ({ cdpServer, startClient, server, mcpBrowser }, testInfo) => {
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });

  // The user closes the browser (or it crashes) behind the MCP's back.
  await browserContext.close();

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    error: expect.stringContaining(`The browser is no longer running`),
    isError: true,
  });

  // The dead browser must not poison the session: the next call reconnects.
  const port = Number(new URL(cdpServer.endpoint).port);
  const secondContext = await chromium.launchPersistentContext(testInfo.outputPath('cdp-user-data-dir-2'), {
    channel: mcpBrowser,
    headless: true,
    args: [`--remote-debugging-port=${port}`],
  });
  try {
    expect(await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    })).toHaveResponse({
      snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
    });

    // The recording is not restarted by the relaunch — both navigations are in one test.
    const session = await client.callTool({ name: 'recorder_get_session' });
    const text = (session.content as { text: string }[])[0].text;
    expect(text.match(/browser_navigate/g)).toHaveLength(2);
  } finally {
    await secondContext.close();
  }
});

test('does not support --device', async () => {
  const result = spawnSync('node', [
    ...mcpServerPath, '--device=Pixel 5', '--cdp-endpoint=http://localhost:1234',
  ]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain('Device emulation is not supported with cdpEndpoint.');
});

test('cdp server with headers', async ({ startClient, server }) => {
  let authHeader = '';
  server.setRoute('/json/version/', (req, res) => {
    authHeader = req.headers['authorization'];
    res.end();
  });

  const { client } = await startClient({ args: [`--cdp-endpoint=${server.PREFIX}`, '--cdp-header', 'Authorization: Bearer 1234567890'] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    isError: true,
  });
  expect(authHeader).toBe('Bearer 1234567890');
});

test('cdp server with empty and complex headers', async ({ startClient, server }) => {
  let customHeader = '';
  let emptyHeader = '';
  server.setRoute('/json/version/', (req, res) => {
    customHeader = req.headers['x-forwarded-proto'] as string;
    emptyHeader = req.headers['x-empty'] as string;
    res.end();
  });

  const { client } = await startClient({
    args: [
      `--cdp-endpoint=${server.PREFIX}`,
      '--cdp-header', 'X-Forwarded-Proto: value:with:colons',
      '--cdp-header', 'X-Empty'
    ]
  });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    isError: true,
  });
  expect(customHeader).toBe('value:with:colons');
  expect(emptyHeader).toBe('');
});
