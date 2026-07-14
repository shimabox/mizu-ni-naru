import { BUBBLE_CAPACITY } from '../contract/WorldSpec';

/**
 * URL パラメータ(master-plan §5)。全て省略可・不正値は undefined に落とす。
 * - seed: RNG シード(決定論再現)
 * - m=1:  計測モード(overlay + tier0 固定 + 視差無効 + カメラ t=0。seed は独立 — A17)
 * - q:    品質ティア固定 0..4
 * - dpr:  DPR 上限
 * - probe=1: 詳細ブラウザ計測API(WebGL呼び出し計数 + GPU timer query)
 * - sim=stub: StubSim 差し替え
 * - slots: スロット数上書き(デバッグ用、1..BUBBLE_CAPACITY)
 */
export interface UrlParams {
  readonly seed: number | undefined;
  readonly measure: boolean;
  readonly q: number | undefined;
  readonly dpr: number | undefined;
  readonly probe: boolean;
  readonly sim: 'stub' | undefined;
  readonly slots: number | undefined;
}

const parseIntInRange = (
  raw: string | null,
  min: number,
  max: number,
): number | undefined => {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
};

export const parseUrlParams = (search: string): UrlParams => {
  const params = new URLSearchParams(search);

  const dprRaw = params.get('dpr');
  let dpr: number | undefined;
  if (dprRaw !== null && dprRaw !== '') {
    const n = Number(dprRaw);
    dpr = Number.isFinite(n) && n > 0 ? n : undefined;
  }

  return {
    seed: parseIntInRange(params.get('seed'), 0, 0xffffffff),
    measure: params.get('m') === '1',
    q: parseIntInRange(params.get('q'), 0, 4),
    dpr,
    probe: params.get('probe') === '1',
    sim: params.get('sim') === 'stub' ? 'stub' : undefined,
    slots: parseIntInRange(params.get('slots'), 1, BUBBLE_CAPACITY),
  };
};
