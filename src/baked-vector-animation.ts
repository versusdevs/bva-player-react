/**
 * BakedVectorPlayer
 *
 * Plays a Baked Vector Animation (BVA): per-frame 2D affine matrices baked
 * out of a Lottie source at build time, mounted as plain SVG `<g>` elements
 * at runtime. The format is rig-agnostic - any rig (character, prop,
 * crowd, ...) baked by `bva-baker-js` plays here.
 *
 * Input layout (produced by the bake pipeline):
 *   <rig>/
 *     <rig>.bva                  # shared motion: per-frame matrices (+
 *                                #   optional opacity / fill / stroke) per
 *                                #   part per segment
 *     assets/
 *       <rig>.svg.json           # layer file: skins._common + named skins
 *
 * At runtime the player composes a single <svg> per instance, mounts one
 * <g transform="matrix(...)"> per part with the bundle's paths inlined, and
 * on each frame just updates the `transform` / `opacity` / optional `fill`
 * / `stroke` attributes - no Lottie math, no per-property keyframe
 * evaluation, no per-part HTTP fetches.
 */

import {
  isCullable,
  isReferencedContainer,
  partLocalRadius,
} from './gamefield/shapeSize';

export type Matrix6 = [number, number, number, number, number, number];

export interface MotionPart {
  asset: string;
  matrices: Matrix6[];
  /** Per-frame opacity 0–1, parallel to `matrices`. Defaults to 1 when absent. */
  opacities?: number[];
  /** Per-frame fill `#RRGGBB`, parallel to `matrices`. Absent = keep artwork. */
  fills?: string[];
  /** Per-frame stroke `#RRGGBB`, parallel to `matrices`. Absent = keep artwork. */
  strokes?: string[];
}

export interface MotionSegment {
  frames: number;
  parts: MotionPart[]; // back-to-front draw order
}

export interface MotionData {
  /**
   * Wire-format version read from the file's `##version` header. Older
   * payloads without the header parse as 0.
   */
  version: number;
  fps: number;
  srcFps?: number;
  canvas: { w: number; h: number };
  stage: Matrix6;
  segments: Record<string, MotionSegment>;
  /**
   * Optional `alias → target` map from the additive `#aliases` header.
   * Resolved into `segments` after parse (same object reference, no copy).
   */
  aliases?: Record<string, string>;
}

/**
 * Highest `.bva` wire-format version this build understands. Bumped in
 * lockstep with `BVA_VERSION` in `bva-baker-js/lib/motion-text.mjs` whenever
 * the on-disk encoding changes incompatibly.
 */
export const BVA_VERSION = 3;

const SHAPE_SELECTOR =
  'path,rect,ellipse,circle,polygon,polyline,line';

const SHAPE_TAGS = new Set(SHAPE_SELECTOR.split(','));

export interface AssetPart {
  viewBox: string;
  width: number;
  height: number;
  body: string; // inner SVG markup
  /**
   * Farthest distance from the part's local origin across its shapes, in
   * local units. The part matrix rotates about that origin, so this is the
   * lever arm {@link BakedVectorPlayer.setVisibilityScale} uses to turn a
   * change in `a,b,c,d` into on-screen movement. Absent on legacy bundles.
   */
  localRadius?: number;
  /**
   * Shape elements resolution-aware culling removed from this part, counted
   * across dropped subtrees. `0` when culling was off or nothing was small
   * enough. Reported by the field HUD against the shapes that survived.
   */
  culledShapes?: number;
}

export interface AssetBundle {
  name: string;
  parts: Record<string, AssetPart>;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Single requestAnimationFrame loop shared across every BakedVectorPlayer
 * instance. With per-instance RAFs a crowd-style scene (e.g. 100 audience
 * characters) would schedule 100 separate callbacks per frame; here all
 * subscribers tick from the same `now`, so the browser only needs to wake
 * once per frame and we keep just one outstanding RAF id.
 *
 * Subscribers are invoked in insertion order. A subscriber may unsubscribe
 * itself (or another subscriber) from inside its own callback - the loop
 * snapshots the subscriber list before iterating.
 */
type TickFn = (now: number) => void;

const SharedTicker = (() => {
  const subs = new Set<TickFn>();
  let raf = 0;

  const loop = (now: number): void => {
    raf = 0;
    // Snapshot so add/remove during iteration don't disturb this frame.
    const snapshot = Array.from(subs);
    for (const fn of snapshot) {
      // A previous callback may have removed this one; respect that.
      if (subs.has(fn)) fn(now);
    }
    if (subs.size > 0) raf = requestAnimationFrame(loop);
  };

  return {
    add(fn: TickFn): void {
      subs.add(fn);
      if (raf === 0) raf = requestAnimationFrame(loop);
    },
    remove(fn: TickFn): void {
      subs.delete(fn);
      if (subs.size === 0 && raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
  };
})();

export interface PlayOptions {
  loop?: boolean;
  onComplete?: () => void;
  onEnterFrame?: (frame: number) => void;
}

export interface BakedVectorPlayerOptions {
  /** Initial segment to display. Defaults to the first segment in motion. */
  initialSegment?: string;
  /** preserveAspectRatio attribute. Defaults to 'xMidYMid meet'. */
  preserveAspectRatio?: string;
  /**
   * Drive playback off the process-wide `SharedTicker` (default true). Set
   * to false to give this instance its own `requestAnimationFrame` loop -
   * useful for A/B benchmarking the two scheduling strategies.
   */
  useSharedTicker?: boolean;
}

export class BakedVectorPlayer {
  private motion: MotionData;
  private bundle: AssetBundle;

  private svg: SVGSVGElement;
  private stageG: SVGGElement;
  // `last` holds the matrix entries last written to the DOM, each multiplied
  // by the part's quantizer and rounded to an integer. Comparing integers
  // avoids both the float-equality and the per-frame string-build cost when
  // the rounded matrix has not changed since the last applied frame.
  //
  // `qT` quantizes the translation columns and `qL` the linear columns
  // (`a,b,c,d`). Both default to 100 — two decimal places, scale-blind — and
  // are replaced by {@link setVisibilityScale} with values derived from how
  // large the rig actually is on screen, so a change that moves no device
  // pixel rounds to the same integers and is never written.
  //
  // `lastOpacity` is the last opacity written (rounded to 2 decimals).
  // `lastFill` / `lastStroke` are the last `#RRGGBB` strings written to shape
  // children.
  private parts: Array<{
    g: SVGGElement;
    shapes: Element[];
    matrices: Matrix6[];
    opacities?: number[];
    fills?: string[];
    strokes?: string[];
    last: Matrix6 | null;
    lastOpacity: number | null;
    lastFill: string | null;
    lastStroke: string | null;
    localRadius: number | undefined;
    culledShapes: number;
    qT: number;
    qL: number;
  }> = [];

  /** Device pixels per canvas unit for this instance; `0` until told. */
  private visibilityPxPerCanvasUnit = 0;
  /** Movement below this many device pixels is treated as invisible. */
  private visibilityThresholdPx = 1;

  private currentSegment: string;
  private currentFrame = 0;
  private playing = false;
  private loop = true;
  private speed = 1;
  private lastTick = 0;
  private frameAccumMs = 0;
  private onComplete: (() => void) | null = null;
  private onEnterFrame: ((f: number) => void) | null = null;

  // Scheduler choice is fixed at construction time: switching mid-playback
  // would risk a tick scheduled by one strategy while the other thinks it
  // owns the loop. `raf` is only used in private-ticker mode.
  private useSharedTicker: boolean;
  private raf = 0;

  constructor(
    container: HTMLElement,
    motion: MotionData,
    bundle: AssetBundle,
    opts: BakedVectorPlayerOptions = {},
  ) {
    this.motion = motion;
    this.bundle = bundle;
    this.useSharedTicker = opts.useSharedTicker ?? true;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('viewBox', `0 0 ${motion.canvas.w} ${motion.canvas.h}`);
    svg.setAttribute(
      'preserveAspectRatio',
      opts.preserveAspectRatio ?? 'xMidYMid meet',
    );
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';

    const stageG = document.createElementNS(SVG_NS, 'g');
    stageG.setAttribute('transform', matrixAttr(motion.stage));
    svg.appendChild(stageG);

    container.innerHTML = '';
    container.appendChild(svg);

    this.svg = svg;
    this.stageG = stageG;

    const initial =
      opts.initialSegment ?? Object.keys(motion.segments)[0] ?? '';
    this.currentSegment = initial;
    if (initial) this.setSegment(initial);
  }

  // --- public API ---

  /** Swap the visual variant (skin, color set, ...) without restarting time. */
  setBundle(bundle: AssetBundle): void {
    this.bundle = bundle;
    this.rebuildParts();
    this.applyFrame();
  }

  setSegment(name: string): void {
    if (!this.motion.segments[name]) return;
    this.currentSegment = name;
    this.currentFrame = 0;
    this.rebuildParts();
    this.applyFrame();
  }

  /**
   * Tell the player how small it is being drawn, so it can stop writing poses
   * that move nothing.
   *
   * `devicePxPerCanvasUnit` is how many device pixels one canvas unit covers
   * for *this* instance — the field's fit scale times `devicePixelRatio` times
   * any scale applied to the rig by its placement. `thresholdPx` is the
   * movement considered invisible (1 device pixel by default).
   *
   * A SmartBVA master ticks once for every copy that references it, so callers
   * must pass the scale of its *largest* copy; anything smaller would make the
   * near copies choppy.
   *
   * Passing `0` restores the scale-blind two-decimal behaviour.
   */
  setVisibilityScale(devicePxPerCanvasUnit: number, thresholdPx = 1): void {
    const px =
      Number.isFinite(devicePxPerCanvasUnit) && devicePxPerCanvasUnit > 0
        ? devicePxPerCanvasUnit
        : 0;
    const threshold =
      Number.isFinite(thresholdPx) && thresholdPx > 0 ? thresholdPx : 1;
    if (
      px === this.visibilityPxPerCanvasUnit &&
      threshold === this.visibilityThresholdPx
    ) {
      return;
    }
    this.visibilityPxPerCanvasUnit = px;
    this.visibilityThresholdPx = threshold;
    for (const part of this.parts) {
      const q = this.quantizersFor(part.localRadius);
      part.qT = q.qT;
      part.qL = q.qL;
      // Whatever is in `last` was rounded with the old quantizer, so it is not
      // comparable now. Drop it and let the next frame re-establish it.
      part.last = null;
    }
    this.applyFrame();
  }

  play(segment?: string, opts: PlayOptions = {}): void {
    if (segment) this.setSegment(segment);
    this.loop = !!opts.loop;
    this.onComplete = opts.onComplete ?? null;
    this.onEnterFrame = opts.onEnterFrame ?? null;
    this.playing = true;
    this.lastTick = performance.now();
    this.frameAccumMs = 0;
    this.schedule();
  }

  pause(): void {
    this.playing = false;
    this.unschedule();
  }

  setSpeed(s: number): void {
    this.speed = s;
  }

  gotoFrame(f: number): void {
    const seg = this.motion.segments[this.currentSegment];
    if (!seg) return;
    this.currentFrame = Math.max(0, Math.min(seg.frames - 1, f | 0));
    this.applyFrame();
  }

  getSegment(): string {
    return this.currentSegment;
  }
  getFrame(): number {
    return this.currentFrame;
  }
  getSegmentFrames(): number {
    return this.motion.segments[this.currentSegment]?.frames ?? 0;
  }
  getSegments(): string[] {
    return Object.keys(this.motion.segments);
  }
  getSvg(): SVGSVGElement {
    return this.svg;
  }
  /** Mounted SVG parts that receive per-frame motion. */
  getPartCount(): number {
    return this.parts.length;
  }

  /**
   * Shape elements currently mounted across every part, and the ones
   * resolution-aware culling removed to get there.
   *
   * Per rig, not per draw — a SmartBVA master still reports one copy of its
   * shapes. The field census multiplies by visible `<use>` count so the HUD
   * shows every painted instance, moving or still.
   */
  getShapeCounts(): { mounted: number; culled: number } {
    let mounted = 0;
    let culled = 0;
    for (const part of this.parts) {
      mounted += part.shapes.length;
      culled += part.culledShapes;
    }
    return { mounted, culled };
  }

  destroy(): void {
    this.pause();
    this.svg.remove();
    this.parts = [];
  }

  // --- internals ---

  private quantizersFor(localRadius: number | undefined): Quantizers {
    return visibilityQuantizers(
      this.motion.stage,
      this.visibilityPxPerCanvasUnit,
      this.visibilityThresholdPx,
      localRadius,
    );
  }

  private rebuildParts(): void {
    this.stageG.textContent = '';
    this.parts = [];
    const seg = this.motion.segments[this.currentSegment];
    if (!seg) return;

    for (const part of seg.parts) {
      const assetPart = this.bundle.parts[part.asset];
      if (!assetPart) continue; // bundle missing this asset; skip silently

      const g = document.createElementNS(SVG_NS, 'g');
      const m0 = part.matrices[0];
      const o0 = part.opacities?.[0] ?? 1;
      const f0 = part.fills?.[0] ?? null;
      const s0 = part.strokes?.[0] ?? null;
      g.setAttribute('transform', matrixAttr(m0));
      // Always present: adding/removing opacity rebuilds the effect node
      // and forces a full document layerization (o0 flag/scarf/hand toggles).
      g.setAttribute('opacity', String(o0));
      // Motion matrices were baked assuming the part's local image is drawn
      // at its native viewBox origin. The bundle's inner SVG markup uses
      // those same coordinates, so the outer matrix lands them correctly.
      g.innerHTML = assetPart.body;
      const shapes = Array.from(g.querySelectorAll(SHAPE_SELECTOR));
      if (f0) setPaintAttrs(shapes, 'fill', f0);
      if (s0) setPaintAttrs(shapes, 'stroke', s0);
      this.stageG.appendChild(g);
      const { qT, qL } = this.quantizersFor(assetPart.localRadius);
      // Seed `last` with the matrix we just wrote so the immediate
      // applyFrame() following rebuildParts() doesn't re-write frame 0.
      this.parts.push({
        g,
        shapes,
        matrices: part.matrices,
        opacities: part.opacities,
        fills: part.fills,
        strokes: part.strokes,
        last: roundMatrix(m0, qT, qL),
        lastOpacity: roundOpacity(o0),
        lastFill: f0,
        lastStroke: s0,
        localRadius: assetPart.localRadius,
        culledShapes: assetPart.culledShapes ?? 0,
        qT,
        qL,
      });
    }
  }

  private applyFrame(): void {
    const idx = this.currentFrame;
    for (const part of this.parts) {
      const m = part.matrices[idx] ?? part.matrices[part.matrices.length - 1];
      const opacity =
        part.opacities?.[idx] ??
        part.opacities?.[part.opacities.length - 1] ??
        1;
      const fill =
        part.fills?.[idx] ??
        part.fills?.[part.fills.length - 1] ??
        null;
      const stroke =
        part.strokes?.[idx] ??
        part.strokes?.[part.strokes.length - 1] ??
        null;
      const qL = part.qL;
      const qT = part.qT;
      const r0 = Math.round(m[0] * qL);
      const r1 = Math.round(m[1] * qL);
      const r2 = Math.round(m[2] * qL);
      const r3 = Math.round(m[3] * qL);
      const r4 = Math.round(m[4] * qT);
      const r5 = Math.round(m[5] * qT);
      const ro = roundOpacity(opacity);
      const last = part.last;
      const matrixSame =
        last !== null &&
        last[0] === r0 &&
        last[1] === r1 &&
        last[2] === r2 &&
        last[3] === r3 &&
        last[4] === r4 &&
        last[5] === r5;
      const opacitySame = part.lastOpacity !== null && part.lastOpacity === ro;
      const fillSame = fill === null || part.lastFill === fill;
      const strokeSame = stroke === null || part.lastStroke === stroke;
      if (matrixSame && opacitySame && fillSame && strokeSame) continue;

      if (!matrixSame) {
        part.g.setAttribute('transform', matrixAttr(m));
        if (last !== null) {
          last[0] = r0;
          last[1] = r1;
          last[2] = r2;
          last[3] = r3;
          last[4] = r4;
          last[5] = r5;
        } else {
          part.last = [r0, r1, r2, r3, r4, r5];
        }
      }
      if (!opacitySame) {
        part.g.setAttribute('opacity', String(opacity));
        part.lastOpacity = ro;
      }
      if (!fillSame && fill !== null) {
        setPaintAttrs(part.shapes, 'fill', fill);
        part.lastFill = fill;
      }
      if (!strokeSame && stroke !== null) {
        setPaintAttrs(part.shapes, 'stroke', stroke);
        part.lastStroke = stroke;
      }
    }
    this.onEnterFrame?.(idx);
  }

  // Pure per-frame work. Re-arming is the scheduler's job (SharedTicker
  // auto-loops; the private RAF wrapper re-requests itself).
  private tick = (now: number): void => {
    if (!this.playing) {
      this.unschedule();
      return;
    }
    const dt = now - this.lastTick;
    this.lastTick = now;
    this.frameAccumMs += dt * this.speed;

    const frameDuration = 1000 / this.motion.fps;
    const seg = this.motion.segments[this.currentSegment];
    if (!seg) {
      this.playing = false;
      this.unschedule();
      return;
    }

    let advanced = false;
    while (this.frameAccumMs >= frameDuration) {
      this.frameAccumMs -= frameDuration;
      this.currentFrame++;
      advanced = true;
      if (this.currentFrame >= seg.frames) {
        if (this.loop) {
          this.currentFrame = 0;
        } else {
          this.currentFrame = seg.frames - 1;
          this.playing = false;
          this.applyFrame();
          this.unschedule();
          this.onComplete?.();
          return;
        }
      }
    }
    if (advanced) this.applyFrame();
  };

  // --- scheduler glue ---

  private schedule(): void {
    if (this.useSharedTicker) {
      SharedTicker.add(this.tick);
    } else if (this.raf === 0) {
      this.raf = requestAnimationFrame(this.privateTickStep);
    }
  }

  private unschedule(): void {
    if (this.useSharedTicker) {
      SharedTicker.remove(this.tick);
    } else if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  // Private-ticker mode: each instance owns its own RAF chain. Used only
  // when the caller passes `useSharedTicker: false` - typically for
  // benchmarking against the shared scheduler.
  private privateTickStep = (now: number): void => {
    this.raf = 0;
    this.tick(now);
    if (this.playing && !this.useSharedTicker) {
      this.raf = requestAnimationFrame(this.privateTickStep);
    }
  };
}

function matrixAttr(m: Matrix6): string {
  return `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4]},${m[5]})`;
}

/** Scale-blind fallback: two decimal places, the pre-visibility-scale behaviour. */
const DEFAULT_QUANTIZER = 100;

function roundMatrix(m: Matrix6, qT: number, qL: number): Matrix6 {
  return [
    Math.round(m[0] * qL),
    Math.round(m[1] * qL),
    Math.round(m[2] * qL),
    Math.round(m[3] * qL),
    Math.round(m[4] * qT),
    Math.round(m[5] * qT),
  ];
}

/**
 * Largest scale factor the stage matrix applies, as an upper bound on how far
 * one stage-local unit reaches on the canvas.
 */
function stageScale(stage: Matrix6): number {
  const sx = Math.hypot(stage[0], stage[1]);
  const sy = Math.hypot(stage[2], stage[3]);
  const scale = Math.max(sx, sy);
  return scale > 0 ? scale : 1;
}

export interface Quantizers {
  /** Rounding factor for the translation columns (`e,f`). */
  qT: number;
  /** Rounding factor for the linear columns (`a,b,c,d`). */
  qL: number;
}

/**
 * Rounding factors that collapse sub-threshold movement for one part.
 *
 * A part matrix lives under the stage matrix, so its translation is in
 * stage-local units, and one such unit covers `devicePxPerCanvasUnit *
 * stageScale` device pixels. The linear columns are angular: a point
 * `localRadius` from the part's origin travels that much further for the same
 * change, so it multiplies the factor. Dividing by the threshold makes one
 * integer step equal one threshold of visible movement, so `Math.round` on the
 * product collapses anything smaller.
 *
 * `devicePxPerCanvasUnit <= 0` means "scale unknown" and yields the original
 * scale-blind two-decimal rounding.
 */
export function visibilityQuantizers(
  stage: Matrix6,
  devicePxPerCanvasUnit: number,
  thresholdPx: number,
  localRadius: number | undefined,
): Quantizers {
  if (!(devicePxPerCanvasUnit > 0) || !(thresholdPx > 0)) {
    return { qT: DEFAULT_QUANTIZER, qL: DEFAULT_QUANTIZER };
  }
  const perStageUnit =
    (devicePxPerCanvasUnit * stageScale(stage)) / thresholdPx;
  return {
    qT: perStageUnit,
    // Legacy bundles carry no measured radius; keep them scale-blind rather
    // than guess a lever arm and risk visibly freezing a rotation.
    qL:
      localRadius === undefined
        ? DEFAULT_QUANTIZER
        : perStageUnit * localRadius,
  };
}

function roundOpacity(o: number): number {
  return Math.round(o * 100);
}

function setPaintAttrs(
  shapes: Element[],
  attr: 'fill' | 'stroke',
  value: string,
): void {
  for (let i = 0; i < shapes.length; i++) {
    shapes[i].setAttribute(attr, value);
  }
}

// --- loader helpers (process-wide cache, dedupes network requests) ---

const motionCache: Map<string, Promise<MotionData>> = new Map();
/** Raw JSON fetch, keyed by URL only — skins share one download and parse. */
const rawBundleCache: Map<string, Promise<unknown>> = new Map();
/** Resolved `AssetBundle`, keyed by URL + skin + variables. */
const bundleCache: Map<string, Promise<AssetBundle>> = new Map();

/** The segment `name` plays, or a fallback / first clip if it is missing. */
export function resolveSegmentName(
  motion: MotionData,
  name: string,
): string | undefined {
  if (motion.segments[name]) return name
  const alias = motion.aliases?.[name]
  if (alias && motion.segments[alias]) return alias
  const first = Object.keys(motion.segments)[0]
  return first || undefined
}

/**
 * Load a motion file. The format is auto-detected from the URL extension:
 *   - `.bva`  -> compact text layout produced by `bva-baker-js`.
 *   - `.json` -> raw JSON layout (legacy / debugging).
 */
export function loadMotion(url: string): Promise<MotionData> {
  let p = motionCache.get(url);
  if (!p) {
    const isText = /\.bva(\?|$)/i.test(url);
    p = fetch(url)
      .then((r) => {
        if (!r.ok)
          throw new Error(`Failed to load motion: ${url} (${r.status})`);
        return isText
          ? r.text().then(parseMotionText)
          : (r.json() as Promise<MotionData>);
      })
      .catch((err) => {
        motionCache.delete(url);
        throw err;
      });
    motionCache.set(url, p);
  }
  return p;
}

/**
 * Parse the `.bva` text format. Inverse of `bva-baker-js/lib/motion-text.mjs`.
 *
 * Format quick reference:
 *   - `#tag` then a value line (or `#segments` to enter the segments block).
 *   - `##segName` opens a segment, `####partName` opens a part inside it.
 *   - Inside a part each line is one frame, written REVERSED (column 5 first,
 *     column 0 last) so that what would otherwise be a leading run of empty
 *     columns becomes a trailing run that we can trim:
 *       on disk:        "720.71,1041.66"           (two fields)
 *       padded to 6:    ["720.71","1041.66","","","",""]
 *       reversed back:  ["","","","","1041.66","720.71"]   (cols 0..5)
 *     So a blank column means "same as previous frame in this column", and
 *     fully-omitted trailing-on-disk fields are simply blanks.
 *       ""             empty line = previous frame repeated once.
 *       "*N"           previous frame repeated N times.
 *   - Numbers may omit the leading "0" ("0.98" / ".98" / "-.17" all parse).
 *   - A field starting with ".." reuses the integer part of the same column
 *     in the previous frame ("..68" with prev 595.28 -> 595.68).
 *   - Optional glued suffixes follow the matrix CSV with no commas, in
 *     fixed order — opacity, then fill, then stroke:
 *       <matrix>[o<opacity>][f<hex>][s<hex>]
 *       "827.41,833.24,.27,0,0,.27o.23fF1F1F1"
 *       "o.5" / "fABC" / "o.5s000" when only those channels change.
 *     Hex is 6 digits, or 3 when each channel pair matches.
 *     Omitted suffix means that channel is unchanged (opacity defaults to 1
 *     on the first frame; fill/stroke stay inactive until first seen).
 *   - Per-segment `frames` count is derived from the data, not stored.
 *   - Legacy `###frames\nN` blocks (older writer) are tolerated and ignored.
 *   - Optional `#aliases` header: `jump_left=hit,jump_right=hit` — resolved
 *     into `segments` after parse (same object, no copy). Additive: older
 *     players skip the unknown tag + value line.
 */
export function parseMotionText(text: string): MotionData {
  const lines = text.split('\n');
  // Drop the trailing empty element produced by the final newline so we
  // don't accidentally turn it into a phantom "repeat last frame" entry.
  if (text.endsWith('\n')) lines.pop();

  const motion: MotionData = {
    version: 0,
    fps: 24,
    canvas: { w: 0, h: 0 },
    stage: [1, 0, 0, 1, 0, 0],
    segments: {},
  };

  let currentSeg: MotionSegment | null = null;
  let currentPart: MotionPart | null = null;
  let prev: Matrix6 | null = null;
  let prevOpacity: number | null = null;
  let prevFill: string | null = null;
  let prevStroke: string | null = null;
  let pendingAliases: Record<string, string> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('####')) {
      currentPart = { asset: line.slice(4), matrices: [], opacities: [] };
      currentSeg!.parts.push(currentPart);
      prev = null;
      prevOpacity = null;
      prevFill = null;
      prevStroke = null;
      continue;
    }

    if (line.startsWith('###')) {
      // ###parts is just a marker. Legacy ###frames is followed by a count
      // line we can safely skip.
      const tag = line.slice(3);
      if (tag === 'frames' && i + 1 < lines.length) i++;
      continue;
    }

    // `##version <N>` is reserved and must be matched BEFORE the generic
    // `##segName` branch, otherwise it would be turned into a phantom
    // segment named "version".
    if (line === '##version') {
      if (i + 1 < lines.length) {
        const v = parseInt(lines[++i], 10);
        if (Number.isFinite(v)) motion.version = v;
      }
      if (motion.version > BVA_VERSION) {
        throw new Error(
          `Unsupported .bva version ${motion.version}; this build understands up to ${BVA_VERSION}.`,
        );
      }
      continue;
    }

    if (line.startsWith('##')) {
      currentSeg = { frames: 0, parts: [] };
      motion.segments[line.slice(2)] = currentSeg;
      currentPart = null;
      prev = null;
      prevOpacity = null;
      prevFill = null;
      prevStroke = null;
      continue;
    }

    if (line.startsWith('#')) {
      const tag = line.slice(1);
      if (tag === 'segments') continue; // entering the segments block
      if (i + 1 >= lines.length) continue;
      const value = lines[++i];
      if (tag === 'fps') motion.fps = parseFloat(value);
      else if (tag === 'srcFps') motion.srcFps = parseFloat(value);
      else if (tag === 'canvas') {
        const [w, h] = value.split(',').map(parseFloat);
        motion.canvas = { w, h };
      } else if (tag === 'stage') {
        motion.stage = value.split(',').map(parseFloat) as Matrix6;
      } else if (tag === 'aliases') {
        pendingAliases = {};
        for (const pair of value.split(',')) {
          const eq = pair.indexOf('=');
          if (eq <= 0) continue;
          const alias = pair.slice(0, eq).trim();
          const target = pair.slice(eq + 1).trim();
          if (alias && target) pendingAliases[alias] = target;
        }
      }
      // unknown tags are silently skipped along with their value
      continue;
    }

    // --- data line for the current part ---

    if (!currentPart) continue; // defensive: data outside any part

    if (line.startsWith('*')) {
      const n = parseInt(line.slice(1), 10);
      if (prev && n > 0) {
        const o = prevOpacity ?? 1;
        for (let k = 0; k < n; k++) {
          pushFrame(currentPart, prev, o, prevFill, prevStroke);
        }
      }
      continue;
    }

    if (line === '') {
      if (prev) {
        pushFrame(
          currentPart,
          prev,
          prevOpacity ?? 1,
          prevFill,
          prevStroke,
        );
      }
      continue;
    }

    const { matrixLine, opacityField, fillField, strokeField } =
      splitFrameSuffixes(line);
    const cols = matrixLine === '' ? [] : matrixLine.split(',');
    // Pad up to 6 then reverse so cols[k] corresponds to original column k.
    while (cols.length < 6) cols.push('');
    cols.reverse();

    const m: Matrix6 = prev
      ? (prev.slice() as Matrix6)
      : [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 6; k++) {
      const c = cols[k];
      if (c === '') continue;
      // "..68" means "same integer part as the previous frame at this column,
      // new fractional part is .68". Only emitted when prev[k] has a positive
      // non-zero integer; see the encoder's compressIntPrefix.
      if (c.charCodeAt(0) === 46 /* '.' */ && c.charCodeAt(1) === 46) {
        m[k] = parseFloat(Math.trunc(m[k]) + '.' + c.slice(2));
      } else {
        m[k] = parseFloat(c);
      }
    }

    let opacity: number = prevOpacity ?? 1;
    if (opacityField !== null) {
      if (
        opacityField.charCodeAt(0) === 46 /* '.' */ &&
        opacityField.charCodeAt(1) === 46
      ) {
        opacity = parseFloat(Math.trunc(opacity) + '.' + opacityField.slice(2));
      } else {
        opacity = parseFloat(opacityField);
      }
    }

    let fillColor: string | null = prevFill;
    if (fillField !== null) {
      fillColor = expandWireHex(fillField);
      if (!currentPart.fills) {
        currentPart.fills = new Array<string>(currentPart.matrices.length).fill(
          fillColor,
        );
      }
    }

    let strokeColor: string | null = prevStroke;
    if (strokeField !== null) {
      strokeColor = expandWireHex(strokeField);
      if (!currentPart.strokes) {
        currentPart.strokes = new Array<string>(
          currentPart.matrices.length,
        ).fill(strokeColor);
      }
    }

    pushFrame(currentPart, m, opacity, fillColor, strokeColor);
    prev = m;
    prevOpacity = opacity;
    prevFill = fillColor;
    prevStroke = strokeColor;
  }

  // Derive frame count per segment from the first part's data.
  for (const seg of Object.values(motion.segments)) {
    seg.frames = seg.parts[0]?.matrices.length ?? 0;
  }

  // Resolve aliases onto the same segment objects (no deep copy).
  if (pendingAliases) {
    motion.aliases = pendingAliases;
    for (const [alias, target] of Object.entries(pendingAliases)) {
      const seg = motion.segments[target];
      if (!seg) {
        throw new Error(
          `.bva alias "${alias}" → "${target}" but segment "${target}" is missing.`,
        );
      }
      if (!motion.segments[alias]) {
        motion.segments[alias] = seg;
      }
    }
  }

  return motion;
}

function pushFrame(
  part: MotionPart,
  matrix: Matrix6,
  opacity: number,
  fill: string | null,
  stroke: string | null,
): void {
  part.matrices.push(matrix.slice() as Matrix6);
  part.opacities!.push(opacity);
  if (part.fills) part.fills.push(fill ?? part.fills[part.fills.length - 1]);
  if (part.strokes) {
    part.strokes.push(stroke ?? part.strokes[part.strokes.length - 1]);
  }
}

/**
 * Peel glued paint suffixes from the end of a frame line in fixed order:
 * stroke (`s…`), then fill (`f…`), then opacity (`o…`).
 * Attached with no comma: `…,.27o.23fF1F1F1s000` or bare `o.5` / `fABC`.
 * Hex is 6 digits, or 3 when each channel pair matches (try 6 first).
 */
function splitFrameSuffixes(line: string): {
  matrixLine: string;
  opacityField: string | null;
  fillField: string | null;
  strokeField: string | null;
} {
  let rest = line;
  let strokeField: string | null = null;
  let fillField: string | null = null;
  let opacityField: string | null = null;

  const strokeMatch = /s([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.exec(rest);
  if (strokeMatch) {
    strokeField = strokeMatch[1];
    rest = rest.slice(0, strokeMatch.index);
  }

  const fillMatch = /f([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.exec(rest);
  if (fillMatch) {
    fillField = fillMatch[1];
    rest = rest.slice(0, fillMatch.index);
  }

  const opacityMatch = /o(-?[.\d]+)$/.exec(rest);
  if (opacityMatch) {
    opacityField = opacityMatch[1];
    rest = rest.slice(0, opacityMatch.index);
  }

  return { matrixLine: rest, opacityField, fillField, strokeField };
}

/** Expand wire hex (`F00` / `FF0000`) to a `#RRGGBB` DOM colour. */
function expandWireHex(field: string): string {
  const s = field.toUpperCase();
  if (s.length === 3) {
    return '#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  return '#' + s;
}

export type BundleVariableValue = string | number | boolean;

export interface LoadAssetBundleOptions {
  /** Named skin inside a layer file (ignored for legacy flat `parts` bundles). */
  skin?: string;
  /** Overrides for `$var` placeholders; merged over the layer's `variables` defaults. */
  variables?: Record<string, BundleVariableValue>;
  /** Part names omitted from the resolved bundle (never serialized or mounted). */
  hideParts?: string[];
  /**
   * Resolution-aware culling threshold per part name, in that part's local
   * units: a shape whose measured extent falls below its part's value is
   * dropped instead of serialized, so it is never mounted, never painted and
   * never receives motion.
   *
   * Callers derive these from the on-screen scale (see `cullTier.ts`). Values
   * should be quantized to a small set of tiers, because every distinct map
   * is a separate entry in the resolved-bundle cache. Omitted, or `0` for a
   * given part, means no culling.
   *
   * Shapes carrying an `id`, and anything inside a `defs` / `clipPath` /
   * `mask` / gradient subtree, are kept regardless of size — something else
   * may reference them.
   */
  cullBelowLocal?: Record<string, number>;
}

/**
 * Full-fidelity legacy bundles keep Illustrator `<style>.cls-N{fill:…}`
 * blocks. When many parts are mounted into one SVG, those class names and
 * gradient ids collide. Inline class rules onto `style=""` and prefix ids
 * (same approach as the standalone BG viewer).
 */
export function prepareSvgMarkup(markup: string, prefix: string): string {
  const styles = new Map<string, string>();
  for (const styleBlock of markup.matchAll(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
  )) {
    for (const rule of styleBlock[1].matchAll(/([^{}]+)\{([^}]+)\}/g)) {
      const declarations = rule[2].replace(/\s+/g, ' ').trim();
      for (const selector of rule[1].split(',')) {
        const className = selector.match(/\.([\w-]+)/)?.[1];
        if (!className) continue;
        const existing = styles.get(className);
        styles.set(
          className,
          existing ? `${existing};${declarations}` : declarations,
        );
      }
    }
  }

  let prepared = markup
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\sclass="([^"]+)"/g, (_, names: string) => {
      const declarations = names
        .split(/\s+/)
        .map((name) => styles.get(name))
        .filter(Boolean)
        .join(';');
      return declarations ? ` style="${declarations}"` : '';
    });

  prepared = prepared
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${prefix}-${id}"`)
    .replace(
      /url\(#([^)]+)\)/g,
      (_, id: string) => `url(#${prefix}-${id})`,
    )
    .replace(
      /\b(xlink:href|href)="#([^"]+)"/g,
      (_, attr: string, id: string) => `${attr}="#${prefix}-${id}"`,
    );
  return prepared;
}

function scopeLegacyBundle(bundle: AssetBundle): AssetBundle {
  const parts: Record<string, AssetPart> = {};
  for (const [name, part] of Object.entries(bundle.parts ?? {})) {
    parts[name] = {
      ...part,
      body: prepareSvgMarkup(part.body ?? '', `p-${name}`),
    };
  }
  return { name: bundle.name, parts };
}

/**
 * Load a layer / skin asset bundle. Formats are auto-detected:
 *   - `.svg.json` layer layout (`skins._common` + named skins + `variables`),
 *     or legacy flat `{ parts }` layout. Resolved via `resolveLayerBundle` /
 *     `decodeSvgBundle`.
 *   - `.json` legacy layout: each part stores `body` as pre-serialised HTML.
 *
 * Pass `{ skin, variables, hideParts }` to pick a skin, substitute `$var`
 * attrs, and omit named parts. The JSON fetch is cached by URL, so distinct
 * skins share one download and parse. Resolved bundles are cached separately
 * by `{ url, skin, variables, hideParts }`.
 */
export function loadAssetBundle(
  url: string,
  opts: LoadAssetBundleOptions = {},
): Promise<AssetBundle> {
  const cacheKey = bundleCacheKey(url, opts);
  let p = bundleCache.get(cacheKey);
  if (!p) {
    const isSvgJson = /\.svg\.json(\?|$)/i.test(url);
    p = fetchBundleJson(url)
      .then((data) => {
        if (!isSvgJson) return scopeLegacyBundle(data as AssetBundle);
        const raw = data as RawSvgBundle;
        if (raw.skins) {
          return resolveLayerBundle(raw, opts);
        }
        return decodeSvgBundle(raw);
      })
      .catch((err) => {
        bundleCache.delete(cacheKey);
        throw err;
      });
    bundleCache.set(cacheKey, p);
  }
  return p;
}

/**
 * Warm the raw-JSON cache for a layer file without resolving a bundle from it.
 *
 * Resolving needs the motion file first (per-part culling thresholds are
 * derived from the part matrices), but the download does not. Calling this as
 * soon as the URL is known keeps the two fetches in parallel, so gating the
 * resolve costs no load latency.
 */
export function prefetchAssetBundle(url: string): Promise<unknown> {
  return fetchBundleJson(url).catch(() => undefined);
}

export interface LoadRasterBundleOptions {
  /** Named skin inside a layer file. Defaults to the first named skin. */
  skin?: string;
  /** Part names omitted from the resolved raster bundle. */
  hideParts?: string[];
}

const rasterBundleCache: Map<string, Promise<RasterBundle>> = new Map();

function rasterBundleCacheKey(
  url: string,
  opts: LoadRasterBundleOptions,
): string {
  const hide =
    opts.hideParts && opts.hideParts.length > 0
      ? [...opts.hideParts].sort().join(',')
      : '';
  return `${url}\0${opts.skin ?? ''}\0${hide}`;
}

/**
 * Resolve the bake-time WebP sidecar index from a layer `.svg.json`.
 *
 * Reuses {@link fetchBundleJson}, so a field that also loads the vector
 * bundle does not download the JSON twice. Skin dirs fall back to
 * `_common` when the baker deduped shared artwork.
 */
export function loadRasterBundle(
  url: string,
  opts: LoadRasterBundleOptions = {},
): Promise<RasterBundle> {
  const cacheKey = rasterBundleCacheKey(url, opts);
  let p = rasterBundleCache.get(cacheKey);
  if (!p) {
    p = fetchBundleJson(url)
      .then((data) => resolveRasterBundle(url, data as RawSvgBundle, opts))
      .catch((err) => {
        rasterBundleCache.delete(cacheKey);
        throw err;
      });
    rasterBundleCache.set(cacheKey, p);
  }
  return p;
}

function rasterFileSeg(name: string): string {
  return String(name).replace(/[/\\]/g, '_').replace(/^\.+/, '_') || '_';
}

/** Resolve a sidecar path against a layer URL that may itself be relative. */
function layerAssetUrl(layerUrl: string, rel: string): string {
  const abs =
    typeof document !== 'undefined'
      ? new URL(layerUrl, document.baseURI).href
      : layerUrl;
  return new URL(rel, abs).href;
}

/** Smallest bake scale that covers `requested`, or the largest if none do. */
export function pickRasterScale(scales: number[], requested: number): number {
  if (scales.length === 0) return 1;
  let best = scales[0];
  for (const n of scales) {
    if (n >= requested) return n;
    best = n;
  }
  return best;
}

function resolveRasterBundle(
  layerUrl: string,
  raw: RawSvgBundle,
  opts: LoadRasterBundleOptions,
): RasterBundle {
  const index = raw.rasters;
  if (!index?.dir || !index.parts) {
    throw new Error(
      `Layer "${raw.name}" has no raster sidecar (missing rasters.dir / parts).`,
    );
  }

  const skinName = opts.skin ?? firstNamedSkin(raw.skins ?? {});
  if (!skinName) {
    throw new Error(
      `Layer "${raw.name}" has no named skins to resolve rasters for.`,
    );
  }

  const scales = (
    Array.isArray(index.scales) && index.scales.length > 0
      ? index.scales
      : [1]
  )
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const format = index.format || 'webp';
  const hidden = new Set(opts.hideParts ?? []);
  const parts: Record<string, RasterPart> = {};
  const units = index.units ?? {};

  for (const [partName, bySkin] of Object.entries(index.parts)) {
    if (hidden.has(partName)) continue;
    const rect = bySkin[skinName] ?? bySkin._common;
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) continue;
    const skinDir = bySkin[skinName] ? skinName : '_common';
    const srcs = new Map<number, string>();
    for (const scale of scales) {
      srcs.set(
        scale,
        layerAssetUrl(
          layerUrl,
          `${index.dir}/${rasterFileSeg(skinDir)}/${rasterFileSeg(partName)}.${scale}x.${format}`,
        ),
      );
    }
    const unit = Number(units[partName]);
    parts[partName] = {
      rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      unit: Number.isFinite(unit) && unit > 0 ? unit : 1,
      srcFor(scale: number) {
        const n = pickRasterScale(scales, scale);
        return srcs.get(n) ?? srcs.get(scales[scales.length - 1]) ?? '';
      },
    };
  }

  const unitMap: Record<string, number> = {};
  for (const [name, n] of Object.entries(units)) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) unitMap[name] = v;
  }

  return { name: `${raw.name}:${skinName}`, scales, units: unitMap, parts };
}

function fetchBundleJson(url: string): Promise<unknown> {
  let p = rawBundleCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok)
          throw new Error(`Failed to load asset bundle: ${url} (${r.status})`);
        return r.json();
      })
      .catch((err) => {
        rawBundleCache.delete(url);
        throw err;
      });
    rawBundleCache.set(url, p);
  }
  return p;
}

function bundleCacheKey(url: string, opts: LoadAssetBundleOptions): string {
  const hide =
    opts.hideParts && opts.hideParts.length > 0
      ? [...opts.hideParts].sort().join(',')
      : '';
  const cull = cullKey(opts.cullBelowLocal);
  if (!opts.skin && !opts.variables && !hide && !cull) return url;
  return `${url}\0${opts.skin ?? ''}\0${JSON.stringify(
    opts.variables ?? {},
  )}\0${hide}\0${cull}`;
}

/** Stable key for a culling map: sorted by part name, so key order cannot vary. */
function cullKey(map: Record<string, number> | undefined): string {
  if (!map) return '';
  const names = Object.keys(map).sort();
  let out = '';
  for (const name of names) {
    const v = map[name];
    if (!v || v <= 0) continue;
    out += `${name}=${v};`;
  }
  return out;
}

// --- .svg.json decoder ---

interface RawSvgElement {
  _tag?: string;
  /** Meta: include element when true (default). May be a `$var`. Never emitted as SVG. */
  render?: BundleVariableValue;
  /** Nested SVG nodes for defs/filter/mask/presentation groups. */
  _children?: RawSvgElement[];
  [attr: string]: BundleVariableValue | RawSvgElement[] | undefined;
}

interface RawSvgPart {
  viewBox?: string;
  width?: number;
  height?: number;
  body?: RawSvgElement[];
}

export interface RasterRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bake-time WebP sidecar index written onto a layer `.svg.json`. */
export interface RasterIndex {
  format?: string;
  scales?: number[];
  dir?: string;
  /**
   * 1x pixels per local viewBox unit, per part. This is the posed CSS size
   * (stage × max part scale). Absent or `1` is the legacy artboard 1x.
   */
  units?: Record<string, number>;
  parts?: Record<string, Record<string, RasterRect>>;
}

export interface RawSvgBundle {
  name: string;
  defaults?: { viewBox?: string; width?: number; height?: number };
  /** Legacy flat parts map (pre-layer format). */
  parts?: Record<string, RawSvgPart>;
  variables?: Record<string, BundleVariableValue>;
  skins?: Record<string, Record<string, RawSvgPart>>;
  rasters?: RasterIndex;
}

export interface RasterPart {
  rect: RasterRect;
  /**
   * 1x pixels per local viewBox unit. `1` means the sidecar was baked at
   * 1 pixel per local unit (legacy artboard size).
   */
  unit: number;
  /** URL of the WebP at the given bake scale (`1`, `2`, `3`, …). */
  srcFor(scale: number): string;
}

export interface RasterBundle {
  name: string;
  scales: number[];
  /** 1x pixels per local unit, per part. Used when a part has no sidecar. */
  units: Record<string, number>;
  parts: Record<string, RasterPart>;
}

/**
 * Convert a legacy flat `.svg.json` payload (`{ name, defaults, parts }`)
 * into the runtime AssetBundle shape.
 */
export function decodeSvgBundle(raw: RawSvgBundle): AssetBundle {
  const defViewBox = raw.defaults?.viewBox ?? '0 0 0 0';
  const defW = raw.defaults?.width ?? 0;
  const defH = raw.defaults?.height ?? 0;
  const srcParts = raw.parts ?? {};

  const parts: Record<string, AssetPart> = {};
  for (const [name, part] of Object.entries(srcParts)) {
    parts[name] = {
      viewBox: part.viewBox ?? defViewBox,
      width: part.width ?? defW,
      height: part.height ?? defH,
      body: serializeSvgElements(part.body ?? [], {}),
      localRadius: partLocalRadius(part.body),
    };
  }
  return { name: raw.name, parts };
}

/**
 * Resolve a layer `.svg.json` into a runtime AssetBundle:
 * merge `skins._common` with `skins[skin]`, substitute `$var` values, and
 * re-scope element ids with the skin name.
 *
 * Bake-time ids are only unique per rig+part (`body_mask`). Gamefields
 * mount several skins of one rig in the same document, so an unscoped
 * `url(#body_mask)` would clip one skin's torso to another skin's
 * neck-notch mask. Prefixing here keeps `_common` diffing intact.
 */
export function resolveLayerBundle(
  raw: RawSvgBundle,
  opts: LoadAssetBundleOptions = {},
): AssetBundle {
  if (!raw.skins) {
    return decodeSvgBundle(raw);
  }

  const skinName = opts.skin ?? firstNamedSkin(raw.skins);
  if (!skinName) {
    throw new Error(
      `Layer "${raw.name}" has no named skins to resolve (only _common?).`,
    );
  }
  if (skinName === '_common' || !raw.skins[skinName]) {
    throw new Error(
      `Unknown skin "${skinName}" in layer "${raw.name}". ` +
        `Available: ${Object.keys(raw.skins)
          .filter((k) => k !== '_common')
          .join(', ')}`,
    );
  }

  const variables: Record<string, BundleVariableValue> = {
    ...(raw.variables ?? {}),
    ...(opts.variables ?? {}),
  };

  const common = raw.skins._common ?? {};
  const overlay = raw.skins[skinName] ?? {};
  const partNames = new Set([
    ...Object.keys(common),
    ...Object.keys(overlay),
  ]);

  const defViewBox = raw.defaults?.viewBox ?? '0 0 0 0';
  const defW = raw.defaults?.width ?? 0;
  const defH = raw.defaults?.height ?? 0;

  const hidden = new Set(opts.hideParts ?? []);
  const idPrefix = skinIdPrefix(skinName);
  const parts: Record<string, AssetPart> = {};
  for (const name of partNames) {
    if (hidden.has(name)) continue;
    const merged = mergePart(common[name], overlay[name]);
    const culled = { count: 0 };
    parts[name] = {
      viewBox: merged.viewBox ?? defViewBox,
      width: merged.width ?? defW,
      height: merged.height ?? defH,
      body: serializeSvgElements(
        merged.body ?? [],
        variables,
        opts.cullBelowLocal?.[name] ?? 0,
        false,
        culled,
        idPrefix,
      ),
      // Measured before culling: the epsilon describes how the part moves,
      // which does not change because a sub-pixel detail was dropped.
      localRadius: partLocalRadius(merged.body),
      culledShapes: culled.count,
    };
  }

  return { name: `${raw.name}:${skinName}`, parts };
}

function firstNamedSkin(
  skins: Record<string, Record<string, RawSvgPart>>,
): string | undefined {
  for (const k of Object.keys(skins)) {
    if (k !== '_common') return k;
  }
  return undefined;
}

function mergePart(
  common: RawSvgPart | undefined,
  overlay: RawSvgPart | undefined,
): RawSvgPart {
  const body = mergeBody(common?.body, overlay?.body);
  return {
    viewBox: overlay?.viewBox ?? common?.viewBox,
    width: overlay?.width ?? common?.width,
    height: overlay?.height ?? common?.height,
    body,
  };
}

function mergeBody(
  commonBody: RawSvgElement[] | undefined,
  overlayBody: RawSvgElement[] | undefined,
): RawSvgElement[] {
  const len = Math.max(commonBody?.length ?? 0, overlayBody?.length ?? 0);
  const out: RawSvgElement[] = [];
  for (let i = 0; i < len; i++) {
    const base = commonBody?.[i];
    const over = overlayBody?.[i];
    if (!base && !over) continue;
    const merged: RawSvgElement = { ...(base ?? {}), ...(over ?? {}) };
    if (merged._tag) out.push(merged);
  }
  return out;
}

/**
 * Serialize a part body to inner SVG markup.
 *
 * `minExtent` is the resolution-aware culling threshold in local units; `0`
 * disables culling. `inReferenced` is set once the walk is inside a subtree
 * something else points at (`defs`, `clipPath`, a gradient, ...) where a
 * sub-pixel shape can still control what a full-size sibling shows, so nothing
 * below it may be dropped on size.
 */
function serializeSvgElements(
  els: RawSvgElement[],
  variables: Record<string, BundleVariableValue>,
  minExtent = 0,
  inReferenced = false,
  culled?: { count: number },
  idPrefix = '',
): string {
  let out = '';
  for (const el of els) {
    if (!el._tag) continue;
    if (!shouldRenderElement(el.render, variables)) continue;
    if (!inReferenced && minExtent > 0 && isCullable(el, minExtent)) {
      if (culled) culled.count += countShapes(el);
      continue;
    }
    const children = Array.isArray(el._children) ? el._children : null;
    out += '<' + el._tag;
    for (const k in el) {
      if (k === '_tag' || k === 'render' || k === '_children') continue;
      const v = el[k];
      if (v === undefined || Array.isArray(v)) continue;
      const resolved = resolveVar(v, variables);
      const raw =
        typeof resolved === 'string' ? resolved : String(resolved);
      const scoped = idPrefix ? scopeSerializedId(k, raw, idPrefix) : raw;
      out += ' ' + k + '="' + scoped + '"';
    }
    if (children && children.length > 0) {
      out += '>';
      out += serializeSvgElements(
        children,
        variables,
        minExtent,
        inReferenced || isReferencedContainer(el._tag),
        culled,
        idPrefix,
      );
      out += '</' + el._tag + '>';
    } else {
      out += '/>';
    }
  }
  return out;
}

/** Safe CSS/SVG id prefix for a skin so paint servers do not collide. */
function skinIdPrefix(skinName: string): string {
  const safe = skinName.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe ? `${safe}_` : '';
}

const URL_REF_RE = /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g;
const HREF_RE = /^#([^\s'"]+)$/;

/** Rewrite `id` / `url(#id)` / `href="#id"` so each resolved skin is unique. */
function scopeSerializedId(
  key: string,
  value: string,
  prefix: string,
): string {
  if (key === 'id') return prefix + value;
  if (
    (key === 'href' || key === 'xlink:href') &&
    HREF_RE.test(value)
  ) {
    return '#' + prefix + value.slice(1);
  }
  return value.replace(
    URL_REF_RE,
    (_m, q: string, id: string) => `url(${q}#${prefix}${id}${q})`,
  );
}

/**
 * Shape elements in `el` and everything under it.
 *
 * Culling drops whole subtrees, so a dropped `<g>` takes its children with it
 * and all of them have to be counted. `render` flags are not consulted: an
 * element that would not have been serialized anyway is not a saving, but the
 * variables are not in scope here and the difference only shows up for
 * variant-gated groups that are also sub-pixel.
 */
function countShapes(el: RawSvgElement): number {
  let n = SHAPE_TAGS.has(el._tag ?? '') ? 1 : 0;
  const children = el._children;
  if (Array.isArray(children)) {
    for (const child of children) n += countShapes(child);
  }
  return n;
}

/**
 * Whether a body element should be serialized.
 * Omitted `render` defaults to true. `$var` missing → false.
 */
function shouldRenderElement(
  render: BundleVariableValue | undefined,
  variables: Record<string, BundleVariableValue>,
): boolean {
  if (render === undefined) return true;
  const resolved =
    typeof render === 'string' && render.startsWith('$')
      ? resolveRenderVar(render, variables)
      : render;
  return isRenderTruthy(resolved);
}

/** Resolve `$name` for `render`; missing keys yield false (not the token string). */
function resolveRenderVar(
  value: string,
  variables: Record<string, BundleVariableValue>,
): BundleVariableValue {
  const key = value.slice(1);
  if (Object.prototype.hasOwnProperty.call(variables, key)) {
    return variables[key];
  }
  return false;
}

function isRenderTruthy(value: BundleVariableValue): boolean {
  if (value === true || value === 1 || value === 'true' || value === '1') {
    return true;
  }
  return false;
}

/** Substitute `$name` tokens using the variables map; leave unknowns as-is. */
function resolveVar(
  value: BundleVariableValue,
  variables: Record<string, BundleVariableValue>,
): BundleVariableValue {
  if (typeof value !== 'string' || !value.startsWith('$')) return value;
  const key = value.slice(1);
  if (Object.prototype.hasOwnProperty.call(variables, key)) {
    return variables[key];
  }
  return value;
}

/** Pre-warm the loader caches. Useful for crowd-style scenes. */
export function preload(
  motionUrl: string,
  bundleUrls: string[],
  opts?: LoadAssetBundleOptions,
): Promise<void> {
  return Promise.all([
    loadMotion(motionUrl),
    ...bundleUrls.map((u) => loadAssetBundle(u, opts)),
  ]).then(() => undefined);
}
