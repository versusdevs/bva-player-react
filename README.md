# bva-player-react

## What is BVA?

**Baked Vector Animation (BVA)** is a two-stage pipeline for vector animation: **bake once**, then **play cheap**.

Lottie describes *how* to compute an animation — keyframes, easing, parented transform chains, nested precomps — and a Lottie runtime redoes that math on every frame, for every property, for every instance on screen. BVA moves all of it to build time. The baker evaluates the Lottie once, collapses each part's whole parent chain into a single 2D affine matrix per frame, and writes the result out. What ships to the browser is the cheapest useful representation of the same motion: **matrices + opacity + inlined SVG**.

That leaves this player with almost nothing to do per frame: mount one `<svg>` with a `<g>` per part, then rewrite `transform` (and optional `opacity` / `fill` / `stroke`) as the clock advances. No keyframe interpolation, no layer-tree composition, no animation engine. Every instance on the page ticks from one shared `requestAnimationFrame`, so a crowd does not schedule a callback per character.

A baked rig is two files:

- **`<rig>.bva`** — the motion. Per-frame matrices (plus optional opacity / fill / stroke) for every part of every segment.
- **`assets/<rig>.svg.json`** — the looks. Shared geometry in `skins._common`, named skins as attribute diffs, and `$var` placeholders for play-time colour overrides.

Because the two are separate, you can swap a skin or recolour a rig mid-playback without re-baking and without resetting the clock.

**Trade-off:** everything is resolved at bake time, so a `.bva` cannot do what a matrix cannot express — no vertex-level path morphs, masks, track mattes, effects, or 3D. Reach for Lottie when you need those; reach for BVA when you need the same motion drawn many times, cheaply.

This package is the **runtime** (play time). The build-time half is [`bva-baker-js`](../bva-baker-js).

## This package

Runtime player for BVA. Consumes the output of [`bva-baker-js`](../bva-baker-js):

```
<rig>/
  <rig>.bva              # per-frame matrices (+ optional o/f/s) per part
  assets/
    <rig>.svg.json       # layer file: skins._common + named skins
```

Artwork is inlined from the layer file, so parts are never fetched individually.

## Install

```bash
npm install bva-player-react
# peer: react, react-dom
```

Local workspace:

```json
"bva-player-react": "file:../bva-player-react"
```

## React usage

```tsx
import { BvaPlayer, loadMotion, loadAssetBundle } from 'bva-player-react';

const motion = await loadMotion('/bva/character/character.bva');
const bundle = await loadAssetBundle('/bva/character/assets/character.svg.json', {
  skin: 'Skin_1',
  variables: { base_color: '#101010' },
});

<BvaPlayer
  motion={motion}
  bundle={bundle}
  segment="idle"
  playing
  loop
/>
```

Swap looks without restarting time by resolving another skin / variables map and passing a new `bundle`. Change `segment` to jump clips. Toggle `playing` / `loop` / `speed` as needed.

### Loading indicator

`BvaPlayer` shows a built-in spinner while `motion` or `bundle` is `null` and until the player mounts. Mount the component while your data loads to display the indicator. `GameField` shows the same indicator while its mounted rigs initialize, then removes it when the field leaves its load phase. Empty fields do not wait for rigs.

`BvaPlayer` accepts `onReady`, called once after initialization and removal of the loading indicator. The player ref is usable inside the callback. It fires again when a different `motion` initializes or an input goes through `null` and loads again. Changing the callback, playback props, or a non-null bundle (such as a skin swap) does not trigger it again. This is separate from `onComplete`, which signals the end of a non-looping animation.

```tsx
<BvaPlayer
  motion={motion}
  bundle={bundle}
  onReady={() => console.log('BVA is ready')}
  playing
/>
```

Both components accept a `loader` React node:

```tsx
<BvaPlayer motion={motion} bundle={bundle} loader={<MyLoader />} playing />
<GameField config={config} rigs={rigs} loader={<MyLoader />} />
```

Omit `loader` for the default, or pass `loader={null}` to disable it. The default `BvaLoader` is also exported for host-controlled loading, such as fetching the field configuration:

```tsx
import { BvaLoader } from 'bva-player-react';

<BvaLoader label="Preparing the scene…" style={{ color: '#7fd1ff' }} />
```

The default indicator includes a status label and respects reduced-motion preferences. Keep custom loaders independent of the assets they are waiting for. Fetch errors remain the host's responsibility for `BvaPlayer`.

### Host-controlled scene readiness and music

`GameField` accepts `onReady`, called once its active scene rigs have initialized,
and again when a different configuration becomes ready. Use `loader={null}` when
the host already handles scene loading:

```tsx
<GameField config={config} rigs={rigs} loader={null} onReady={handleSceneReady}
  bgEnabled={musicEnabled} bgPaused={inactive} sfxEnabled={soundsEnabled} />
```

`bgPaused` defaults to `false`. Pausing fades background music to silence over
600 ms before stopping its sources; resuming restarts the remembered background
loops and fades them in. Sound effects and the shared audio context stay active.
The same fade helper is available from `bva-player-react/music-fade`.

Keep shared runtime changes in this package and application rules, loadouts,
and HUDs in the consuming application. Preserve the existing CSS animation
and loader exports for consumers.

### Resolving layers without fetching again

`loadAssetBundle` fetches each URL once and reuses the parsed JSON across skins. Call it with different `{ skin, variables }` and only the resolve step runs again. For a payload you already hold:

```ts
import { resolveLayerBundle, type RawSvgBundle } from 'bva-player-react';

const raw = (await fetch(url).then((r) => r.json())) as RawSvgBundle;
const forPlayerA = resolveLayerBundle(raw, {
  skin: 'Skin_1',
  variables: { base_color: '#000' },
});
const forPlayerB = resolveLayerBundle(raw, {
  skin: 'Skin_2',
  variables: { base_color: '#fff' },
});
```

## WebP + CSS animations

For illustrated covers, wipes, and simple loops, this package also offers a native CSS player. It renders ordinary HTML and external WebP images, without loading a `.bva`, SVG bundle, or per-frame matrices. CSS keyframes provide the motion; JavaScript observes resize and animation completion. Existing BVA playback continues to work as before.

```tsx
import { CssAnimationPlayer, preloadCssImage } from 'bva-player-react/css'
import './loading-cover.css'

// Optional: preload/decode only the next cover before starting the transition.
await preloadCssImage('/covers/kicking.webp')

<div style={{ width: '100%', height: '100%' }}>
  <CssAnimationPlayer
    width={1200} height={675}
    segment={phase} durationMs={phase === 'cover' ? 2000 : 900}
    loop={phase === 'cover'} playing={playing}
    className="loading-cover" onComplete={handlePhaseComplete}
  >
    <img className="hero" src="/covers/kicking.webp" alt="" />
    <p>YOUR TURN TO KICK</p>
  </CssAnimationPlayer>
</div>
```

```css
.loading-cover .hero { position: absolute; left: 430px; top: 132px; width: 340px; height: 340px; }
.loading-cover[data-segment='in'] .hero { animation: arrive var(--bva-css-duration) ease-out both; }
.loading-cover[data-segment='cover'] .hero { animation: float 2s ease-in-out infinite; }
@keyframes arrive { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
@keyframes float { 0%,100% { transform: none; } 50% { transform: translateY(-4px); } }
```

The parent must have a nonzero width and height. Children use the supplied authoring canvas coordinates; `fit="cover"` (default) fills and crops, while `fit="contain"` keeps the entire canvas visible. The player imports its base stylesheet automatically. The separate `bva-player-react/css` entry avoids importing BVA parsers or renderers.

| Prop | Behavior |
| --- | --- |
| `segment`, `durationMs` | Required segment name and duration in milliseconds. Changing either restarts playback. Match child animations to `--bva-css-duration`. |
| `width`, `height` | Required positive authoring canvas dimensions. |
| `playing` | Defaults to `true`. Pauses/resumes the CSS clock and descendant CSS animations together. |
| `loop` | Defaults to `false`. A loop never calls `onComplete`. Declare repeating child animations in your stylesheet. |
| `playbackKey` | Change to replay the current segment without changing its name. |
| `onComplete` | Called once for a finite segment. Child animation events are ignored. Replacing or unmounting a segment cancels it. |
| `reducedMotion` | Defaults to the system preference. Disables descendant CSS animations, completes finite segments immediately, and holds looping segments. Use visible, stable base styles. |
| `className`, `style` | Root wrapper styles; custom rules can select `[data-segment]`, `[data-playing]`, and `[data-reduced]`. |

`useReducedMotion()` is also exported. `preloadCssImage(url)` caches successful loads/decodes and allows retry after failure; call it in the browser. Image readiness is separate from animation completion. Keep an opaque CSS background and readable text while artwork loads or fails. A loading cover should loop until the application signals readiness, then switch to its exit segment. This player does not convert baked matrix streams into CSS; use it for authored CSS animations.

## Imperative API

```ts
import {
  BakedVectorPlayer,
  loadMotion,
  loadAssetBundle,
} from 'bva-player-react';

const motion = await loadMotion(url);
const bundle = await loadAssetBundle(layerUrl, { skin: 'Skin_1' });
const player = new BakedVectorPlayer(containerEl, motion, bundle);
player.play('idle', { loop: true });
player.setBundle(otherResolvedBundle);
player.destroy();
```

## GameField scenes

A gamefield is JSON: a canvas plus `image` / `bva` / `smartbva` / `group` / `canvas` / `sound` assets. Visual assets map a **logical state** onto a baked segment and an optional timing program. Game code never names a segment — it calls `setAssetState('hero', 'attack')`. Sound assets speak the same states (or fire from `playSound`). A `type: "canvas"` asset is a group that paints its subtree into one Canvas2D surface.

### The config file

One file describes the whole scene. Positions are in canvas units (not pixels); the field scales itself to fit its wrapper, so a config never mentions screen size.

```jsonc
{
  "id": "arena",
  "name": "Arena",
  "size": { "w": 1200, "h": 675 },
  "fps": 24,
  "assets": [
    { "id": "backdrop", "type": "image",    "path": "/scenes/arena/bg.svg", "zIndex": 0 },
    { "id": "hero",     "type": "bva",      "asset": "hero",  "zIndex": 10, "state": "idle" },
    { "id": "crowd",    "type": "group",    "items": [ /* … */ ] },
    { "id": "ambience", "type": "sound",    "loop": true, "states": [ /* … */ ] }
  ]
}
```

Field-level keys beyond `id` / `name` / `size` / `assets` are all optional:

| key | effect |
|---|---|
| `fps` | Frames timing programs count in. Defaults to each motion's own fps. |
| `maxN` | Cap on pose-skip N under cooldown. Default `4`. |
| `measureMs` | Length of the performance measuring window. Default `1500`. |
| `weakRafHz` / `weakTotalSkips` / `weakAvgJsMs` | Thresholds that classify the device as weak. Defaults `24` / `8` / `8`. |
| `smartCulling` | Master switch for resolution-aware shape culling and motion cutting. Default `true`. |
| `smartCullingThresholdCssPx` | How small a shape must be, in CSS pixels, to be dropped. Default `1`. |
| `smartMotionThresholdPx` | How far a part must move, in device pixels, to be worth a write. Default `1`. |

Every asset, whatever its type, accepts the same base fields:

| key | effect |
|---|---|
| `id` | Required. What `setAssetState` and friends address. |
| `name` | Optional label for editors; the runtime ignores it. |
| `position` | `[x, y]` centre in canvas space. Defaults to the canvas centre. |
| `zIndex` / `scale` / `mirror` | Paint order, size multiplier, horizontal flip about the centre. |
| `active` | `false` mounts nothing. |
| `state` / `states` | Initial logical state, and the state-to-segment table. |
| `priority` | `0..1` share of pose-skip cooldown absorbed. `1` (default) never skips; `0` takes the full field N. |
| `renderOnWeakDevice` | `false` unmounts this asset once the field measures as weak. Default `true`. |
| `weakDeviceDistributionRatio` | `0..1`. On a weak device keep this fraction of the node's direct contents. Not inherited. |
| `full` | `true` exempts the asset from culling and motion cutting however small it is drawn. |
| `smartCullingThresholdCssPx` | Per-asset override of the field threshold. A child's value wins over its group's. |

### `image`

A static picture: backdrops, foreground props, anything with no motion. `path` is a URL the host serves; `size` is in canvas units and defaults to the canvas size.

```jsonc
{
  "id": "backdrop",
  "name": "Arena background",
  "type": "image",
  "path": "/scenes/arena/bg.svg",
  "position": [600, 320],
  "size": { "w": 1367, "h": 769 },
  "zIndex": 0
}
```

Images have no states and no rig, so `states` / `priority` / `full` do nothing on them. They are ordinary `<img>` elements placed by the same canvas math as everything else.

### `bva`

One baked rig, drawn once. `asset` is a key in the `rigs` map you pass to `<GameField>` — the JSON never holds URLs.

```jsonc
{
  "id": "hero",
  "name": "Hero",
  "type": "bva",
  "asset": "hero",
  "zIndex": 10,
  "state": "idle",
  "skinConfig": {
    "skin": "Skin_1",
    "face": 1,
    "hair": 3,
    "colors": { "hair_color": "#764330", "face_color": "#f0ab9a", "skin_color": "#e3a292" }
  },
  "states": [
    { "state": "idle",   "segment": "idle",       "timing": [":", 18] },
    { "state": "attack", "segment": "jump_left",  "timing": ["0:32", -1] },
    { "state": "hurt",   "segment": "jump_right" }
  ]
}
```

`states` is the whole point of the indirection: game code asks for `attack` and the config decides which baked segment that means, so re-cutting the animation never touches the game.

A baked rig carries its own `#stage` matrix, so it is already laid out inside its own canvas. `position` moves that entire canvas rather than the character within it — for a rig baked against the scene canvas, leaving `position` at the default keeps it exactly where the animator placed it.

`skinConfig` is passed to the rig's `buildVariables` / `buildHiddenParts` / `prepareBundle` hooks. Only `skin` is required; `face`, `hair`, `colors`, and `hideParts` are conventions the host interprets, and extra keys are allowed.

### `smartbva`

One rig drawn many times. The field ticks a single off-screen master and every placement is an SVG `<use>` pointing at it, so a hundred copies cost one rig's worth of per-frame matrix writes.

```jsonc
{
  "id": "crowd_row_1",
  "type": "smartbva",
  "asset": "spectator",
  "state": "idle",
  "priority": 0,
  "skinConfig": { "skin": "Skin_2", "face": 1 },
  "states": [
    { "state": "idle",  "segment": "idle_wave",  "timing": [":", 30] },
    { "state": "cheer", "segment": "cheer",      "timing": [":", 6] }
  ],
  "distribution": [
    { "position": [986, 272], "zIndex": 5,  "scale": 1.13 },
    { "position": [142, 273], "zIndex": 14, "scale": 1.13, "mirror": true },
    { "position": [320, 240], "zIndex": 5,  "scale": 0.6,
      "skinConfig": { "hideParts": ["legs"] } }
  ]
}
```

Each placement carries its own `position` / `zIndex` / `scale` / `mirror`, so one cluster's copies can sit on either side of another asset. Because they share a master they are always in lockstep — variety comes from using several clusters, not from offsetting one.

A placement may also carry a `skinConfig` patch merged over the cluster's. Placements that resolve to a different skin (a `hideParts` variant, a different face) get their own master, so the cheap copies stay identical to each other. `smartVariantsCulling` (default `true`) additionally splits masters by culling tier, so small copies are culled for their own size instead of the largest copy's; set it to `false` to trade that back for one fewer ticking rig.

Placements accept `renderOnWeakDevice` but not `priority` — the cluster owns skip cadence for every copy.

### `group`

A group has no geometry of its own. It exists so one call can move many assets at once, and so a whole subtree can share quality settings.

```jsonc
{
  "id": "crowd",
  "name": "Crowd",
  "type": "group",
  "state": "idle",
  "priority": 0,
  "weakDeviceDistributionRatio": 0.5,
  "items": [
    { "id": "crowd_row_1", "type": "smartbva", "asset": "spectator", "distribution": [ /* … */ ] },
    { "id": "crowd_row_2", "type": "smartbva", "asset": "spectator", "distribution": [ /* … */ ] },
    { "id": "banner",      "type": "image",    "path": "/scenes/arena/banner.svg" }
  ]
}
```

`setAssetState('crowd', 'cheer')` cascades to every item, unless that item's own state was set more recently — most-recent-wins, not parent-always-wins. Quality fields resolve the other way: a child's `priority`, `full`, `renderOnWeakDevice`, or threshold overrides its group's, so a group can coarsen a whole crowd and one item can opt back out. Groups nest. `setAssetActive` on a group also hides (and mutes) its items.

### `sound`

A headless clip. No geometry, no culling, no pose-skip. It either follows `effectiveState` like a visual, or waits for `playSound`. Nest one in a group to ride the parent's state (`setAssetState('fans', 'goal')` switches the crowd bed and can fire a cheer oneshot).

`clip` is a key in the `clips` map passed to `<GameField>`. A missing key is treated as a URL, same as `image.path`.

```jsonc
{
  "id": "crowd_ambience",
  "type": "sound",
  "channel": "bg",
  "loop": true,
  "states": [
    { "state": "idle", "clip": "crowd_idle", "volume": 0.15 },
    { "state": "goal", "clip": "crowd_goal", "volume": 0.25 },
    { "state": "save", "clip": "crowd_save", "volume": 0.2 }
  ]
}
```

| key | effect |
|---|---|
| `loop` | `true` = exclusive bed per asset id (stop the previous clip on this id). Default `false` (oneshot). |
| `trigger` | `state` (default) follows effectiveState. `manual` ignores state; only `playSound` plays. |
| `channel` | `bg` or `sfx`. Default `loop ? 'bg' : 'sfx'`. Host `bgEnabled` / `sfxEnabled` gate these. |
| `volume` | 0..1 per asset or per state. The field also has a master `volume` prop. |
| `cues` | Named sequences. `playSound('sfx', 'kick_goal')` runs `[{ clip, at?, volume? }]`. `at` is ms from the cue start. |

Oneshots fire when the state is **set**, including a re-set of the same name. A state with no `clip` is silence. `active: false` and `renderOnWeakDevice: false` mute. The player owns Web Audio; the host only passes `clips`, `bgEnabled`, `sfxEnabled`, and `volume`.

### Timing programs

`timing` is a small script run against the chosen segment, counted in field frames:

| token | effect |
|---|---|
| `n` (≥ 1) | hold the current frame for `n` frames |
| `"n:m"` | play frames `n` through `m` (`"n:"` / `":m"` are open-ended) |
| `":"` | play the whole segment |
| `-1` | stop — freeze here and do not loop |

A program loops after its last step. Omitting `timing` entirely means play once, then hold the last frame.

```jsonc
{ "state": "idle", "segment": "idle_wave", "timing": [":", 18] }
// play the gesture, wait 18 frames, repeat

{ "state": "attack", "segment": "jump_left", "timing": ["0:32", -1] }
// play to frame 32 and hold that pose
```

Ranges are clamped to the baked length, so a config keeps working after a re-bake shortens a clip.

### Driving the field

Import the scene stylesheet once:

```ts
import 'bva-player-react/gamefield.css';
```

JSON names a rig (`"asset": "hero"`); the host app supplies URLs and optional hooks:

```tsx
import { GameField, type RigSource } from 'bva-player-react';

const rigs: Record<string, RigSource> = {
  hero: {
    motionUrl: '/bva/hero/hero.bva',
    layerUrl: '/bva/hero/assets/hero.svg.json',
    buildVariables: (skin) =>
      skin?.colors
        ? { hair_color: skin.colors.hair_color ?? '#000' }
        : undefined,
  },
};

<GameField
  ref={fieldRef}
  config={config}
  rigs={rigs}
  clips={{ crowd_idle: '/sounds/crowd-idle.mp3' }}
  bgEnabled
  sfxEnabled
  volume={1}
/>

fieldRef.current.setAssetState('hero', 'attack');
fieldRef.current.setAssetState('crowd', 'cheer'); // group: cascades to items + nested sounds
fieldRef.current.playSound('sfx', 'kick_goal');
```

The imperative handle also exposes `getAssetState`, `setAssetActive`, `setAssetSkin` (a live skin patch that wins over host overrides), `getStateDurationMs` for sequencing one state after another, and `playSound` / `stopSound` for manual cues.

`prepareBundle` on a `RigSource` can rewrite a resolved layer (for example compositing another skin) without the scene runtime knowing about it.

`prepareMotion` can return an adapted motion before SVG, raster, or canvas rendering. Keep the callback stable and return new data rather than mutating the shared downloaded motion; use it to align a trajectory with a host layout without adding a separate CSS animation.

`smartbva` is one off-screen master rig plus many SVG `<use>` draws, so a crowd costs one ticker. Export `SmartBvaMaster` / `SmartBvaDraw` if you need to compose that pattern yourself.

## Layer merge rules

`resolveLayerBundle` / `loadAssetBundle` for a layer file:

1. Pick skin `S` (explicit, or first named skin that is not `_common`).
2. Merge `skins._common` with `skins[S]` per part.
3. Body elements merge by index; skin overlays may supply only differing attrs (e.g. `{ "fill": "#E8AAAA" }`).
4. String attrs starting with `$` are replaced from `{ ...raw.variables, ...opts.variables }` (values may be `string | number | boolean`).
5. Element `id` / `url(#id)` / `href="#id"` are prefixed with the skin name so several skins of one rig can share a document (gamefield crowds).
6. Meta `render` on a body element (not emitted as SVG): omit/`true` → include; `false` → skip; `"$name"` → resolve (missing / `"false"` / `0` → skip). Use this to select among alternate shapes in one part.

Legacy flat `{ parts }` `.svg.json` files still decode via `decodeSvgBundle`.

## Wire format

`BVA_VERSION` must stay in sync with `bva-baker-js/lib/motion-text.mjs` (currently **3**). Older `.bva` files without a `##version` header parse as version `0`. Version 1 files (matrices only) still parse; missing opacity defaults to `1`.

A whole (tiny) file, one part in two segments:

```text
##version
3
#fps
24
#srcFps
30
#canvas
1200,675
#stage
1,0,0,1,0,0
#segments
##idle
###parts
####Base
833.24,827.41,.27,0,0,.27
*23
##jump
###parts
####Base
833.24,827.41,.27,0,0,.27
836.19
..75
o.5
*4
```

Headers carry the playback `fps`, the `srcFps` it was resampled from, the authoring `canvas` size, and the `stage` matrix placing the rig on it. `##idle` opens a segment, `####Base` a part inside it, and every following line is one frame. Frame lines are written **reversed** (`f,e,d,c,b,a`), so `833.24,827.41,.27,0,0,.27` means `matrix(.27, 0, 0, .27, 827.41, 833.24)`; blank columns repeat the previous frame, `..75` reuses the previous integer part, `o.5` changes only opacity, and `*23` repeats the previous frame 23 more times. The encoder in `bva-baker-js/lib/motion-text.mjs` documents the full spec; `parseMotionText` here is its inverse.

Paint suffixes (version 3), glued with no comma in fixed order `[o…][f…][s…]`:

- Opacity: `827.41,833.24,.27,0,0,.27o.23` or `o.5` when only opacity changes.
- Fill / stroke: uppercase hex, no `#` (6 digits, or 3 when compressible) — `…o.23fF1F1F1`, `fABC`, `o.5s000`. When present, the player expands to `#RRGGBB` and writes onto shape children under the part group. Absent channels leave the static artwork alone.

### Scene camera and extended artwork

`GameField` accepts an optional `viewport={{ x, y, w, h }}` in the original scene's
coordinate system. The camera is fitted into the host's box; asset positions,
rig canvases, culling scales, and HTML slots remain in scene coordinates. Omit it
to use `{ x: 0, y: 0, ...config.size }`, preserving existing consumers.

`GameFieldConfig.artworkBounds` optionally describes the background area available
outside the original frame. A host can use a wider or taller camera within those
bounds to reveal background instead of cropping the original scene. The host
chooses the camera and supplies a container with the same aspect ratio. Studio
uses this for its screen presets and shaded extension guide.


### Mobile haptic feedback

The core exports `createHapticFeedback()` for reuse outside React. It wraps
[WebHaptics](https://github.com/lochie/web-haptics), the library behind
[haptics.lochie.me](https://haptics.lochie.me): Android uses `navigator.vibrate`,
and iOS uses the hidden native switch fallback. Unsupported browsers skip
physical feedback. Browser and device haptic settings still apply.

```ts
import { createHapticFeedback } from 'bva-player-react'

const haptics = createHapticFeedback()
// Call directly in a click/pointer handler to preserve the iOS user gesture.
haptics.play('heavy')
haptics.play([
  { duration: 35, intensity: 1 },
  { delay: 500, duration: 55, intensity: 1 },
])
haptics.stop()             // also cancels delayed impacts
haptics.setEnabled(false)  // stops feedback; future plays are ignored
haptics.destroy()          // release resources when the owner unmounts
```

`play` accepts WebHaptics presets, a duration in milliseconds, an alternating
on/off `number[]`, or vibration objects with `duration`, `delay`, and `intensity`.
Starting a pattern replaces the previous one. Construction is safe during SSR;
DOM resources are created lazily. Hiding the page cancels the current pattern.

`GameField` owns a controller and exposes `field.playHaptic(pattern)` and
`field.stopHaptics()` through its ref. Set `hapticsEnabled={false}` to disable it;
it is enabled by default and independent of `bgEnabled`, `sfxEnabled`, and
`volume`. Field changes and unmounts stop feedback and remove the iOS switch.
