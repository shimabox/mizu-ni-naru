/**
 * 現行WebGL画面からmacOSスクリーンセーバー用の4時間帯動画を生成する。
 * 依存パッケージを追加せず、Chrome DevTools Protocolとffmpegを使用する。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
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

interface PeriodDefinition {
  readonly name: 'morning' | 'day' | 'evening' | 'night';
  readonly time: string;
}

interface Options {
  readonly outputDirectory: string;
  readonly durationSeconds: number;
  readonly crossfadeSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly sourceBitrateMbps: number;
  readonly codec: 'h264' | 'hevc';
  readonly crf: number;
  readonly hevcQuality: number;
  readonly seed: number;
  readonly chromePath: string;
  readonly periods: readonly PeriodDefinition[];
}

interface CdpMessage {
  readonly id?: number;
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

interface CaptureResult {
  readonly base64: string;
  readonly mimeType: string;
  readonly size: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const PERIODS: readonly PeriodDefinition[] = [
  { name: 'morning', time: '08:00' },
  { name: 'day', time: '12:00' },
  { name: 'evening', time: '18:15' },
  { name: 'night', time: '21:00' },
];

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

const defaultChromeCandidates = (): string[] => [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

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
  let outputDirectory = resolve(
    projectRoot,
    'screensaver/macos/Resources/Videos',
  );
  let durationSeconds = 62;
  let crossfadeSeconds = 2;
  let width = 1280;
  let height = 720;
  let fps = 30;
  let sourceBitrateMbps = 8;
  let codec: 'h264' | 'hevc' = 'h264';
  let crf = 21;
  let hevcQuality = 60;
  let seed = 7;
  let chromePath: string | undefined;
  let selectedNames: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output') {
      outputDirectory = resolve(projectRoot, args[++i] ?? '');
    } else if (arg === '--duration') {
      durationSeconds = positiveNumber(arg, args[++i]);
    } else if (arg === '--crossfade') {
      crossfadeSeconds = positiveNumber(arg, args[++i]);
    } else if (arg === '--width') {
      width = positiveInteger(arg, args[++i]);
    } else if (arg === '--height') {
      height = positiveInteger(arg, args[++i]);
    } else if (arg === '--fps') {
      fps = positiveInteger(arg, args[++i]);
    } else if (arg === '--source-bitrate') {
      sourceBitrateMbps = positiveNumber(arg, args[++i]);
    } else if (arg === '--codec') {
      const value = args[++i];
      if (value !== 'h264' && value !== 'hevc') {
        throw new Error('--codec must be h264 or hevc');
      }
      codec = value;
    } else if (arg === '--crf') {
      crf = positiveInteger(arg, args[++i]);
    } else if (arg === '--hevc-quality') {
      hevcQuality = positiveInteger(arg, args[++i]);
    } else if (arg === '--seed') {
      seed = positiveInteger(arg, args[++i]);
    } else if (arg === '--chrome') {
      chromePath = args[++i];
    } else if (arg === '--periods') {
      selectedNames = (args[++i] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  if (crossfadeSeconds * 2 >= durationSeconds) {
    throw new Error('--crossfade must be less than half of --duration');
  }
  if (crf > 51) {
    throw new Error('--crf must be between 1 and 51');
  }
  if (hevcQuality > 100) {
    throw new Error('--hevc-quality must be between 1 and 100');
  }
  const periods = selectedNames
    ? PERIODS.filter((period) => selectedNames.includes(period.name))
    : PERIODS;
  if (periods.length === 0 || periods.length !== (selectedNames?.length ?? 4)) {
    throw new Error(
      `--periods must contain unique values from: ${PERIODS.map((value) => value.name).join(',')}`,
    );
  }

  return {
    outputDirectory,
    durationSeconds,
    crossfadeSeconds,
    width,
    height,
    fps,
    sourceBitrateMbps,
    codec,
    crf,
    hevcQuality,
    seed,
    chromePath: await findChrome(chromePath),
    periods,
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
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processToWatch.exitCode !== null) {
      throw new Error(`Preview server exited with ${processToWatch.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 起動中。
    }
    await delay(100);
  }
  throw new Error(`Preview server did not become ready: ${url}`);
};

const waitForDevToolsPort = async (
  userDataDir: string,
  chrome: ChildProcess,
): Promise<number> => {
  const path = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 30_000;
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

const waitForScene = async (
  cdp: CdpConnection,
  width: number,
  height: number,
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate<boolean>(`(() => {
      const canvas = document.querySelector('#myCanvas');
      return document.readyState === 'complete' &&
        canvas instanceof HTMLCanvasElement &&
        canvas.width === ${width} && canvas.height === ${height} &&
        Boolean(canvas.getContext('webgl2'));
    })()`);
    if (ready) return;
    await delay(100);
  }
  throw new Error('WebGL scene did not become ready');
};

const captureCanvas = async (
  cdp: CdpConnection,
  durationSeconds: number,
  fps: number,
  sourceBitrateMbps: number,
): Promise<CaptureResult> =>
  cdp.evaluate<CaptureResult>(`(() => new Promise(async (resolve, reject) => {
    try {
      const canvas = document.querySelector('#myCanvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Canvas was not found');
      }
      const mimeType = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) throw new Error('MediaRecorder WebM is unavailable');

      const stream = canvas.captureStream(${fps});
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: ${sourceBitrateMbps * 1_000_000},
      });
      const chunks = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      const stopped = new Promise((resolveStop, rejectStop) => {
        recorder.addEventListener('stop', resolveStop, { once: true });
        recorder.addEventListener('error', () => rejectStop(recorder.error), {
          once: true,
        });
      });

      recorder.start(500);
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, ${durationSeconds * 1_000}),
      );
      recorder.stop();
      await stopped;

      const blob = new Blob(chunks, { type: mimeType });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 0x8000),
        );
      }
      resolve({
        base64: btoa(binary),
        mimeType,
        size: bytes.length,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      });
    } catch (error) {
      reject(error);
    }
  }))()`);

const encodeLoop = async (
  input: string,
  output: string,
  options: Options,
): Promise<void> => {
  const transitionStart = options.durationSeconds - options.crossfadeSeconds;
  const mainEnd = transitionStart;
  const filter = [
    `[0:v]trim=start=${options.crossfadeSeconds}:end=${mainEnd},setpts=PTS-STARTPTS,fps=${options.fps},format=yuv420p,settb=AVTB[main]`,
    `[0:v]trim=start=${transitionStart}:end=${options.durationSeconds},setpts=PTS-STARTPTS,fps=${options.fps},format=yuv420p,settb=AVTB[tail]`,
    `[0:v]trim=start=0:end=${options.crossfadeSeconds},setpts=PTS-STARTPTS,fps=${options.fps},format=yuv420p,settb=AVTB[head]`,
    `[tail][head]xfade=transition=fade:duration=${options.crossfadeSeconds}:offset=0[blend]`,
    '[main][blend]concat=n=2:v=1:a=0[out]',
  ].join(';');
  const encoderArgs =
    options.codec === 'hevc'
      ? [
          '-c:v',
          'hevc_videotoolbox',
          '-q:v',
          String(options.hevcQuality),
          '-tag:v',
          'hvc1',
          '-profile:v',
          'main',
          '-allow_sw',
          '1',
        ]
      : [
          '-c:v',
          'libx264',
          '-preset',
          'slow',
          '-crf',
          String(options.crf),
        ];
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    input,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-an',
    ...encoderArgs,
    '-pix_fmt',
    'yuv420p',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-movflags',
    '+faststart',
    output,
  ]);
};

const probeVideo = async (path: string): Promise<unknown> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size,bit_rate:stream=codec_name,profile,width,height,pix_fmt,avg_frame_rate',
    '-of',
    'json',
    path,
  ]);
  return JSON.parse(stdout) as unknown;
};

const run = async (): Promise<void> => {
  const options = await parseArgs();
  await execFileAsync('ffmpeg', ['-version']);
  await execFileAsync('ffprobe', ['-version']);
  await mkdir(options.outputDirectory, { recursive: true });
  const workingDirectory = await mkdtemp(
    join(tmpdir(), 'mizu-screensaver-capture-'),
  );
  const preview = spawn(
    process.execPath,
    [
      join(projectRoot, 'node_modules/vite/bin/vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '4173',
      '--strictPort',
    ],
    { cwd: projectRoot, stdio: 'ignore' },
  );
  const userDataDirectory = await mkdtemp(
    join(tmpdir(), 'mizu-screensaver-chrome-'),
  );
  let chrome: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;

  try {
    process.stderr.write('本番プレビューの起動を待っています。\n');
    await waitForHttp('http://127.0.0.1:4173/', preview);
    chrome = spawn(
      options.chromePath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDirectory}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--autoplay-policy=no-user-gesture-required',
        '--ignore-gpu-blocklist',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    const debugPort = await waitForDevToolsPort(userDataDirectory, chrome);
    const targetResponse = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?about%3Ablank`,
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
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const results = [];
    for (const period of options.periods) {
      const url = new URL('http://127.0.0.1:4173/');
      url.searchParams.set('seed', String(options.seed));
      url.searchParams.set('q', '0');
      url.searchParams.set('dpr', '1');
      url.searchParams.set('time', period.time);
      process.stderr.write(`${period.name} (${period.time}) を準備しています。\n`);
      await cdp.send('Page.navigate', { url: url.toString() });
      await waitForScene(cdp, options.width, options.height);
      await delay(3_000);

      process.stderr.write(
        `${period.name} を${options.durationSeconds}秒収録しています。\n`,
      );
      const capture = await captureCanvas(
        cdp,
        options.durationSeconds,
        options.fps,
        options.sourceBitrateMbps,
      );
      const bytes = Buffer.from(capture.base64, 'base64');
      if (bytes.length !== capture.size) {
        throw new Error(
          `Capture size mismatch: browser=${capture.size} node=${bytes.length}`,
        );
      }
      const rawPath = join(workingDirectory, `${period.name}.webm`);
      const outputPath = join(options.outputDirectory, `${period.name}.mp4`);
      await writeFile(rawPath, bytes);
      process.stderr.write(`${period.name} をH.264ループへ変換しています。\n`);
      await encodeLoop(rawPath, outputPath, options);
      const outputBytes = await readFile(outputPath);
      results.push({
        period: period.name,
        time: period.time,
        url: url.toString(),
        sourceMimeType: capture.mimeType,
        sourceBytes: capture.size,
        outputFile: `${period.name}.mp4`,
        sha256: createHash('sha256').update(outputBytes).digest('hex'),
        probe: await probeVideo(outputPath),
      });
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      options: {
        durationSeconds: options.durationSeconds,
        crossfadeSeconds: options.crossfadeSeconds,
        outputDurationSeconds:
          options.durationSeconds - options.crossfadeSeconds,
        width: options.width,
        height: options.height,
        fps: options.fps,
        sourceBitrateMbps: options.sourceBitrateMbps,
        codec: options.codec,
        crf: options.codec === 'h264' ? options.crf : undefined,
        hevcQuality:
          options.codec === 'hevc' ? options.hevcQuality : undefined,
        seed: options.seed,
        chromePath: options.chromePath,
      },
      results,
    };
    const manifestPath = join(options.outputDirectory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(preview);
    await Promise.all([
      rm(workingDirectory, { recursive: true, force: true }),
      rm(userDataDirectory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    ]);
  }
};

await run();
