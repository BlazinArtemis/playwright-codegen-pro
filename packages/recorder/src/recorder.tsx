/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import type { CallLog, GenerationStatusEvent, Mode, NetworkPanelEntry, Source } from './recorderTypes';
import { CodeMirrorWrapper } from '@web/components/codeMirrorWrapper';
import type { SourceHighlight } from '@web/components/codeMirrorWrapper';
import { SplitView } from '@web/components/splitView';
import { TabbedPane } from '@web/components/tabbedPane';
import { Toolbar } from '@web/components/toolbar';
import { emptySource, SourceChooser } from '@web/components/sourceChooser';
import { ToolbarButton, ToolbarSeparator } from '@web/components/toolbarButton';
import * as React from 'react';
import { CallLogView } from './callLog';
import './recorder.css';
import { asLocator } from '@isomorphic/locatorGenerators';
import { kThemeOptions, type Theme, useThemeSetting } from '@web/theme';
import { copy, useSetting } from '@web/uiUtils';
import yaml from 'yaml';
import { parseAriaSnapshot } from '@isomorphic/ariaSnapshot';
import { Dialog } from '@web/shared/dialog';

import type { RecorderBackend, RecorderFrontend } from './recorderTypes';

export const Recorder: React.FC = ({}) => {
  const [sources, setSources] = React.useState<Source[]>([]);
  const [paused, setPaused] = React.useState(false);
  const [log, setLog] = React.useState(new Map<string, CallLog>());
  const [mode, setMode] = React.useState<Mode>('none');
  const [selectedFileId, setSelectedFileId] = React.useState<string | undefined>();
  const [selectedTab, setSelectedTab] = useSetting<string>('recorderPropertiesTab', 'log');
  const [ariaSnapshot, setAriaSnapshot] = React.useState<string | undefined>();
  const [ariaSnapshotErrors, setAriaSnapshotErrors] = React.useState<SourceHighlight[]>();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [theme, setTheme] = useThemeSetting();
  const [autoExpect, setAutoExpect] = useSetting<boolean>('autoExpect', false);
  const settingsButtonRef = React.useRef<HTMLButtonElement>(null);
  const backend = React.useMemo(createRecorderBackend, []);
  const [locator, setLocator] = React.useState('');
  const [scenarioName, setScenarioName] = React.useState('my scenario');
  const [generationStatus, setGenerationStatus] = React.useState<GenerationStatusEvent | null>(null);
  const [networkEntries, setNetworkEntries] = React.useState<NetworkPanelEntry[]>([]);
  const [lastPrompt, setLastPrompt] = React.useState<string | null>(null);
  const [aiCodegen, setAiCodegen] = React.useState(false);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  const source = React.useMemo(() => {
    const source = sources.find(s => s.id === selectedFileId);
    return source ?? emptySource();
  }, [sources, selectedFileId]);

  React.useLayoutEffect(() => {
    const dispatcher: RecorderFrontend = {
      modeChanged: ({ mode }) => setMode(mode),
      sourcesUpdated: ({ sources }) => {
        setSources(sources);
        window.playwrightSourcesEchoForTest = sources;
      },
      pageNavigated: ({ url }) => {
        document.title = url
          ? `Playwright Inspector - ${url}`
          : `Playwright Inspector`;
      },
      pauseStateChanged: ({ paused }) => setPaused(paused),
      callLogsUpdated: ({ callLogs }) => {
        setLog(log => {
          const newLog = new Map<string, CallLog>(log);
          for (const callLog of callLogs) {
            callLog.reveal = !log.has(callLog.id);
            newLog.set(callLog.id, callLog);
          }
          return newLog;
        });
      },
      sourceRevealRequested: ({ sourceId }) => setSelectedFileId(sourceId),
      elementPicked: ({ elementInfo, userGesture }) => {
        const language = source.language;
        setLocator(asLocator(language, elementInfo.selector));
        setAriaSnapshot(elementInfo.ariaSnapshot);
        setAriaSnapshotErrors([]);
        if (userGesture && selectedTab !== 'locator' && selectedTab !== 'aria')
          setSelectedTab('locator');

        if (mode === 'inspecting' && selectedTab === 'aria') {
          // Keep exploring aria.
        } else {
          backend.setMode({ mode: mode === 'inspecting' ? 'standby' : 'recording' }).catch(() => { });
        }
      },
      generationStatusChanged: (params: GenerationStatusEvent) => setGenerationStatus(params),
      networkEntriesUpdated: ({ entries }: { entries: NetworkPanelEntry[] }) => setNetworkEntries(entries),
      promptReady: ({ prompt, filePath }: { prompt: string; filePath: string }) => {
        setLastPrompt(prompt);
        if (navigator.clipboard?.writeText)
          navigator.clipboard.writeText(prompt).catch(() => copy(prompt));
        else
          copy(prompt);
      },
      configUpdated: ({ aiCodegen: enabled }: { aiCodegen: boolean }) => setAiCodegen(enabled),
    };
    window.dispatch = (data: { method: string; params?: any }) => {
      (dispatcher as any)[data.method].call(dispatcher, data.params);
    };
  }, [backend, mode, selectedTab, setSelectedTab, source]);

  React.useEffect(() => {
    backend.setAutoExpect({ autoExpect });
  }, [autoExpect, backend]);

  React.useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [messagesEndRef]);

  React.useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'F8':
          event.preventDefault();
          if (paused)
            backend.resume();
          else
            backend.pause();
          break;
        case 'F10':
          event.preventDefault();
          if (paused)
            backend.step();
          break;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [paused, backend]);

  const onEditorChange = React.useCallback((selector: string) => {
    if (mode === 'none' || mode === 'inspecting')
      backend.setMode({ mode: 'standby' });
    setLocator(selector);
    backend.highlightRequested({ selector });
  }, [mode, backend]);

  const onAriaEditorChange = React.useCallback((ariaSnapshot: string) => {
    if (mode === 'none' || mode === 'inspecting')
      backend.setMode({ mode: 'standby' });
    const { fragment, errors } = parseAriaSnapshot(yaml, ariaSnapshot, { prettyErrors: false });
    const highlights = errors.map(error => {
      const highlight: SourceHighlight = {
        message: error.message,
        line: error.range[1].line,
        column: error.range[1].col,
        type: 'subtle-error',
      };
      return highlight;
    });
    setAriaSnapshotErrors(highlights);
    setAriaSnapshot(ariaSnapshot);
    if (!errors.length)
      backend.highlightRequested({ ariaTemplate: fragment });
  }, [mode, backend]);

  const isRecording = mode === 'recording' || mode === 'recording-inspecting' || mode === 'assertingText' || mode === 'assertingVisibility';
  const isGenerating = generationStatus !== null && generationStatus.status !== 'done' && generationStatus.status !== 'error' && generationStatus.status !== 'idle' && generationStatus.status !== 'exported';

  const recordingToolbar = <Toolbar>
    <ToolbarButton icon={isRecording ? 'stop-circle' : 'circle-large-filled'} title={isRecording ? 'Stop Recording' : 'Start Recording'} toggled={isRecording} onClick={() => {
      backend.setMode({ mode: mode === 'none' || mode === 'standby' || mode === 'inspecting' ? 'recording' : 'standby' });
    }}>Record</ToolbarButton>
    <ToolbarSeparator />
    <ToolbarButton icon='inspect' title='Pick locator' toggled={mode === 'inspecting' || mode === 'recording-inspecting'} onClick={() => {
      const newMode: Mode = {
        'inspecting': 'standby',
        'none': 'inspecting',
        'standby': 'inspecting',
        'recording': 'recording-inspecting',
        'recording-inspecting': 'recording',
        'assertingText': 'recording-inspecting',
        'assertingVisibility': 'recording-inspecting',
        'assertingValue': 'recording-inspecting',
        'assertingSnapshot': 'recording-inspecting',
        'generating': 'standby',
      }[mode] as Mode;
      backend.setMode({ mode: newMode }).catch(() => { });
    }}></ToolbarButton>
    <ToolbarButton icon='eye' title='Assert visibility' toggled={mode === 'assertingVisibility'} disabled={mode === 'none' || mode === 'standby' || mode === 'inspecting'} onClick={() => {
      backend.setMode({ mode: mode === 'assertingVisibility' ? 'recording' : 'assertingVisibility' });
    }}></ToolbarButton>
    <ToolbarButton icon='whole-word' title='Assert text' toggled={mode === 'assertingText'} disabled={mode === 'none' || mode === 'standby' || mode === 'inspecting'} onClick={() => {
      backend.setMode({ mode: mode === 'assertingText' ? 'recording' : 'assertingText' });
    }}></ToolbarButton>
    <ToolbarButton icon='symbol-constant' title='Assert value' toggled={mode === 'assertingValue'} disabled={mode === 'none' || mode === 'standby' || mode === 'inspecting'} onClick={() => {
      backend.setMode({ mode: mode === 'assertingValue' ? 'recording' : 'assertingValue' });
    }}></ToolbarButton>
    <ToolbarButton icon='gist' title='Assert snapshot' toggled={mode === 'assertingSnapshot'} disabled={mode === 'none' || mode === 'standby' || mode === 'inspecting'} onClick={() => {
      backend.setMode({ mode: mode === 'assertingSnapshot' ? 'recording' : 'assertingSnapshot' });
    }}></ToolbarButton>
    <ToolbarSeparator />
    <ToolbarButton icon='files' title='Copy' disabled={!source || !source.text} onClick={() => {
      copy(source.text);
    }}></ToolbarButton>
    <ToolbarButton icon='debug-continue' title='Resume (F8)' ariaLabel='Resume' disabled={!paused} onClick={() => {
      backend.resume();
    }}></ToolbarButton>
    <ToolbarButton icon='debug-pause' title='Pause (F8)' ariaLabel='Pause' disabled={paused} onClick={() => {
      backend.pause();
    }}></ToolbarButton>
    <ToolbarButton icon='debug-step-over' title='Step over (F10)' ariaLabel='Step over' disabled={!paused} onClick={() => {
      backend.step();
    }}></ToolbarButton>
    <div style={{ flex: 'auto' }}></div>
    <div>Target:</div>
    <SourceChooser fileId={source.id} sources={sources} setFileId={fileId => {
      setSelectedFileId(fileId);
      backend.fileChanged({ fileId });
    }} />
    <ToolbarButton icon='clear-all' title='Clear' disabled={!source || !source.text} onClick={() => {
      backend.clear();
    }}></ToolbarButton>
    {aiCodegen && <ToolbarSeparator />}
    {aiCodegen && <ToolbarButton icon='add' title='New scenario' onClick={() => {
      backend.clear();
      const name = 'scenario-' + Date.now();
      setScenarioName(name);
      setGenerationStatus(null);
      setNetworkEntries([]);
    }}>New</ToolbarButton>}
    {aiCodegen && <ToolbarButton icon='sparkle' title='Generate Test' disabled={!source || !source.text} onClick={() => {
      const outputFile = 'tests/' + scenarioName.replace(/\s+/g, '-') + '.spec.ts';
      backend.generateTest({ scenarioName, outputFile }).catch(() => {});
    }}>Generate</ToolbarButton>}
    <ToolbarButton
      ref={settingsButtonRef}
      icon='settings-gear'
      title='Settings'
      onClick={() => setSettingsOpen(current => !current)}
    />
    <Dialog
      style={{ padding: '4px 8px' }}
      open={settingsOpen}
      verticalOffset={8}
      requestClose={() => setSettingsOpen(false)}
      anchor={settingsButtonRef}
      dataTestId='settings-dialog'
    >
      <div key='dark-mode-setting' className='setting setting-theme'>
        <label htmlFor='dark-mode-setting'>Theme:</label>
        <select id='dark-mode-setting' value={theme} onChange={e => setTheme(e.target.value as Theme)}>
          {kThemeOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <div key='auto-expect-setting' className='setting' title='Automatically generate assertions while recording'>
        <input type='checkbox' id='auto-expect-setting' checked={autoExpect} onChange={() => {
          backend.setAutoExpect({ autoExpect: !autoExpect });
          setAutoExpect(!autoExpect);
        }} />
        <label htmlFor='auto-expect-setting'>Generate assertions</label>
      </div>
    </Dialog>
  </Toolbar>;

  const generationBar = generationStatus && <Toolbar>
    {isGenerating && <div className='generation-bar'>
      <div className={`generation-dot status-${generationStatus.status}`} />
      <span className='generation-message'>{generationStatus.message}</span>
      <progress className='generation-progress' value={generationStatus.progress} max={100} />
    </div>}
    {generationStatus.status === 'done' && <div className='generation-bar'>
      <div className='generation-dot status-done' />
      <span className='generation-message'>✓ Test passed — {generationStatus.outputFile}</span>
      <div className='generation-actions'>
        <ToolbarButton icon='discard' title='Record another' onClick={() => {
          backend.clear();
          setGenerationStatus(null);
          setNetworkEntries([]);
        }}>Record another</ToolbarButton>
      </div>
    </div>}
    {generationStatus.status === 'error' && <div className='generation-bar'>
      <div className='generation-dot status-error' />
      <span className='generation-message'>✗ {generationStatus.message.slice(0, 120)}</span>
      <div className='generation-actions'>
        <ToolbarButton icon='refresh' title='Try again' onClick={() => {
          const outputFile = 'tests/' + scenarioName.replace(/\s+/g, '-') + '.spec.ts';
          backend.generateTest({ scenarioName, outputFile }).catch(() => {});
        }}>Try again</ToolbarButton>
        <ToolbarButton icon='discard' title='Record another' onClick={() => {
          backend.clear();
          setGenerationStatus(null);
          setNetworkEntries([]);
        }}>New</ToolbarButton>
      </div>
    </div>}
    {generationStatus.status === 'exported' && <div className='generation-bar'>
      <div className='generation-dot status-exported' />
      <span className='generation-message'>Prompt copied to clipboard and saved to .playwright-prompt.md</span>
      <div className='generation-actions'>
        <ToolbarButton icon='files' title='Copy again' onClick={() => {
          if (lastPrompt) {
            if (navigator.clipboard?.writeText)
              navigator.clipboard.writeText(lastPrompt).catch(() => copy(lastPrompt!));
            else
              copy(lastPrompt);
          }
        }}>Copy again</ToolbarButton>
        <ToolbarButton icon='discard' title='New scenario' onClick={() => {
          backend.clear();
          setGenerationStatus(null);
          setNetworkEntries([]);
          setLastPrompt(null);
        }}>New</ToolbarButton>
      </div>
    </div>}
  </Toolbar>;

  return <div className='recorder'>
    {aiCodegen && isGenerating ? generationBar : aiCodegen && (generationStatus?.status === 'done' || generationStatus?.status === 'error' || generationStatus?.status === 'exported') ? generationBar : recordingToolbar}
    <div className='recorder-body'>
      {aiCodegen && <div className='steps-panel-col'>
        <StepsPanel source={source} networkEntries={networkEntries} />
        <div className='scenario-name-area'>
          <label htmlFor='scenario-name-input'>Scenario name</label>
          <input
            id='scenario-name-input'
            type='text'
            value={scenarioName}
            onChange={e => {
              setScenarioName(e.target.value);
              backend.setScenarioName({ name: e.target.value }).catch(() => {});
            }}
            placeholder='my scenario'
          />
        </div>
      </div>}
      <SplitView
        sidebarSize={200}
        main={<CodeMirrorWrapper text={source.text} highlighter={source.language} highlight={source.highlight} revealLine={source.revealLine} readOnly={true} lineNumbers={true} />}
        sidebar={<TabbedPane
          rightToolbar={selectedTab === 'locator' || selectedTab === 'aria' ? [<ToolbarButton key={1} icon='files' title='Copy' onClick={() => copy((selectedTab === 'locator' ? locator : ariaSnapshot) || '')} />] : []}
          tabs={[
            {
              id: 'locator',
              title: 'Locator',
              render: () => <CodeMirrorWrapper text={locator} placeholder='Type locator to inspect' highlighter={source.language} focusOnChange={true} onChange={onEditorChange} wrapLines={true} />
            },
            {
              id: 'log',
              title: 'Log',
              render: () => <CallLogView language={source.language} log={Array.from(log.values())} />
            },
            {
              id: 'aria',
              title: 'Aria',
              render: () => <CodeMirrorWrapper text={ariaSnapshot || ''} placeholder='Type aria template to match' highlighter={'yaml'} onChange={onAriaEditorChange} highlight={ariaSnapshotErrors} wrapLines={true} />
            },
          ]}
          selectedTab={selectedTab}
          setSelectedTab={setSelectedTab}
        />}
      />
    </div>
    {aiCodegen && networkEntries.length > 0 && <NetworkPanel entries={networkEntries} />}
  </div>;
};

// ── StepsPanel ──────────────────────────────────────────────────────────────

const StepsPanel: React.FC<{ source: Source; networkEntries: NetworkPanelEntry[] }> = ({ source, networkEntries }) => {
  const steps = source.actions ?? [];
  return <div className='steps-panel-inner'>
    {steps.map((stepText, i) => {
      const direct = networkEntries.filter(e => e.linkedStepIndex === i && e.bucket === 'direct');
      return <div key={i} className='step-item'>
        <span className='step-text'>{stepText}</span>
        {direct.length > 0 && (
          <div className='step-network-badges'>
            {direct.map((e, j) => {
              let pathname = e.url;
              try { pathname = new URL(e.url).pathname; } catch { /* keep url */ }
              const statusClass = e.status ? `net-status-${Math.floor(e.status / 100)}xx` : '';
              return <React.Fragment key={j}>
                <span className={`net-badge net-method-${e.method.toLowerCase()}`}>{e.method}</span>
                {e.status && <span className={`net-badge net-status ${statusClass}`}>{e.status}</span>}
                <span className='net-url-hint'>{e.operationName ?? pathname}</span>
              </React.Fragment>;
            })}
          </div>
        )}
      </div>;
    })}
    {steps.length === 0 && <div className='steps-empty'>No steps recorded yet.</div>}
  </div>;
};

// ── NetworkPanel ────────────────────────────────────────────────────────────

const NetworkPanel: React.FC<{ entries: NetworkPanelEntry[] }> = ({ entries }) => {
  const nonNoise = entries.filter(e => e.bucket !== 'noise');
  const direct = entries.filter(e => e.bucket === 'direct');
  return <div className='network-panel'>
    <div className='network-panel-header'>
      Network · {nonNoise.length} requests · {direct.length} linked
    </div>
    {entries.map((e, i) => {
      let pathname = e.url;
      try { pathname = new URL(e.url).pathname; } catch { /* keep url */ }
      const label = e.operationName ? `${pathname} (${e.operationName})` : pathname;
      const rowClass = `network-row ${e.bucket === 'noise' ? 'noise-row' : ''} ${e.bucket === 'direct' ? 'direct-row' : ''}`;
      const statusClass = e.status ? `net-status-${Math.floor(e.status / 100)}xx` : '';
      let linkLabel = '';
      if (e.bucket === 'direct' && e.linkedStepIndex !== undefined)
        linkLabel = `→ step ${e.linkedStepIndex + 1} ✦`;
      else if (e.bucket === 'pageLoad' && e.linkedStepIndex !== undefined)
        linkLabel = `→ step ${e.linkedStepIndex + 1}`;
      else if (e.bucket === 'noise')
        linkLabel = 'noise — ignored';
      return <div key={i} className={rowClass}>
        <span className={`net-badge net-method-${e.method.toLowerCase()}`}>{e.method}</span>
        <span className='network-url' title={e.url}>{label}</span>
        {e.status && <span className={`net-badge net-status ${statusClass}`}>{e.status}</span>}
        <span className='network-link'>{linkLabel}</span>
      </div>;
    })}
  </div>;
};

function createRecorderBackend(): RecorderBackend {
  return new Proxy({} as RecorderBackend, {
    get: (_target, prop: string | symbol) => {
      if (typeof prop !== 'string')
        return undefined;
      return (params?: any) => {
        return window.sendCommand({ method: prop, params });
      };
    },
  });
}
