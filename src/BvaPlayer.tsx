import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { BvaLoadingOverlay } from './BvaLoader';
import {
  BakedVectorPlayer,
  type AssetBundle,
  type BakedVectorPlayerOptions,
  type MotionData,
} from './baked-vector-animation';

export interface BvaPlayerHandle {
  gotoFrame: (frame: number) => void;
  getFrame: () => number;
  getSegmentFrames: () => number;
  pause: () => void;
  play: () => void;
}

export interface BvaPlayerProps {
  /** Pass null while the motion is loading. */
  motion: MotionData | null;
  /** Pass null while the asset bundle is loading. */
  bundle: AssetBundle | null;
  /** Custom loading content, e.g. <MyLoader />. Null disables the indicator. */
  loader?: ReactNode;
  /** Segment to show / play. Defaults to the first segment in motion. */
  segment?: string;
  /** When true, plays (or continues) the current segment. Default false. */
  playing?: boolean;
  /** Loop the current segment while playing. Default true. */
  loop?: boolean;
  /** Playback speed multiplier. Default 1. */
  speed?: number;
  /**
   * Called once when initialization finishes and the loading indicator is removed.
   * Fires again after a new motion or a null input starts another loading cycle.
   */
  onReady?: () => void;
  /** Called when a non-looping segment finishes. */
  onComplete?: () => void;
  /** Called once per advanced frame while playing. */
  onEnterFrame?: (frame: number) => void;
  className?: string;
  style?: CSSProperties;
  playerOptions?: Omit<BakedVectorPlayerOptions, 'initialSegment'>;
}

/**
 * React wrapper around `BakedVectorPlayer`. Mounts a DOM SVG into a container
 * ref and keeps segment / skin / playback props in sync.
 */
export const BvaPlayer = forwardRef<BvaPlayerHandle, BvaPlayerProps>(
  function BvaPlayer(
    {
      motion,
      bundle,
      segment,
      playing = false,
      loop = true,
      speed = 1,
      onReady,
      onComplete,
      onEnterFrame,
      className,
      style,
      playerOptions,
      loader,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<BakedVectorPlayer | null>(null);
    const [mountedMotion, setMountedMotion] = useState<MotionData | null>(null);
    const hasBundle = bundle !== null;
    const loading = !motion || !hasBundle || mountedMotion !== motion;
    const onReadyRef = useRef(onReady);
    const readyReportedRef = useRef(false);
    onReadyRef.current = onReady;
    const onCompleteRef = useRef(onComplete);
    const onEnterFrameRef = useRef(onEnterFrame);
    onCompleteRef.current = onComplete;
    onEnterFrameRef.current = onEnterFrame;

    useImperativeHandle(
      ref,
      () => ({
        gotoFrame: (frame: number) => playerRef.current?.gotoFrame(frame),
        getFrame: () => playerRef.current?.getFrame() ?? 0,
        getSegmentFrames: () => playerRef.current?.getSegmentFrames() ?? 0,
        pause: () => playerRef.current?.pause(),
        play: () => {
          playerRef.current?.play(undefined, {
            loop,
            onComplete: () => onCompleteRef.current?.(),
            onEnterFrame: (f) => onEnterFrameRef.current?.(f),
          });
        },
      }),
      [loop],
    );

    // Create when both inputs are available; recreate when motion changes.
    useEffect(() => {
      const el = containerRef.current;
      if (!el || !motion || !bundle) return;

      const initialSegment =
        segment ?? Object.keys(motion.segments)[0] ?? '';
      const player = new BakedVectorPlayer(el, motion, bundle, {
        ...playerOptions,
        initialSegment: initialSegment || undefined,
      });
      playerRef.current = player;
      setMountedMotion(motion);

      return () => {
        player.destroy();
        playerRef.current = null;
      };
      // Bundle contents and segment sync below without restarting playback.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [motion, hasBundle]);

    useEffect(() => {
      if (bundle) playerRef.current?.setBundle(bundle);
    }, [bundle]);

    useEffect(() => {
      if (segment) playerRef.current?.setSegment(segment);
    }, [segment, motion, hasBundle]);

    useEffect(() => {
      playerRef.current?.setSpeed(speed);
    }, [speed, motion, hasBundle]);

    useEffect(() => {
      const player = playerRef.current;
      if (!player) return;

      if (playing) {
        // Do not pass segment — setSegment already synced it; passing would
        // reset the frame on every pause/resume.
        player.play(undefined, {
          loop,
          onComplete: () => onCompleteRef.current?.(),
          onEnterFrame: (f) => onEnterFrameRef.current?.(f),
        });
      } else {
        player.pause();
      }
    }, [playing, loop, segment, motion, hasBundle]);

    // Notify after the ready render commits, so the loader is gone and the
    // imperative handle and playback props are already synchronized.
    useEffect(() => {
      if (loading) {
        readyReportedRef.current = false;
        return;
      }
      if (readyReportedRef.current || !playerRef.current) return;
      readyReportedRef.current = true;
      onReadyRef.current?.();
    }, [loading]);

    return (
      <div
        className={className}
        aria-busy={loading}
        style={{ position: 'relative', width: '100%', height: '100%', ...style }}
      >
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loading && <BvaLoadingOverlay>{loader}</BvaLoadingOverlay>}
      </div>
    );
  },
);
