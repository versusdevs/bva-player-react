export {
  BVA_VERSION,
  BakedVectorPlayer,
  decodeSvgBundle,
  loadAssetBundle,
  loadMotion,
  loadRasterBundle,
  parseMotionText,
  pickRasterScale,
  resolveSegmentName,
  prefetchAssetBundle,
  prepareSvgMarkup,
  preload,
  resolveLayerBundle,
  visibilityQuantizers,
} from './baked-vector-animation';

export type {
  AssetBundle,
  AssetPart,
  BundleVariableValue,
  BakedVectorPlayerOptions,
  LoadAssetBundleOptions,
  LoadRasterBundleOptions,
  Matrix6,
  MotionData,
  MotionPart,
  MotionSegment,
  PlayOptions,
  Quantizers,
  RasterBundle,
  RasterIndex,
  RasterPart,
  RasterRect,
  RawSvgBundle,
} from './baked-vector-animation';

export {
  DEFAULT_RASTERED_LAYER_BUDGET,
  RasteredRigPainter,
  RasteredCrowd,
  rasterScaleForPart,
} from './rastered-rig-painter';
export type {
  RasterInstanceHandle,
  RasterInstancePlacement,
} from './rastered-rig-painter';

export {
  CanvasRigPainter,
  CanvasCrowd,
  isCanvasPoseCacheEnabled,
  isCanvasCrowdCacheEnabled,
  setCanvasPoseCache,
  setCanvasCrowdCache,
} from './canvas-rig-painter';
export type {
  CanvasPaintPlacement,
  CanvasPaintSource,
  Rect as CanvasRigRect,
} from './canvas-rig-painter';
export type { Rect as CanvasCrowdRect } from './canvas-rig-painter';
export { CanvasImageSource } from './canvas-image-source';

export { BvaLoader } from './BvaLoader';
export type { BvaLoaderProps } from './BvaLoader';
export { BvaPlayer } from './BvaPlayer';
export type { BvaPlayerHandle, BvaPlayerProps } from './BvaPlayer';

export { createHapticFeedback } from './haptics';
export type {
  HapticFeedback,
  HapticFeedbackOptions,
  HapticInput,
  HapticPattern,
  HapticPreset,
  HapticTriggerOptions,
  HapticVibration,
} from './haptics';

export { GameField } from './gamefield/GameField';
export type { GameFieldProps } from './gamefield/GameField';
export { BvaAsset } from './gamefield/BvaAsset';
export type { BvaAssetProps } from './gamefield/BvaAsset';
export { SmartBvaDraw, SmartBvaMaster } from './gamefield/SmartBvaAsset';
export type {
  SmartBvaDrawProps,
  SmartBvaMasterProps,
} from './gamefield/SmartBvaAsset';
export {
  RasteredSmartBvaDraw,
  RasteredSmartBvaMaster,
} from './gamefield/RasteredSmartBva';
export type {
  RasteredSmartBvaDrawProps,
  RasteredSmartBvaMasterProps,
} from './gamefield/RasteredSmartBva';
export {
  CanvasSurface,
  CanvasRigMaster,
  CanvasImageMaster,
  CanvasBandSurface,
  CanvasSmartBvaMaster,
} from './gamefield/CanvasRig';
export type {
  CanvasSurfaceEntry,
  CanvasSurfaceProps,
  CanvasRigMasterProps,
  CanvasImageMasterProps,
  CanvasBandEntry,
  CanvasBandSurfaceProps,
  CanvasSmartBvaMasterProps,
} from './gamefield/CanvasRig';
export { useRigPlayer } from './gamefield/useRigPlayer';
export type {
  RigPlayback,
  UseRigPlayerOptions,
} from './gamefield/useRigPlayer';
export {
  canvasPlacement,
  findFieldAsset,
  flattenAssets,
  mergeSkinConfig,
  smartMasterId,
  smartVariants,
} from './gamefield/layout';
export type { FlatAsset, SmartSkinVariant } from './gamefield/layout';
export {
  effectiveSkipN,
  placementQualityKey,
  resolveAssetQuality,
  resolveFieldQuality,
  resolvePlacementRenderOnWeak,
  resolveSmartCulling,
} from './gamefield/resolveQuality';
export type {
  FieldQualityConfig,
  ResolvedAssetQuality,
  SmartCullingConfig,
} from './gamefield/resolveQuality';
export {
  clusterTier,
  cullThresholdsFor,
  cullTierFor,
  motionPartScales,
  motionStageScale,
  tierScale,
} from './gamefield/cullTier';
export {
  isCullable,
  partLocalRadius,
  shapeMetrics,
} from './gamefield/shapeSize';
export type { ShapeMetrics } from './gamefield/shapeSize';
export { useDevicePixelRatio, useFitScale } from './gamefield/useFitScale';
export {
  EMPTY_WEAK_DISTRIBUTION_CULLS,
  keepCount,
  pickStableSubset,
  resolveWeakDistributionCulls,
} from './gamefield/weakDistribution';
export type { WeakDistributionCulls } from './gamefield/weakDistribution';
export {
  getFieldPerf,
  subscribeFieldPerf,
  subscribeFrames,
  subscribePostFrame,
} from './gamefield/frameClock';
export type { FieldPerf, QualityPhase } from './gamefield/frameClock';
export { useFieldPerf } from './gamefield/useFieldPerf';
export {
  getFieldN,
  getQualitySnapshot,
  isFieldWeak,
  markQualityRigReady,
  recordPoseSkip,
  registerQualityRig,
  resetQuality,
  setForceWeak,
  setQualityConfig,
  skipNForPriority,
  subscribeQuality,
  unregisterQualityRig,
} from './gamefield/fieldQuality';
export type { QualitySnapshot } from './gamefield/fieldQuality';
export { useFieldQuality } from './gamefield/useFieldQuality';
export { compileTiming, createTimingRunner } from './gamefield/timing';
export type { TimingProgram, TimingRunner } from './gamefield/timing';
export {
  evictGameFieldConfigCache,
  primeGameFieldConfigCache,
  useGameFieldConfig,
} from './gamefield/useGameFieldConfig';

export {
  collectSoundUrls,
  findSoundState,
  resolveClipUrl,
  soundChannel,
  soundLoop,
  soundVolume,
} from './gamefield/soundAssets';
export {
  createFieldAudio,
  unlockFieldAudio,
} from './gamefield/fieldAudio';
export type {
  FieldAudio,
  FieldAudioHandle,
  FieldAudioPlayRequest,
} from './gamefield/fieldAudio';

export type {
  BvaAssetConfig,
  CanvasAssetConfig,
  GameFieldAsset,
  GameFieldConfig,
  GameFieldHandle,
  GroupAssetConfig,
  ImageAssetConfig,
  HtmlAssetConfig,
  RigSource,
  SkinConfig,
  SmartBvaAssetConfig,
  SmartBvaPlacement,
  SoundAssetConfig,
  SoundChannel,
  SoundCueStep,
  SoundStateDef,
  SoundTrigger,
  StateDef,
  TimingStep,
  Vec2,
} from './gamefield/types';
export {
  isContainerAsset,
  resolveCanvasPoseCache,
} from './gamefield/types';
export {
  DEFAULT_CANVAS,
  DEFAULT_CANVAS_POSE_CACHE,
  DEFAULT_CANVAS_CROWD_CACHE,
  DEFAULT_FULL,
  DEFAULT_RASTERED,
  DEFAULT_MAX_N,
  DEFAULT_MEASURE_MS,
  DEFAULT_PRIORITY,
  DEFAULT_RENDER_ON_WEAK,
  DEFAULT_SMART_CULLING,
  DEFAULT_SMART_CULLING_THRESHOLD_CSS_PX,
  DEFAULT_SMART_MOTION_THRESHOLD_PX,
  DEFAULT_SMART_VARIANTS_CULLING,
  DEFAULT_WEAK_AVG_JS_MS,
  DEFAULT_WEAK_DEVICE_DISTRIBUTION_RATIO,
  DEFAULT_WEAK_RAF_HZ,
  DEFAULT_WEAK_TOTAL_SKIPS,
} from './gamefield/types';

export { CssAnimationPlayer, preloadCssImage, useReducedMotion } from './CssAnimationPlayer';
export type { CssAnimationPlayerProps } from './CssAnimationPlayer';
