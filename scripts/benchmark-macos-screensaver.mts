/**
 * インストール済みmacOSスクリーンセーバーのlegacyScreenSaverプロセスを
 * 自動検出し、CPUとRSSを一定間隔で記録する。
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

interface Options {
  readonly bundlePath: string;
  readonly durationSeconds: number;
  readonly intervalSeconds: number;
  readonly waitSeconds: number;
  readonly output: string | undefined;
  readonly pid: number | undefined;
}

interface ProcessSnapshot {
  readonly pid: number;
  readonly cpuPercent: number;
  readonly rssMiB: number;
  readonly elapsed: string;
  readonly state: string;
}

interface Sample {
  readonly at: string;
  readonly processes: readonly ProcessSnapshot[];
}

interface MetricSummary {
  readonly min: number;
  readonly mean: number;
  readonly max: number;
}

interface ProcessSummary {
  readonly pid: number;
  readonly sampleCount: number;
  readonly activeSampleCount: number;
  readonly cpuPercent: MetricSummary;
  readonly rssMiB: MetricSummary & { readonly growth: number };
}

const execFileAsync = promisify(execFile);
const ACTIVE_CPU_THRESHOLD = 0.5;

const positiveNumber = (name: string, raw: string | undefined): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}には0より大きい数値を指定してください: ${String(raw)}`);
  }
  return value;
};

const positiveInteger = (name: string, raw: string | undefined): number => {
  const value = positiveNumber(name, raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name}には整数を指定してください: ${String(raw)}`);
  }
  return value;
};

const printHelp = (): void => {
  console.log(`使い方:
  npm run screensaver:benchmark:mac -- [オプション]

オプション:
  --duration <秒>  計測時間。既定値: 600
  --interval <秒>  サンプリング間隔。既定値: 5
  --wait <秒>      バンドルを読み込むプロセスの待機時間。既定値: 120
  --bundle <パス>  対象.saver。既定値: ~/Library/Screen Savers/MizuNiNaru.saver
  --pid <PID>      自動検出せず、特定のプロセスだけを計測
  --output <パス>  JSONの保存先
  --help           この説明を表示`);
};

const parseArgs = (): Options => {
  const args = process.argv.slice(2);
  let durationSeconds = 600;
  let intervalSeconds = 5;
  let waitSeconds = 120;
  let bundlePath = resolve(
    homedir(),
    'Library/Screen Savers/MizuNiNaru.saver',
  );
  let output: string | undefined;
  let pid: number | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--duration') {
      durationSeconds = positiveNumber(arg, args[++index]);
    } else if (arg === '--interval') {
      intervalSeconds = positiveNumber(arg, args[++index]);
    } else if (arg === '--wait') {
      waitSeconds = positiveNumber(arg, args[++index]);
    } else if (arg === '--bundle') {
      bundlePath = resolve(args[++index] ?? '');
    } else if (arg === '--pid') {
      pid = positiveInteger(arg, args[++index]);
    } else if (arg === '--output') {
      output = resolve(args[++index] ?? '');
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`不明なオプションです: ${String(arg)}`);
    }
  }

  if (intervalSeconds > durationSeconds) {
    throw new Error('--intervalは--duration以下にしてください');
  }

  return {
    bundlePath,
    durationSeconds,
    intervalSeconds,
    waitSeconds,
    output,
    pid,
  };
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const run = async (command: string, args: readonly string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const result = error as { readonly code?: number; readonly stdout?: string };
    if (result.code === 1) return result.stdout ?? '';
    throw error;
  }
};

const listLegacyScreenSaverPids = async (): Promise<number[]> => {
  const stdout = await run('pgrep', ['-x', 'legacyScreenSaver']);
  return stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

const processUsesBundle = async (
  pid: number,
  bundlePath: string,
): Promise<boolean> => {
  const stdout = await run('lsof', ['-Fn', '-p', String(pid)]);
  return stdout
    .split('\n')
    .some((line) => line.startsWith('n') && line.slice(1).startsWith(bundlePath));
};

const findMatchingPids = async (bundlePath: string): Promise<number[]> => {
  const pids = await listLegacyScreenSaverPids();
  const matches = await Promise.all(
    pids.map(async (pid) => ((await processUsesBundle(pid, bundlePath)) ? pid : 0)),
  );
  return matches.filter((pid) => pid > 0);
};

const readProcess = async (pid: number): Promise<ProcessSnapshot | undefined> => {
  const stdout = await run('ps', [
    '-p',
    String(pid),
    '-o',
    'pid=,%cpu=,rss=,etime=,state=',
  ]);
  const fields = stdout.trim().split(/\s+/);
  if (fields.length < 5) return undefined;

  const parsedPid = Number(fields[0]);
  const cpuPercent = Number(fields[1]);
  const rssKiB = Number(fields[2]);
  if (
    !Number.isInteger(parsedPid) ||
    !Number.isFinite(cpuPercent) ||
    !Number.isFinite(rssKiB)
  ) {
    return undefined;
  }

  return {
    pid: parsedPid,
    cpuPercent,
    rssMiB: rssKiB / 1024,
    elapsed: fields[3] ?? '',
    state: fields[4] ?? '',
  };
};

const waitForMatchingPids = async (options: Options): Promise<number[]> => {
  if (options.pid !== undefined) return [options.pid];

  const deadline = Date.now() + options.waitSeconds * 1000;
  while (Date.now() <= deadline) {
    const pids = await findMatchingPids(options.bundlePath);
    if (pids.length > 0) return pids;
    process.stdout.write('.');
    await delay(1000);
  }
  throw new Error(
    `${options.bundlePath}を読み込むlegacyScreenSaverが見つかりませんでした`,
  );
};

const round = (value: number): number => Math.round(value * 100) / 100;

const summarizeMetric = (values: readonly number[]): MetricSummary => ({
  min: round(Math.min(...values)),
  mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  max: round(Math.max(...values)),
});

const summarizeProcesses = (samples: readonly Sample[]): ProcessSummary[] => {
  const byPid = new Map<number, ProcessSnapshot[]>();
  for (const sample of samples) {
    for (const snapshot of sample.processes) {
      const snapshots = byPid.get(snapshot.pid) ?? [];
      snapshots.push(snapshot);
      byPid.set(snapshot.pid, snapshots);
    }
  }

  return [...byPid.entries()]
    .map(([pid, snapshots]) => {
      const active = snapshots.filter(
        (snapshot) => snapshot.cpuPercent >= ACTIVE_CPU_THRESHOLD,
      );
      const measured = active.length > 0 ? active : snapshots;
      const rssValues = measured.map((snapshot) => snapshot.rssMiB);
      const rssSummary = summarizeMetric(rssValues);
      return {
        pid,
        sampleCount: snapshots.length,
        activeSampleCount: active.length,
        cpuPercent: summarizeMetric(
          measured.map((snapshot) => snapshot.cpuPercent),
        ),
        rssMiB: {
          ...rssSummary,
          growth: round(rssValues.at(-1)! - rssValues[0]!),
        },
      };
    })
    .sort((left, right) => right.activeSampleCount - left.activeSampleCount);
};

const main = async (): Promise<void> => {
  if (process.platform !== 'darwin') {
    throw new Error('この計測ツールはmacOS専用です');
  }

  const options = parseArgs();
  console.log(`対象: ${options.bundlePath}`);
  console.log(
    `${options.durationSeconds}秒間、${options.intervalSeconds}秒ごとに計測します。`,
  );
  console.log('MizuNiNaruを選択し、フルスクリーンプレビューを開始してください。');

  const trackedPids = new Set(await waitForMatchingPids(options));
  console.log(`検出したPID: ${[...trackedPids].join(', ')}`);

  const startedAt = new Date();
  const deadline = Date.now() + options.durationSeconds * 1000;
  const samples: Sample[] = [];
  let nextDiscoveryAt = Date.now() + 30_000;
  let nextProgressAt = Date.now();

  while (Date.now() <= deadline) {
    if (options.pid === undefined && Date.now() >= nextDiscoveryAt) {
      const discovered = await findMatchingPids(options.bundlePath);
      for (const pid of discovered) trackedPids.add(pid);
      nextDiscoveryAt = Date.now() + 30_000;
    }

    const snapshots = (
      await Promise.all([...trackedPids].map((pid) => readProcess(pid)))
    ).filter((snapshot): snapshot is ProcessSnapshot => snapshot !== undefined);
    samples.push({ at: new Date().toISOString(), processes: snapshots });

    if (Date.now() >= nextProgressAt) {
      const status = snapshots
        .map(
          (snapshot) =>
            `PID ${snapshot.pid}: CPU ${snapshot.cpuPercent.toFixed(1)}% / RSS ${snapshot.rssMiB.toFixed(1)}MiB`,
        )
        .join(' | ');
      console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${status}`);
      nextProgressAt = Date.now() + 60_000;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(options.intervalSeconds * 1000, remaining));
  }

  const summaries = summarizeProcesses(samples);
  const result = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationSeconds: options.durationSeconds,
    intervalSeconds: options.intervalSeconds,
    bundleName: options.bundlePath.split('/').at(-1),
    activeCpuThresholdPercent: ACTIVE_CPU_THRESHOLD,
    primaryPid: summaries[0]?.pid,
    processes: summaries,
    samples,
  };

  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`保存先: ${options.output}`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
