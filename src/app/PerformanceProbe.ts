interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export interface DistributionSummary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export interface PerformanceProbeSnapshot {
  readonly frameMs: DistributionSummary;
  readonly updateMs: DistributionSummary;
  readonly drawCalls: DistributionSummary;
  readonly instancedDrawCalls: DistributionSummary;
  readonly submittedVertices: DistributionSummary;
  readonly bufferSubDataBytes: DistributionSummary;
  readonly gpuMs: DistributionSummary;
  readonly gpuTimerAvailable: boolean;
  readonly gpuQueriesPending: number;
  readonly gpuDisjointSamples: number;
}

export interface PerformanceProbeApi {
  /** 現在までのsampleを破棄して、次のrAFから新しいroundを始める。 */
  readonly reset: () => void;
  /** sampleを変更せず、その時点の分布要約を返す。 */
  readonly snapshot: () => PerformanceProbeSnapshot;
}

const EMPTY_DISTRIBUTION: DistributionSummary = {
  count: 0,
  min: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  max: 0,
  mean: 0,
};

const quantile = (sorted: readonly number[], q: number): number => {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[index] ?? 0;
};

/** benchmark-sim.mtsと同じnearest-rank規約で分布を要約する。 */
export const summarizeDistribution = (
  samples: readonly number[],
): DistributionSummary => {
  if (samples.length === 0) return EMPTY_DISTRIBUTION;

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    mean,
  };
};

const uploadedByteLength = (
  source: ArrayBuffer | ArrayBufferView,
  sourceOffset = 0,
  length?: number,
): number => {
  if (ArrayBuffer.isView(source)) {
    const bytesPerElement =
      'BYTES_PER_ELEMENT' in source &&
      typeof source.BYTES_PER_ELEMENT === 'number'
        ? source.BYTES_PER_ELEMENT
        : 1;
    const available = Math.max(
      0,
      source.byteLength - sourceOffset * bytesPerElement,
    );
    return length === undefined
      ? available
      : Math.min(available, length * bytesPerElement);
  }
  const available = Math.max(0, source.byteLength - sourceOffset);
  return length === undefined ? available : Math.min(available, length);
};

/**
 * `?probe=1` 専用の詳細ブラウザ計測器。
 *
 * WebGL2のdraw/bufferSubDataだけを薄く包み、rAF単位の呼び出し数・転送量を
 * 記録する。GPU時間はEXT_disjoint_timer_query_webgl2がある環境だけ非同期で
 * 取得する。通常URLでは構築されないため、本番表示への実行時コストはない。
 */
export class PerformanceProbe {
  private readonly gl: WebGL2RenderingContext;
  private readonly timerExtension: TimerQueryExtension | null;
  private readonly originalDrawArrays: WebGL2RenderingContext['drawArrays'];
  private readonly originalDrawElements: WebGL2RenderingContext['drawElements'];
  private readonly originalDrawArraysInstanced: WebGL2RenderingContext['drawArraysInstanced'];
  private readonly originalDrawElementsInstanced: WebGL2RenderingContext['drawElementsInstanced'];
  private readonly originalBufferSubData: WebGL2RenderingContext['bufferSubData'];
  private readonly pendingGpuQueries: WebGLQuery[] = [];
  private activeGpuQuery: WebGLQuery | null = null;
  private frameDrawCalls = 0;
  private frameInstancedDrawCalls = 0;
  private frameSubmittedVertices = 0;
  private frameBufferSubDataBytes = 0;
  private gpuDisjointSamples = 0;
  private readonly frameSamples: number[] = [];
  private readonly updateSamples: number[] = [];
  private readonly drawCallSamples: number[] = [];
  private readonly instancedDrawCallSamples: number[] = [];
  private readonly submittedVertexSamples: number[] = [];
  private readonly bufferSubDataSamples: number[] = [];
  private readonly gpuSamples: number[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      throw new Error('PerformanceProbe requires the existing WebGL2 context');
    }
    this.gl = gl;
    this.timerExtension = gl.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    ) as TimerQueryExtension | null;

    this.originalDrawArrays = gl.drawArrays.bind(gl);
    this.originalDrawElements = gl.drawElements.bind(gl);
    this.originalDrawArraysInstanced = gl.drawArraysInstanced.bind(gl);
    this.originalDrawElementsInstanced = gl.drawElementsInstanced.bind(gl);
    this.originalBufferSubData = gl.bufferSubData.bind(gl);

    gl.drawArrays = (mode, first, count): void => {
      this.frameDrawCalls++;
      this.frameSubmittedVertices += count;
      this.originalDrawArrays(mode, first, count);
    };
    gl.drawElements = (mode, count, type, offset): void => {
      this.frameDrawCalls++;
      this.frameSubmittedVertices += count;
      this.originalDrawElements(mode, count, type, offset);
    };
    gl.drawArraysInstanced = (mode, first, count, instanceCount): void => {
      this.frameDrawCalls++;
      this.frameInstancedDrawCalls++;
      this.frameSubmittedVertices += count * instanceCount;
      this.originalDrawArraysInstanced(mode, first, count, instanceCount);
    };
    gl.drawElementsInstanced = (
      mode,
      count,
      type,
      offset,
      instanceCount,
    ): void => {
      this.frameDrawCalls++;
      this.frameInstancedDrawCalls++;
      this.frameSubmittedVertices += count * instanceCount;
      this.originalDrawElementsInstanced(
        mode,
        count,
        type,
        offset,
        instanceCount,
      );
    };
    gl.bufferSubData = (
      target: GLenum,
      dstByteOffset: GLintptr,
      srcData: ArrayBuffer | ArrayBufferView,
      srcOffset?: number,
      length?: GLuint,
    ): void => {
      this.frameBufferSubDataBytes += uploadedByteLength(
        srcData,
        srcOffset,
        length,
      );
      if (length !== undefined) {
        this.originalBufferSubData(
          target,
          dstByteOffset,
          srcData as ArrayBufferView,
          srcOffset ?? 0,
          length,
        );
      } else if (srcOffset !== undefined) {
        this.originalBufferSubData(
          target,
          dstByteOffset,
          srcData as ArrayBufferView,
          srcOffset,
        );
      } else {
        this.originalBufferSubData(target, dstByteOffset, srcData);
      }
    };
  }

  public beginFrame(): void {
    this.pollGpuQueries();
    this.frameDrawCalls = 0;
    this.frameInstancedDrawCalls = 0;
    this.frameSubmittedVertices = 0;
    this.frameBufferSubDataBytes = 0;

    if (!this.timerExtension || this.activeGpuQuery) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
    this.activeGpuQuery = query;
  }

  public endFrame(frameMs: number, updateMs: number): void {
    if (this.timerExtension && this.activeGpuQuery) {
      this.gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
      this.pendingGpuQueries.push(this.activeGpuQuery);
      this.activeGpuQuery = null;
    }

    this.frameSamples.push(frameMs);
    this.updateSamples.push(updateMs);
    this.drawCallSamples.push(this.frameDrawCalls);
    this.instancedDrawCallSamples.push(this.frameInstancedDrawCalls);
    this.submittedVertexSamples.push(this.frameSubmittedVertices);
    this.bufferSubDataSamples.push(this.frameBufferSubDataBytes);
  }

  public reset(): void {
    this.frameSamples.length = 0;
    this.updateSamples.length = 0;
    this.drawCallSamples.length = 0;
    this.instancedDrawCallSamples.length = 0;
    this.submittedVertexSamples.length = 0;
    this.bufferSubDataSamples.length = 0;
    this.gpuSamples.length = 0;
    this.gpuDisjointSamples = 0;
    for (const query of this.pendingGpuQueries) this.gl.deleteQuery(query);
    this.pendingGpuQueries.length = 0;
  }

  public snapshot(): PerformanceProbeSnapshot {
    this.pollGpuQueries();
    return {
      frameMs: summarizeDistribution(this.frameSamples),
      updateMs: summarizeDistribution(this.updateSamples),
      drawCalls: summarizeDistribution(this.drawCallSamples),
      instancedDrawCalls: summarizeDistribution(this.instancedDrawCallSamples),
      submittedVertices: summarizeDistribution(this.submittedVertexSamples),
      bufferSubDataBytes: summarizeDistribution(this.bufferSubDataSamples),
      gpuMs: summarizeDistribution(this.gpuSamples),
      gpuTimerAvailable: this.timerExtension !== null,
      gpuQueriesPending: this.pendingGpuQueries.length,
      gpuDisjointSamples: this.gpuDisjointSamples,
    };
  }

  public dispose(): void {
    this.gl.drawArrays = this.originalDrawArrays;
    this.gl.drawElements = this.originalDrawElements;
    this.gl.drawArraysInstanced = this.originalDrawArraysInstanced;
    this.gl.drawElementsInstanced = this.originalDrawElementsInstanced;
    this.gl.bufferSubData = this.originalBufferSubData;
    if (this.activeGpuQuery) this.gl.deleteQuery(this.activeGpuQuery);
    for (const query of this.pendingGpuQueries) this.gl.deleteQuery(query);
    this.pendingGpuQueries.length = 0;
    this.activeGpuQuery = null;
  }

  private pollGpuQueries(): void {
    if (!this.timerExtension) return;
    const isDisjoint = Boolean(
      this.gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT),
    );

    let write = 0;
    for (const query of this.pendingGpuQueries) {
      const available = Boolean(
        this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE),
      );
      if (!available) {
        this.pendingGpuQueries[write++] = query;
        continue;
      }
      if (isDisjoint) {
        this.gpuDisjointSamples++;
      } else {
        const elapsedNs = Number(
          this.gl.getQueryParameter(query, this.gl.QUERY_RESULT),
        );
        this.gpuSamples.push(elapsedNs / 1_000_000);
      }
      this.gl.deleteQuery(query);
    }
    this.pendingGpuQueries.length = write;
  }
}
