/**
 * Local geometry measurement for layer-file shapes.
 *
 * Resolution-aware culling needs to know how big a shape is *before* it is
 * ever mounted, so the measurement runs over the raw `.svg.json` element
 * objects rather than the DOM. Doing it in the browser via `getBBox()` would
 * force a synchronous layout per shape, which on a crowd rig is hundreds of
 * layouts at exactly the wrong moment.
 *
 * Two numbers come out of one pass:
 *   - `extent` — the larger of the shape's width / height in local units.
 *     Compared against a threshold to decide sub-pixel culling.
 *   - `radius` — the farthest distance from the local origin. A part's matrix
 *     rotates about that origin, so this is the lever arm that turns a change
 *     in `a,b,c,d` into on-screen movement; the motion epsilon needs it.
 *
 * Results are memoised on the element object itself. Raw bundle JSON is cached
 * by URL in `rawBundleCache`, so element identity is stable across every skin
 * and every culling tier resolved from that file — each shape is measured
 * exactly once per session no matter how many bundles are built.
 *
 * Curve control points and arc radii are folded into the bounds rather than
 * solved for true extrema. That over-estimates size, which is the safe
 * direction: it keeps shapes we could have dropped instead of dropping shapes
 * that are still visible.
 */

/** Structural view of a `.svg.json` body element. */
export interface MeasurableElement {
  _tag?: string
  _children?: MeasurableElement[]
  [attr: string]: unknown
}

export interface ShapeMetrics {
  /** Larger of width / height, in the part's local units. */
  extent: number
  /** Farthest distance from the local origin, in local units. */
  radius: number
}

/** Never culled, and never measured: no geometry of its own. */
const KEEP: ShapeMetrics = { extent: Infinity, radius: 0 }

/**
 * Tags whose subtree defines something referenced elsewhere. A sub-pixel path
 * inside a `clipPath` still controls what a full-size sibling shows, so
 * nothing below these may be culled on size.
 */
const REFERENCED_CONTAINERS = new Set([
  'defs',
  'clipPath',
  'mask',
  'filter',
  'linearGradient',
  'radialGradient',
  'pattern',
  'symbol',
  'marker',
])

const metricsCache = new WeakMap<MeasurableElement, ShapeMetrics>()

/** Whether `tag` opens a subtree that must be kept regardless of size. */
export function isReferencedContainer(tag: string | undefined): boolean {
  return tag !== undefined && REFERENCED_CONTAINERS.has(tag)
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

const CHAR_PLUS = 43
const CHAR_MINUS = 45
const CHAR_DOT = 46
const CHAR_0 = 48
const CHAR_9 = 57
const CHAR_E_UPPER = 69
const CHAR_E_LOWER = 101

function isDigit(c: number): boolean {
  return c >= CHAR_0 && c <= CHAR_9
}

/** Alphabetic path command, excluding the exponent marker handled by the scanner. */
function isCommand(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

function isSeparator(c: number): boolean {
  return c === 44 || c === 32 || c === 9 || c === 10 || c === 13
}

/**
 * End index of the number starting at `start`, or `start` when there is none.
 * Handles the compact forms path data is allowed to use: a leading sign, an
 * omitted integer or fractional part, and exponents.
 */
function scanNumber(s: string, start: number): number {
  const n = s.length
  let i = start
  if (i < n) {
    const c = s.charCodeAt(i)
    if (c === CHAR_PLUS || c === CHAR_MINUS) i++
  }
  let sawDigit = false
  while (i < n && isDigit(s.charCodeAt(i))) {
    i++
    sawDigit = true
  }
  if (i < n && s.charCodeAt(i) === CHAR_DOT) {
    i++
    while (i < n && isDigit(s.charCodeAt(i))) {
      i++
      sawDigit = true
    }
  }
  if (!sawDigit) return start
  if (i < n) {
    const c = s.charCodeAt(i)
    if (c === CHAR_E_UPPER || c === CHAR_E_LOWER) {
      let j = i + 1
      if (j < n) {
        const sign = s.charCodeAt(j)
        if (sign === CHAR_PLUS || sign === CHAR_MINUS) j++
      }
      let sawExpDigit = false
      while (j < n && isDigit(s.charCodeAt(j))) {
        j++
        sawExpDigit = true
      }
      if (sawExpDigit) i = j
    }
  }
  return i
}

/** Operand count per path command, keyed by uppercase char code. */
function arity(cmd: number): number {
  switch (cmd) {
    case 72: // H
    case 86: // V
      return 1
    case 67: // C
      return 6
    case 83: // S
    case 81: // Q
      return 4
    case 65: // A
      return 7
    case 90: // Z
      return 0
    default: // M L T
      return 2
  }
}

class Bounds {
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity

  add(x: number, y: number): void {
    if (x < this.minX) this.minX = x
    if (x > this.maxX) this.maxX = x
    if (y < this.minY) this.minY = y
    if (y > this.maxY) this.maxY = y
  }

  metrics(): ShapeMetrics | null {
    if (this.minX > this.maxX) return null
    const w = this.maxX - this.minX
    const h = this.maxY - this.minY
    const farX = Math.max(Math.abs(this.minX), Math.abs(this.maxX))
    const farY = Math.max(Math.abs(this.minY), Math.abs(this.maxY))
    return { extent: Math.max(w, h), radius: Math.hypot(farX, farY) }
  }
}

function pathBounds(d: string): Bounds {
  const bounds = new Bounds()
  const n = d.length
  const args: number[] = []
  let cmd = 0
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let i = 0

  while (i < n) {
    const c = d.charCodeAt(i)

    if (isSeparator(c)) {
      i++
      continue
    }

    if (isCommand(c)) {
      // An exponent marker only ever follows a digit, so it has already been
      // consumed by scanNumber and cannot reach here as a command.
      cmd = c
      i++
      if (c === 90 || c === 122) {
        x = startX
        y = startY
        bounds.add(x, y)
      }
      continue
    }

    if (cmd === 0) {
      i++
      continue
    }

    const upper = cmd & 0xdf // fold lowercase to uppercase
    const need = arity(upper)
    if (need === 0) {
      i++
      continue
    }

    args.length = 0
    let j = i
    while (args.length < need) {
      while (j < n && isSeparator(d.charCodeAt(j))) j++
      const end = scanNumber(d, j)
      if (end === j) break
      args.push(parseFloat(d.slice(j, end)))
      j = end
    }

    if (args.length < need) {
      // Malformed tail; stop rather than risk an endless loop.
      break
    }
    i = j

    const rel = cmd >= 97
    if (upper === 72) {
      // H
      x = rel ? x + args[0] : args[0]
      bounds.add(x, y)
    } else if (upper === 86) {
      // V
      y = rel ? y + args[0] : args[0]
      bounds.add(x, y)
    } else if (upper === 65) {
      // A: sweep is approximated by padding both endpoints with the radii.
      const rx = Math.abs(args[0])
      const ry = Math.abs(args[1])
      const nx = rel ? x + args[5] : args[5]
      const ny = rel ? y + args[6] : args[6]
      bounds.add(x - rx, y - ry)
      bounds.add(x + rx, y + ry)
      bounds.add(nx - rx, ny - ry)
      bounds.add(nx + rx, ny + ry)
      x = nx
      y = ny
    } else {
      // M L T (one pair), Q S (two pairs), C (three pairs). Control points are
      // folded in, so the result contains the true curve.
      for (let k = 0; k + 1 < args.length; k += 2) {
        const px = rel ? x + args[k] : args[k]
        const py = rel ? y + args[k + 1] : args[k + 1]
        bounds.add(px, py)
        if (k + 2 >= args.length) {
          x = px
          y = py
        }
      }
      if (upper === 77) {
        startX = x
        startY = y
        // Extra pairs after a moveto are implicit linetos.
        cmd = rel ? 108 : 76
      }
    }
  }

  return bounds
}

function pointsBounds(points: string): Bounds {
  const bounds = new Bounds()
  const n = points.length
  let i = 0
  let pendingX = 0
  let hasX = false
  while (i < n) {
    const end = scanNumber(points, i)
    if (end === i) {
      i++
      continue
    }
    const v = parseFloat(points.slice(i, end))
    i = end
    if (hasX) {
      bounds.add(pendingX, v)
      hasX = false
    } else {
      pendingX = v
      hasX = true
    }
  }
  return bounds
}

/**
 * Widen `metrics` to cover an element-level `transform`.
 *
 * Only bounds are needed, not exact geometry, so each function contributes an
 * upper bound: a scale multiplies both numbers, a translate or an off-origin
 * rotation pushes the shape further from the local origin. Over-estimating is
 * safe in both directions — a larger extent keeps shapes that might have been
 * culled, and a larger radius makes the motion epsilon finer.
 */
function widenForTransform(
  metrics: ShapeMetrics,
  transform: string,
): ShapeMetrics {
  let scale = 1
  let offset = 0
  const fn = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = fn.exec(transform)) !== null) {
    const name = match[1]
    const args: number[] = []
    for (const token of match[2].split(/[\s,]+/)) {
      if (token === '') continue
      const v = parseFloat(token)
      if (Number.isFinite(v)) args.push(v)
    }
    if (name === 'translate') {
      offset += Math.hypot(args[0] ?? 0, args[1] ?? 0)
    } else if (name === 'rotate') {
      // rotate(a cx cy) orbits the shape around (cx, cy).
      if (args.length >= 3) offset += 2 * Math.hypot(args[1], args[2])
    } else if (name === 'scale') {
      const sx = Math.abs(args[0] ?? 1)
      const sy = args.length > 1 ? Math.abs(args[1]) : sx
      scale *= Math.max(sx, sy)
    } else if (name === 'matrix' && args.length >= 6) {
      scale *= Math.max(
        Math.hypot(args[0], args[1]),
        Math.hypot(args[2], args[3]),
      )
      offset += Math.hypot(args[4], args[5])
    }
  }
  if (scale === 1 && offset === 0) return metrics
  return {
    extent: metrics.extent === Infinity ? Infinity : metrics.extent * scale,
    radius: metrics.radius * scale + offset,
  }
}

function computeMetrics(el: MeasurableElement): ShapeMetrics {
  const tag = el._tag

  if (tag === 'path') {
    const d = el.d
    if (typeof d !== 'string' || d === '') return KEEP
    const metrics = pathBounds(d).metrics()
    return metrics ?? KEEP
  }

  if (tag === 'polygon' || tag === 'polyline') {
    const points = el.points
    if (typeof points !== 'string' || points === '') return KEEP
    const metrics = pointsBounds(points).metrics()
    return metrics ?? KEEP
  }

  if (tag === 'rect') {
    const x = num(el.x)
    const y = num(el.y)
    const w = num(el.width)
    const h = num(el.height)
    return {
      extent: Math.max(w, h),
      radius: Math.hypot(
        Math.max(Math.abs(x), Math.abs(x + w)),
        Math.max(Math.abs(y), Math.abs(y + h)),
      ),
    }
  }

  if (tag === 'circle') {
    const cx = num(el.cx)
    const cy = num(el.cy)
    const r = Math.abs(num(el.r))
    return {
      extent: 2 * r,
      radius: Math.hypot(Math.abs(cx) + r, Math.abs(cy) + r),
    }
  }

  if (tag === 'ellipse') {
    const cx = num(el.cx)
    const cy = num(el.cy)
    const rx = Math.abs(num(el.rx))
    const ry = Math.abs(num(el.ry))
    return {
      extent: 2 * Math.max(rx, ry),
      radius: Math.hypot(Math.abs(cx) + rx, Math.abs(cy) + ry),
    }
  }

  if (tag === 'line') {
    const x1 = num(el.x1)
    const y1 = num(el.y1)
    const x2 = num(el.x2)
    const y2 = num(el.y2)
    return {
      extent: Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)),
      radius: Math.max(Math.hypot(x1, y1), Math.hypot(x2, y2)),
    }
  }

  return KEEP
}

/**
 * Measured local geometry of one body element, memoised on the element.
 * Non-shape tags report an infinite extent so they are never culled.
 */
export function shapeMetrics(el: MeasurableElement): ShapeMetrics {
  const cached = metricsCache.get(el)
  if (cached !== undefined) return cached
  let metrics = computeMetrics(el)
  // A hairline path with a wide stroke paints far beyond its geometry.
  const strokeWidth = el['stroke-width']
  if (strokeWidth !== undefined && metrics.extent !== Infinity) {
    const sw = Math.abs(num(strokeWidth))
    if (sw > metrics.extent) metrics = { ...metrics, extent: sw }
  }
  const transform = el.transform
  if (typeof transform === 'string' && transform !== '') {
    metrics = widenForTransform(metrics, transform)
  }
  metricsCache.set(el, metrics)
  return metrics
}

/**
 * Whether `el` may be dropped at a threshold of `minExtent` local units.
 *
 * An element carrying an `id` is kept regardless of size: something else in
 * the bundle may reference it by that id.
 */
export function isCullable(el: MeasurableElement, minExtent: number): boolean {
  if (minExtent <= 0) return false
  if (isReferencedContainer(el._tag)) return false
  if (el.id !== undefined) return false
  return shapeMetrics(el).extent < minExtent
}

/**
 * Farthest distance from the local origin across a part's shapes, in local
 * units. This is the lever arm the motion epsilon multiplies a change in
 * `a,b,c,d` by to get on-screen movement.
 */
export function partLocalRadius(body: MeasurableElement[] | undefined): number {
  let radius = 0
  const walk = (els: MeasurableElement[]): void => {
    for (const el of els) {
      if (el._tag) {
        const r = shapeMetrics(el).radius
        if (r > radius) radius = r
      }
      if (Array.isArray(el._children)) walk(el._children)
    }
  }
  if (body) walk(body)
  return radius
}
