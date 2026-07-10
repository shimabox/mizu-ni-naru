import { PerspectiveCamera, Vector3 } from 'three';

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** 視差の平滑時定数(フレームレート非依存の指数追従 — design-render §8)。 */
const PARALLAX_TAU_S = 0.45;
/** reduced-motion 時にドリフトを凍結する t(良構図の秒)。 */
const REDUCED_MOTION_FREEZE_T = 12;

export interface CameraRigOptions {
  /** false でマウス視差を無効化(`?m=1` — 決定論軌道)。 */
  readonly parallax: boolean;
}

/**
 * OrbitControls 不使用の自動漂流カメラ(design-render §8)。
 *
 * - 基準軌道はリサージュ的(非整数比の周期で永久に非反復)。
 *   t はウォールクロックではなく timeSec = stepF/60(sim 停止=カメラ停止)
 * - マウス視差: Δyaw 3.5°·nx / Δpitch 2.0°·ny / Δpos (0.30nx, −0.20ny, 0) u
 * - prefers-reduced-motion: ドリフト t を凍結+視差無効(世界の演出は継続)
 * - 水面下防止: y(t) − Δpos.y の最小値 3.74 > 0 で構造的に潜らない
 */
export class CameraRig {
  public readonly camera: PerspectiveCamera;

  private readonly parallaxAllowed: boolean;
  private pointerX = 0;
  private pointerY = 0;
  private smoothX = 0;
  private smoothY = 0;
  private reducedMotion = false;
  private lastTimeSec: number | undefined;

  private readonly target = new Vector3();
  private readonly media: MediaQueryList | undefined;
  private readonly onMediaChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointerX = (event.clientX / window.innerWidth) * 2 - 1;
    this.pointerY = (event.clientY / window.innerHeight) * 2 - 1;
  };

  constructor(options: CameraRigOptions) {
    this.camera = new PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      1200,
    );
    this.parallaxAllowed = options.parallax;

    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.media.matches;
    this.media.addEventListener('change', this.onMediaChange);

    if (this.parallaxAllowed) {
      window.addEventListener('pointermove', this.onPointerMove);
    }
  }

  public update(timeSec: number): void {
    const dt = Math.min(
      Math.max(timeSec - (this.lastTimeSec ?? timeSec), 0),
      0.1,
    );
    this.lastTimeSec = timeSec;

    const t = this.reducedMotion ? REDUCED_MOTION_FREEZE_T : timeSec;

    // 基準軌道(周期はすべて非整数比 — 240/97/61/91/53/73 s)
    const azimuth = (TWO_PI * t) / 240;
    const radius = 10.0 + 0.8 * Math.sin((TWO_PI * t) / 97);
    const height = 4.6 + 0.6 * Math.sin((TWO_PI * t) / 61 + 1.3);
    this.target.set(
      0.4 * Math.sin((TWO_PI * t) / 91),
      3.7 + 0.25 * Math.sin((TWO_PI * t) / 53),
      0.4 * Math.cos((TWO_PI * t) / 73),
    );

    // 視差の指数追従(k はフレームレート非依存)
    const useParallax = this.parallaxAllowed && !this.reducedMotion;
    const k = 1 - Math.exp(-dt / PARALLAX_TAU_S);
    const targetX = useParallax ? this.pointerX : 0;
    const targetY = useParallax ? this.pointerY : 0;
    this.smoothX += (targetX - this.smoothX) * k;
    this.smoothY += (targetY - this.smoothY) * k;

    this.camera.position.set(
      radius * Math.sin(azimuth),
      height,
      radius * Math.cos(azimuth),
    );
    this.camera.lookAt(this.target);
    this.camera.rotateY(-3.5 * DEG * this.smoothX);
    this.camera.rotateX(-2.0 * DEG * this.smoothY);
    this.camera.translateX(0.3 * this.smoothX);
    this.camera.translateY(-0.2 * this.smoothY);
    this.camera.updateMatrixWorld();
  }

  public setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  public dispose(): void {
    this.media?.removeEventListener('change', this.onMediaChange);
    if (this.parallaxAllowed) {
      window.removeEventListener('pointermove', this.onPointerMove);
    }
  }
}
