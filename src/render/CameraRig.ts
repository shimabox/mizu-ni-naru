import { PerspectiveCamera, Vector3 } from 'three';

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/** 視差の平滑時定数(フレームレート非依存の指数追従 — design-render §8)。 */
const PARALLAX_TAU_S = 0.45;
/** reduced-motion 時にドリフトを凍結する t(良構図の秒)。 */
const REDUCED_MOTION_FREEZE_T = 12;

/* ── オービット操作(A28)───────────────────────────────── */
/** 操作終了から自動ドリフトへの復帰を始めるまでのアイドル秒。 */
const IDLE_RETURN_DELAY_S = 5;
/** 復帰ブレンドの時定数(指数減衰 — 位置ジャンプなしで軌道に合流)。 */
const RETURN_TAU_S = 1.8;
/** ドラッグ感度(rad/px)。フル HD 幅ドラッグで ≈ 半周。 */
const ORBIT_RAD_PER_PX = 0.005;
/** ホイール 1 ノッチ(≈100)で距離 ≈ ×1.13。 */
const ZOOM_LOG_PER_WHEEL = 0.0012;
/** ズーム距離クランプ(u)。下限は外リング(6.5 + R_MAX)の球に潜り込まない距離、上限は海が主役のまま。 */
const DIST_MIN = 9.0;
const DIST_MAX = 28;
/** 極角クランプ(rad)。上限は水面下潜行防止と併用(camera y ≥ MIN_CAMERA_Y)。 */
const POLAR_MIN = 0.15;
const POLAR_MAX = Math.PI * 0.58;
/** カメラ最低高度(u)。スウェル最大振幅 + 余裕(構造的に潜らない)。 */
const MIN_CAMERA_Y = 1.2;

export interface CameraRigOptions {
  /** false でマウス視差・ドラッグ/ズーム操作を無効化(`?m=1` — 決定論軌道)。 */
  readonly parallax: boolean;
  /** ポインタ/ホイールイベントの取得元(通常は canvas)。 */
  readonly domElement?: HTMLElement;
}

/**
 * 自動漂流カメラ + ドラッグオービット(design-render §8 + 裁定 A28)。
 *
 * - 基準軌道はリサージュ的(非整数比の周期で永久に非反復)。
 *   t はウォールクロックではなく timeSec = stepF/60(sim 停止=カメラ停止)
 * - ドラッグでオービット(方位+極角のオフセット)、ホイール/ピンチでズーム
 *   (対数距離オフセット)。パン無効。操作をやめて ≈5 s 後、オフセットを
 *   指数減衰させて自動ドリフト軌道へ滑らかに合流する(位置ジャンプなし —
 *   OrbitControls は autoRotate しか再開できず本作のリサージュ軌道に
 *   合流できないため自前実装)
 * - マウス視差: Δyaw 3.5°·nx / Δpitch 2.0°·ny / Δpos (0.30nx, −0.20ny, 0) u。
 *   操作中〜復帰完了までは無効(非操作時のみ — A28)
 * - prefers-reduced-motion: ドリフト t を凍結+視差無効(従来どおり)。
 *   ドラッグはユーザー起点の操作なので許可
 * - 水面下防止: 基準軌道は y(t) − Δpos.y 最小 4.5 で構造的に潜らず、操作時は
 *   極角クランプ + camera y ≥ 1.2 の距離依存クランプで保証
 */
export class CameraRig {
  public readonly camera: PerspectiveCamera;

  private readonly parallaxAllowed: boolean;
  private readonly domElement: HTMLElement | undefined;
  private pointerX = 0;
  private pointerY = 0;
  private smoothX = 0;
  private smoothY = 0;
  private reducedMotion = false;
  private lastTimeSec: number | undefined;
  /** 縦画面フレーミング(A21 — アスペクト<0.75 で基準距離/高さを詰める)。 */
  private portraitBlend = 0;

  // ── オービットオフセット(自動軌道との差分 — 復帰時に 0 へ減衰)
  private offAz = 0;
  private offPol = 0;
  private offLogDist = 0;
  private idleSec = Number.POSITIVE_INFINITY; // 起動時は「操作なし」扱い
  /** アクティブポインタ(pointerId → 最終座標)。2 本でピンチズーム。 */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  private readonly target = new Vector3();
  private readonly media: MediaQueryList | undefined;
  private readonly onMediaChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointerX = (event.clientX / window.innerWidth) * 2 - 1;
    this.pointerY = (event.clientY / window.innerHeight) * 2 - 1;
  };

  // ── ドラッグオービット / ピンチズーム(A28)
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.pointers.size >= 2) return;
    try {
      this.domElement?.setPointerCapture(event.pointerId);
    } catch {
      // 一部のモバイルブラウザ/合成入力ではアクティブポインタ未認識で
      // NotFoundError を投げることがある(捕捉のみで機能に影響なし —
      // capture が取れなくてもオービット自体は pointermove で機能する)
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      this.pinchDist = this.currentPinchDist();
    }
    this.idleSec = 0;
  };
  private readonly onDragMove = (event: PointerEvent): void => {
    const p = this.pointers.get(event.pointerId);
    if (!p) return;
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    p.x = event.clientX;
    p.y = event.clientY;
    if (this.pointers.size === 2) {
      // ピンチズーム(2 本指はオービットしない)
      const d = this.currentPinchDist();
      if (this.pinchDist > 1 && d > 1) {
        this.offLogDist += Math.log(this.pinchDist / d);
      }
      this.pinchDist = d;
    } else {
      this.offAz -= dx * ORBIT_RAD_PER_PX;
      this.offPol -= dy * ORBIT_RAD_PER_PX;
    }
    this.idleSec = 0;
  };
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.pointers.delete(event.pointerId)) {
      this.idleSec = 0;
      this.pinchDist = 0;
    }
  };
  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.offLogDist += event.deltaY * ZOOM_LOG_PER_WHEEL;
    this.idleSec = 0;
  };

  constructor(options: CameraRigOptions) {
    this.camera = new PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      1200,
    );
    this.parallaxAllowed = options.parallax;
    this.domElement = options.domElement;

    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.media.matches;
    this.media.addEventListener('change', this.onMediaChange);

    if (this.parallaxAllowed) {
      window.addEventListener('pointermove', this.onPointerMove);
      const el = this.domElement;
      if (el) {
        el.style.touchAction = 'none'; // 1 本指オービット / ピンチをブラウザに取られない
        el.addEventListener('pointerdown', this.onPointerDown);
        el.addEventListener('pointermove', this.onDragMove);
        el.addEventListener('pointerup', this.onPointerUp);
        el.addEventListener('pointercancel', this.onPointerUp);
        el.addEventListener('wheel', this.onWheel, { passive: false });
      }
    }
  }

  public update(timeSec: number): void {
    const dt = Math.min(
      Math.max(timeSec - (this.lastTimeSec ?? timeSec), 0),
      0.1,
    );
    this.lastTimeSec = timeSec;

    const t = this.reducedMotion ? REDUCED_MOTION_FREEZE_T : timeSec;

    // 基準軌道(周期はすべて非整数比 — 240/97/61/91/53/73 s)。
    // 基準距離 13.2 は外リング 6.5 + R_MAX 1.7 の再フレーミング(A30 — 旧 10.0 を
    // リング拡大比 ≈8.2/6.2 でスケール)。全球収容は非目標(A21 — 海が主役)。
    // 縦画面(portraitBlend>0)は距離を詰め・注視点をやや低く・高さを抑えて
    // 「海+数球」が窮屈にならない構図にする(全リング収容は非目標のまま)
    const pb = this.portraitBlend;
    const azimuth = (TWO_PI * t) / 240;
    const radius = (13.2 + 1.0 * Math.sin((TWO_PI * t) / 97)) * (1 - 0.42 * pb);
    const height =
      (5.4 + 0.7 * Math.sin((TWO_PI * t) / 61 + 1.3)) * (1 - 0.3 * pb);
    this.target.set(
      0.5 * Math.sin((TWO_PI * t) / 91),
      (4.0 + 0.25 * Math.sin((TWO_PI * t) / 53)) * (1 - 0.35 * pb),
      0.5 * Math.cos((TWO_PI * t) / 73),
    );

    // ── オービットオフセットの適用と復帰(A28)
    const interacting = this.pointers.size > 0;
    if (!interacting) this.idleSec += dt;
    if (this.idleSec >= IDLE_RETURN_DELAY_S) {
      // 現在角度から軌道へ指数ブレンド(位置ジャンプなし)
      const k = 1 - Math.exp(-dt / RETURN_TAU_S);
      this.offAz -= this.offAz * k;
      this.offPol -= this.offPol * k;
      this.offLogDist -= this.offLogDist * k;
    }
    // 基準軌道の球面座標(target 基準)+ オフセット
    const dirX = radius * Math.sin(azimuth) - this.target.x;
    const dirY = height - this.target.y;
    const dirZ = radius * Math.cos(azimuth) - this.target.z;
    const baseDist = Math.hypot(dirX, dirY, dirZ);
    const basePol = Math.acos(Math.min(Math.max(dirY / baseDist, -1), 1));
    const baseAz = Math.atan2(dirX, dirZ);
    const az = baseAz + this.offAz;
    // 縦画面は基準距離を詰めるため DIST_MIN も比例して下げる(A21 の
    // portraitBlend スケーリングが下限クランプで打ち消されないように)
    const distMin = DIST_MIN * (1 - 0.42 * pb);
    const dist = Math.min(
      Math.max(baseDist * Math.exp(this.offLogDist), distMin),
      DIST_MAX,
    );
    this.offLogDist = Math.log(dist / baseDist); // クランプ分の巻き戻し(windup 防止)
    // 極角: 帯クランプ + 水面下防止(camera y = target.y + dist·cosθ ≥ MIN_CAMERA_Y)
    const polSurface = Math.acos(
      Math.min(Math.max((MIN_CAMERA_Y - this.target.y) / dist, -1), 1),
    );
    const pol = Math.min(
      Math.max(basePol + this.offPol, POLAR_MIN),
      Math.min(POLAR_MAX, polSurface),
    );
    this.offPol = pol - basePol;

    // 視差の指数追従(k はフレームレート非依存)。操作中〜復帰完了までは無効
    const manual =
      interacting ||
      Math.abs(this.offAz) + Math.abs(this.offPol) + Math.abs(this.offLogDist) >
        1e-3;
    const useParallax = this.parallaxAllowed && !this.reducedMotion && !manual;
    const k = 1 - Math.exp(-dt / PARALLAX_TAU_S);
    const targetX = useParallax ? this.pointerX : 0;
    const targetY = useParallax ? this.pointerY : 0;
    this.smoothX += (targetX - this.smoothX) * k;
    this.smoothY += (targetY - this.smoothY) * k;

    const sinPol = Math.sin(pol);
    this.camera.position.set(
      this.target.x + dist * sinPol * Math.sin(az),
      this.target.y + dist * Math.cos(pol),
      this.target.z + dist * sinPol * Math.cos(az),
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
    // A21: アスペクト 0.75(閾値)〜0.5(典型スマホ縦持ち)で 0→1 に線形ブレンド。
    // 全リング収容は非目標 — 「海 + 数球」が気持ちよく入る構図を優先する
    this.portraitBlend = Math.min(
      Math.max((0.75 - aspect) / (0.75 - 0.5), 0),
      1,
    );
  }

  public dispose(): void {
    this.media?.removeEventListener('change', this.onMediaChange);
    if (this.parallaxAllowed) {
      window.removeEventListener('pointermove', this.onPointerMove);
      const el = this.domElement;
      if (el) {
        el.removeEventListener('pointerdown', this.onPointerDown);
        el.removeEventListener('pointermove', this.onDragMove);
        el.removeEventListener('pointerup', this.onPointerUp);
        el.removeEventListener('pointercancel', this.onPointerUp);
        el.removeEventListener('wheel', this.onWheel);
      }
    }
  }

  private currentPinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
