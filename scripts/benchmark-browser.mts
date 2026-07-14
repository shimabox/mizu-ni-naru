/**
 * Production buildを固定条件のChromeで測る、依存パッケージ不要のCDP runner。
 * `npm run bench:browser -- --output performance-results/raw/example.json`
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  DistributionSummary,
  PerformanceProbeSnapshot,
} from '../src/app/PerformanceProbe';

interface Options {
  readonly url: string;
  readonly warmupSeconds: number;
  readonly measureSeconds: number;
  readonly rounds: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly chromePath: string;
  readonly output: string | undefined;
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface TargetDescriptor {
  readonly webSocketDebuggerUrl: string;
}

interface BrowserEnvironment {
  readonly userAgent: string;
  readonly viewport: {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly devicePixelRatio: number;
    readonly canvasClientWidth: number;
    readonly canvasClientHeight: number;
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;
  };
  readonly webgl: {
    readonly vendor: string | null;
    readonly renderer: string | null;
  };
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const DEFAULT_URL =
  'http://127.0.0.1:4173/?seed=7&slots=24&q=0&m=1&dpr=1&probe=1';

const positiveNumber = (name: string, raw: string | undefined): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number: ${String(raw)}`);
  }
  return value;
};

const positiveInteger = (name: string, raw: string | undefined): number => {
  const value = positiveNumber(name, raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer: ${String(raw)}`);
  }
  return value;
};

const defaultChromeCandidates = (): string[] => {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    return [
      localAppData
        ? join(localAppData, 'Google/Chrome/Application/chrome.exe')
        : '',
      programFiles
        ? join(programFiles, 'Google/Chrome/Application/chrome.exe')
        : '',
    ].filter(Boolean);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
};

const findChrome = async (explicit: string | undefined): Promise<string> => {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    ...defaultChromeCandidates(),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 次の候補へ進む。
    }
  }
  throw new Error(
    'Chrome was not found. Pass --chrome /absolute/path or set CHROME_PATH.',
  );
};

const parseArgs = async (): Promise<Options> => {
  const args = process.argv.slice(2);
  let url = DEFAULT_URL;
  let warmupSeconds = 15;
  let measureSeconds = 30;
  let rounds = 5;
  let viewportWidth = 1440;
  let viewportHeight = 727;
  let chromePath: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url') url = args[++i] ?? '';
    else if (arg === '--warmup') {
      warmupSeconds = positiveNumber(arg, args[++i]);
    } else if (arg === '--seconds') {
      measureSeconds = positiveNumber(arg, args[++i]);
    } else if (arg === '--rounds') {
      rounds = positiveInteger(arg, args[++i]);
    } else if (arg === '--width') {
      viewportWidth = positiveInteger(arg, args[++i]);
    } else if (arg === '--height') {
      viewportHeight = positiveInteger(arg, args[++i]);
    } else if (arg === '--chrome') chromePath = args[++i];
    else if (arg === '--output') output = args[++i];
    else throw new Error(`Unknown argument: ${String(arg)}`);
  }

  const parsedUrl = new URL(url);
  if (parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost') {
    throw new Error('--url must target localhost or 127.0.0.1');
  }
  parsedUrl.searchParams.set('probe', '1');

  return {
    url: parsedUrl.toString(),
    warmupSeconds,
    measureSeconds,
    rounds,
    viewportWidth,
    viewportHeight,
    chromePath: await findChrome(chromePath),
    output: output ? resolve(projectRoot, output) : undefined,
  };
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const stopProcess = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), delay(1_000)]);
  }
};

const waitForHttp = async (
  url: string,
  processToWatch: ChildProcess,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processToWatch.exitCode !== null) {
      throw new Error(`Preview server exited with ${processToWatch.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 起動中。短時間待って再試行する。
    }
    await delay(100);
  }
  throw new Error(`Preview server did not become ready: ${url}`);
};

const waitForDevToolsPort = async (
  userDataDir: string,
  chrome: ChildProcess,
  timeoutMs = 30_000,
): Promise<number> => {
  const path = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome exited with ${chrome.exitCode}`);
    }
    try {
      const [port] = (await readFile(path, 'utf8')).trim().split('\n');
      const value = Number(port);
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // Chromeがport fileを書くまで待つ。
    }
    await delay(100);
  }
  throw new Error('Chrome DevTools port was not created');
};

class CdpConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCommand>();
  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? 'Unknown Chrome DevTools error'),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Chrome DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  public static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', () => resolveOpen(), { once: true });
      socket.addEventListener(
        'error',
        () => rejectOpen(new Error('Chrome DevTools connection failed')),
        { once: true },
      );
    });
    return new CdpConnection(socket);
  }

  public send(method: string, params: object = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, {
        resolve: resolveCommand,
        reject: rejectCommand,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  public async evaluate<T>(expression: string): Promise<T> {
    const response = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      readonly result?: { readonly value?: T; readonly description?: string };
      readonly exceptionDetails?: unknown;
    };
    if (response.exceptionDetails) {
      throw new Error(response.result?.description ?? 'Browser evaluation failed');
    }
    return response.result?.value as T;
  }

  public close(): void {
    this.socket.close();
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.5) - 1] ?? 0;
};

const distributionKeys: readonly (keyof DistributionSummary)[] = [
  'count',
  'min',
  'p50',
  'p95',
  'p99',
  'max',
  'mean',
];

const metricKeys: readonly (keyof PerformanceProbeSnapshot)[] = [
  'frameMs',
  'updateMs',
  'drawCalls',
  'instancedDrawCalls',
  'submittedVertices',
  'bufferSubDataBytes',
  'uniform4fvBytes',
  'gpuMs',
];

const medianOfRoundSummaries = (
  rounds: readonly PerformanceProbeSnapshot[],
): Record<string, Record<string, number>> =>
  Object.fromEntries(
    metricKeys.map((metric) => [
      metric,
      Object.fromEntries(
        distributionKeys.map((field) => [
          field,
          median(
            rounds.map(
              (round) => (round[metric] as DistributionSummary)[field],
            ),
          ),
        ]),
      ),
    ]),
  );

const environmentExpression = `(() => {
  const canvas = document.querySelector('#myCanvas');
  const gl = canvas.getContext('webgl2');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    userAgent: navigator.userAgent,
    viewport: {
      innerWidth,
      innerHeight,
      devicePixelRatio,
      canvasClientWidth: canvas.clientWidth,
      canvasClientHeight: canvas.clientHeight,
      drawingBufferWidth: gl.drawingBufferWidth,
      drawingBufferHeight: gl.drawingBufferHeight,
    },
    webgl: {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    },
  };
})()`;

const run = async (): Promise<void> => {
  const options = await parseArgs();
  const targetUrl = new URL(options.url);
  const origin = targetUrl.origin;
  const viteCli = join(projectRoot, 'node_modules/vite/bin/vite.js');
  const preview = spawn(
    process.execPath,
    [
      viteCli,
      'preview',
      '--host',
      targetUrl.hostname,
      '--port',
      targetUrl.port || '4173',
      '--strictPort',
    ],
    { cwd: projectRoot, stdio: 'ignore' },
  );
  const userDataDir = await mkdtemp(join(tmpdir(), 'mizu-browser-bench-'));
  let chrome: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;

  const cleanup = async (): Promise<void> => {
    cdp?.close();
    // Chromeがprofile fileを閉じる前にrmするとmacOSでENOTEMPTYになり得る。
    await stopProcess(chrome);
    await stopProcess(preview);
    await rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };

  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    void cleanup().finally(() => process.exit(143));
  });

  try {
    process.stderr.write(`Waiting for production preview at ${origin}\n`);
    await waitForHttp(origin, preview);
    chrome = spawn(
      options.chromePath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const debugPort = await waitForDevToolsPort(userDataDir, chrome);
    const targetResponse = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(options.url)}`,
      { method: 'PUT' },
    );
    if (!targetResponse.ok) {
      throw new Error(`Could not create Chrome target: ${targetResponse.status}`);
    }
    const target = (await targetResponse.json()) as TargetDescriptor;
    cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.viewportWidth,
      height: options.viewportHeight,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: options.url });

    const readyDeadline = Date.now() + 30_000;
    while (Date.now() < readyDeadline) {
      const ready = await cdp.evaluate<boolean>(
        "document.readyState === 'complete' && Boolean(globalThis.__mizuPerf)",
      );
      if (ready) break;
      await delay(100);
    }
    if (Date.now() >= readyDeadline) {
      throw new Error('Performance probe did not become ready');
    }

    process.stderr.write(`Warm-up: ${options.warmupSeconds}s\n`);
    await delay(options.warmupSeconds * 1_000);
    const environment = await cdp.evaluate<BrowserEnvironment>(
      environmentExpression,
    );
    const rounds: PerformanceProbeSnapshot[] = [];
    for (let round = 0; round < options.rounds; round++) {
      await cdp.evaluate('globalThis.__mizuPerf.reset()');
      process.stderr.write(
        `Round ${round + 1}/${options.rounds}: ${options.measureSeconds}s\n`,
      );
      await delay(options.measureSeconds * 1_000);
      rounds.push(
        await cdp.evaluate<PerformanceProbeSnapshot>(
          'globalThis.__mizuPerf.snapshot()',
        ),
      );
    }

    const result = {
      measuredAt: new Date().toISOString(),
      gitCommit: (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })
      ).stdout.trim(),
      gitWorkingTree: (
        await execFileAsync('git', ['status', '--short'], { cwd: projectRoot })
      ).stdout.trim().split('\n').filter(Boolean),
      options: {
        url: options.url,
        warmupSeconds: options.warmupSeconds,
        measureSeconds: options.measureSeconds,
        rounds: options.rounds,
        viewportWidth: options.viewportWidth,
        viewportHeight: options.viewportHeight,
        chromePath: options.chromePath,
      },
      environment,
      medianOfRoundSummaries: medianOfRoundSummaries(rounds),
      rounds,
    };
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, json);
      process.stderr.write(`Wrote ${options.output}\n`);
    } else {
      process.stdout.write(json);
    }
  } finally {
    await cleanup();
  }
};

await run();
