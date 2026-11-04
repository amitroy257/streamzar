// Core data model shared by the main process, preload and renderer.
// Everything in here must stay JSON-serialisable: it is persisted to disk and sent over IPC.

// ---------------------------------------------------------------------------
// Scenes & sources
// ---------------------------------------------------------------------------

export type SourceType =
  | 'color'
  | 'image'
  | 'slideshow'
  | 'media'
  | 'text'
  | 'browser'
  | 'video_capture'
  | 'display_capture'
  | 'window_capture'
  | 'audio_input'
  | 'audio_output'
  | 'scene'
  | 'alert_box'
  | 'chat_box'
  | 'event_list'
  | 'goal'
  | 'countdown'
  | 'stream_label';

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Placement of a scene item on the canvas, in base-canvas pixels.
 * (x, y) is the top-left corner of the scaled, *unrotated* box; rotation (degrees, clockwise)
 * is applied around the centre of that box.
 */
export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  crop: Crop;
  flipH: boolean;
  flipV: boolean;
}

export interface SceneItem {
  id: string;
  sourceId: string;
  visible: boolean;
  locked: boolean;
  transform: Transform;
}

export interface Scene {
  id: string;
  name: string;
  /** Render order: index 0 is drawn first (bottom-most). */
  items: SceneItem[];
}

export type VideoFilterType =
  | 'chroma_key'
  | 'color_key'
  | 'color_correction'
  | 'blur'
  | 'sharpen'
  | 'pixelate'
  | 'scroll'
  | 'image_mask'
  | 'lut';

export interface VideoFilter {
  id: string;
  type: VideoFilterType;
  name: string;
  enabled: boolean;
  settings: Record<string, number | string | boolean>;
}

export type AudioFilterType = 'gain' | 'noise_gate' | 'compressor' | 'limiter' | 'eq3' | 'highpass';

export interface AudioFilter {
  id: string;
  type: AudioFilterType;
  name: string;
  enabled: boolean;
  settings: Record<string, number | string | boolean>;
}

export type MonitoringType = 'off' | 'monitor-only' | 'monitor-output';

export interface AudioSettings {
  /** Fader position in dB (-inf is represented by -100). */
  volumeDb: number;
  muted: boolean;
  monitoring: MonitoringType;
  syncOffsetMs: number;
  /** -1 (left) .. 1 (right) */
  balance: number;
  mono: boolean;
  filters: AudioFilter[];
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  outline: boolean;
  outlineColor: string;
  outlineWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffset: number;
  align: 'left' | 'center' | 'right';
}

export interface ColorSourceSettings {
  color: string;
  width: number;
  height: number;
}

export interface ImageSourceSettings {
  path: string;
}

export interface SlideshowSourceSettings {
  paths: string[];
  intervalMs: number;
  transition: 'cut' | 'fade';
  transitionMs: number;
  loop: boolean;
  shuffle: boolean;
  width: number;
  height: number;
}

export interface MediaSourceSettings {
  path: string;
  loop: boolean;
  restartOnActivate: boolean;
  speedPercent: number;
}

export interface TextSourceSettings extends TextStyle {
  text: string;
  readFromFile: boolean;
  filePath: string;
  backgroundColor: string;
  backgroundOpacity: number;
  /** 0 = automatic size */
  wrapWidth: number;
  padding: number;
  lineSpacing: number;
}

export interface BrowserSourceSettings {
  url: string;
  width: number;
  height: number;
  fps: number;
  css: string;
  /** Route page audio into the mixer (best effort; otherwise the page is muted). */
  captureAudio: boolean;
  refreshOnActivate: boolean;
}

export interface VideoCaptureSettings {
  deviceId: string;
  deviceLabel: string;
  width: number;
  height: number;
  fps: number;
}

export interface DisplayCaptureSettings {
  /** desktopCapturer id, e.g. "screen:0:0" */
  captureId: string;
  captureName: string;
  captureCursor: boolean;
  fps: number;
}

export interface WindowCaptureSettings {
  captureId: string;
  captureName: string;
  fps: number;
}

export interface AudioInputSettings {
  deviceId: string;
  deviceLabel: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface AudioOutputSettings {
  /** Reserved for future per-device selection; desktop loopback captures the default output. */
  deviceId: string;
}

export interface SceneSourceSettings {
  sceneId: string;
}

export interface AlertBoxSettings {
  width: number;
  height: number;
  /** Empty = all enabled alert types */
  types: AlertType[];
}

export interface ChatBoxSettings extends TextStyle {
  width: number;
  height: number;
  maxMessages: number;
  hideAfterSec: number;
  showPlatformIcon: boolean;
  showBadges: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  messageBackground: boolean;
}

export interface EventListSettings extends TextStyle {
  width: number;
  height: number;
  maxEvents: number;
  types: AlertType[];
  backgroundColor: string;
  backgroundOpacity: number;
}

export interface GoalSettings extends TextStyle {
  width: number;
  height: number;
  title: string;
  goalType: 'follower' | 'subscriber' | 'donation' | 'bits' | 'superchat' | 'custom';
  current: number;
  target: number;
  barColor: string;
  barBackground: string;
  currency: string;
}

export interface CountdownSettings extends TextStyle {
  mode: 'countdown' | 'stopwatch' | 'clock' | 'stream_uptime';
  durationSec: number;
  /** ISO date-time; if set (countdown mode) counts down to this moment instead of using duration. */
  targetTime: string;
  format: 'hh:mm:ss' | 'mm:ss' | 'auto';
  endText: string;
  prefix: string;
  clock24h: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
}

export type StreamLabelKind =
  | 'latest_follower'
  | 'latest_subscriber'
  | 'latest_donation'
  | 'top_donation'
  | 'latest_cheer'
  | 'latest_raid'
  | 'latest_superchat'
  | 'latest_member'
  | 'session_follower_count'
  | 'session_subscriber_count'
  | 'session_donation_total'
  | 'viewer_count';

export interface StreamLabelSettings extends TextStyle {
  kind: StreamLabelKind;
  template: string;
  emptyText: string;
  backgroundColor: string;
  backgroundOpacity: number;
}

export interface SourceSettingsMap {
  color: ColorSourceSettings;
  image: ImageSourceSettings;
  slideshow: SlideshowSourceSettings;
  media: MediaSourceSettings;
  text: TextSourceSettings;
  browser: BrowserSourceSettings;
  video_capture: VideoCaptureSettings;
  display_capture: DisplayCaptureSettings;
  window_capture: WindowCaptureSettings;
  audio_input: AudioInputSettings;
  audio_output: AudioOutputSettings;
  scene: SceneSourceSettings;
  alert_box: AlertBoxSettings;
  chat_box: ChatBoxSettings;
  event_list: EventListSettings;
  goal: GoalSettings;
  countdown: CountdownSettings;
  stream_label: StreamLabelSettings;
}

interface SourceBase {
  id: string;
  name: string;
  filters: VideoFilter[];
  audio: AudioSettings;
}

export type SourceOf<K extends SourceType> = SourceBase & { type: K; settings: SourceSettingsMap[K] };
export type Source = { [K in SourceType]: SourceOf<K> }[SourceType];

export type TransitionType = 'cut' | 'fade' | 'fade_color' | 'slide' | 'swipe' | 'zoom' | 'luma_wipe' | 'stinger';

export interface TransitionSettings {
  type: TransitionType;
  durationMs: number;
  direction: 'left' | 'right' | 'up' | 'down';
  color: string;
  lumaPattern: 'linear_h' | 'linear_v' | 'radial' | 'clock' | 'diamond' | 'blinds';
  softness: number;
  invert: boolean;
  stingerPath: string;
  stingerPointMs: number;
  stingerVolume: number;
}

export interface SceneCollection {
  id: string;
  name: string;
  version: number;
  scenes: Scene[];
  sources: Source[];
  activeSceneId: string;
  /** Sources that are always mixed regardless of the active scene (Desktop Audio, Mic/Aux). */
  globalAudioSourceIds: string[];
  transition: TransitionSettings;
  updatedAt: number;
}

export interface CollectionMeta {
  id: string;
  name: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Alerts, chat & events
// ---------------------------------------------------------------------------

export type AlertType =
  | 'follow'
  | 'subscription'
  | 'gift_sub'
  | 'donation'
  | 'bits'
  | 'raid'
  | 'superchat'
  | 'membership'
  | 'stars';

export type ChatPlatform = 'twitch' | 'youtube' | 'facebook' | 'system';

export interface AlertEvent {
  id: string;
  type: AlertType;
  platform: ChatPlatform | 'webhook' | 'test';
  name: string;
  amount?: number;
  currency?: string;
  /** Human readable amount, e.g. "$5.00" or "500 bits" */
  formattedAmount?: string;
  message?: string;
  months?: number;
  count?: number;
  time: number;
}

export interface AlertTypeConfig {
  enabled: boolean;
  messageTemplate: string;
  durationMs: number;
  imagePath: string;
  soundPath: string;
  soundVolume: number;
  layout: 'above' | 'side' | 'text_over';
  animationIn: 'fade' | 'slide_down' | 'slide_up' | 'zoom' | 'bounce';
  animationOut: 'fade' | 'slide_down' | 'slide_up' | 'zoom';
  textColor: string;
  highlightColor: string;
  fontFamily: string;
  fontSize: number;
  showUserMessage: boolean;
  minAmount: number;
}

export interface AlertSettings {
  globalVolume: number;
  delayBetweenMs: number;
  types: Record<AlertType, AlertTypeConfig>;
}

export interface ChatEmote {
  start: number;
  end: number;
  url: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  platform: ChatPlatform;
  author: string;
  authorColor?: string;
  badges: string[];
  text: string;
  emotes: ChatEmote[];
  time: number;
  /** For paid messages (super chat, cheer) */
  highlight?: string;
  isAction?: boolean;
}

export type ChatConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ChatStatus {
  platform: Exclude<ChatPlatform, 'system'>;
  state: ChatConnectionState;
  detail?: string;
  viewers?: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type PlatformId =
  | 'youtube'
  | 'facebook'
  | 'twitch'
  | 'kick'
  | 'tiktok'
  | 'x'
  | 'linkedin'
  | 'trovo'
  | 'instagram'
  | 'rumble'
  | 'custom';

export interface Destination {
  id: string;
  platform: PlatformId;
  name: string;
  enabled: boolean;
  server: string;
  streamKey: string;
}

export type EncoderId =
  | 'libx264'
  | 'h264_nvenc'
  | 'h264_qsv'
  | 'h264_amf'
  | 'h264_videotoolbox'
  | 'h264_vaapi'
  | 'libx265'
  | 'hevc_nvenc'
  | 'hevc_qsv'
  | 'hevc_amf'
  | 'hevc_videotoolbox';

export type RateControl = 'cbr' | 'vbr' | 'cqp';

/** Generic speed/quality knob mapped to each encoder's own preset names. */
export type QualityPreset = 'speed' | 'balanced' | 'quality' | 'max_quality';

export interface EncoderSettings {
  encoder: EncoderId;
  rateControl: RateControl;
  /** kbps */
  videoBitrate: number;
  /** kbps, VBR peak */
  maxBitrate: number;
  /** quantizer/CRF for CQP mode */
  cq: number;
  keyframeSec: number;
  preset: QualityPreset;
  profile: 'baseline' | 'main' | 'high';
  bframes: number;
  /** kbps */
  audioBitrate: number;
}

export type RecordingFormat = 'mp4' | 'fmp4' | 'mkv' | 'mov' | 'flv' | 'ts';
export type RecordingQuality = 'stream' | 'high' | 'indistinguishable' | 'custom';

export interface RecordingSettings {
  path: string;
  format: RecordingFormat;
  quality: RecordingQuality;
  /** Only used when quality === 'custom' */
  encoder: EncoderSettings;
  filenameFormat: string;
}

export interface ReplayBufferSettings {
  durationSec: number;
  format: RecordingFormat;
}

export interface VideoSettings {
  baseWidth: number;
  baseHeight: number;
  outputWidth: number;
  outputHeight: number;
  fpsNum: number;
  fpsDen: number;
  scaleFilter: 'bilinear' | 'bicubic' | 'lanczos';
}

export interface AudioDeviceSettings {
  sampleRate: 44100 | 48000;
  /** '' = system default */
  monitoringDeviceId: string;
}

export interface StreamSettings {
  destinations: Destination[];
  autoReconnect: boolean;
  reconnectDelaySec: number;
  maxRetries: number;
  delaySec: number;
  confirmStart: boolean;
  confirmStop: boolean;
}

export type HotkeyAction =
  | 'toggleStream'
  | 'startStream'
  | 'stopStream'
  | 'toggleRecording'
  | 'startRecording'
  | 'stopRecording'
  | 'toggleReplayBuffer'
  | 'saveReplay'
  | 'toggleStudioMode'
  | 'transition'
  | 'screenshot';

export interface IntegrationSettings {
  twitch: { enabled: boolean; channel: string; username: string; oauthToken: string };
  youtube: { enabled: boolean; apiKey: string; channelId: string; videoId: string; oauthToken: string };
  facebook: { enabled: boolean; liveVideoId: string; accessToken: string };
}

export interface ServerSettings {
  /** Local HTTP API for alert webhooks & remote control */
  enabled: boolean;
  port: number;
  token: string;
  /** Listen on all interfaces so phones on the LAN can use the remote control */
  allowLan: boolean;
}

export interface GeneralSettings {
  theme: 'dark' | 'light';
  snapping: boolean;
  snapDistance: number;
  showChat: boolean;
  keepRecordingWhenStreamStops: boolean;
  recordWhenStreaming: boolean;
  replayBufferWhileStreaming: boolean;
}

export interface AdvancedSettings {
  ffmpegPath: string;
  processPriority: 'normal' | 'above_normal' | 'high';
  verboseLogging: boolean;
  hardwareAcceleration: boolean;
}

export interface AppSettings {
  version: number;
  general: GeneralSettings;
  video: VideoSettings;
  audio: AudioDeviceSettings;
  stream: StreamSettings;
  output: {
    stream: EncoderSettings;
    recording: RecordingSettings;
    replayBuffer: ReplayBufferSettings;
  };
  hotkeys: Record<string, string>;
  integrations: IntegrationSettings;
  alerts: AlertSettings;
  server: ServerSettings;
  advanced: AdvancedSettings;
}

// ---------------------------------------------------------------------------
// Output status (main -> renderer)
// ---------------------------------------------------------------------------

export type DestinationState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'stopping';

export interface DestinationStatus {
  id: string;
  name: string;
  platform: PlatformId;
  state: DestinationState;
  error?: string;
  kbps: number;
  droppedFrames: number;
  retries: number;
  connectedAt?: number;
}

export interface EncoderStatus {
  id: string;
  label: string;
  encoder: EncoderId;
  fps: number;
  speed: number;
  kbps: number;
  skippedFrames: number;
  lagging: boolean;
}

export interface OutputStatus {
  streaming: boolean;
  streamStarting: boolean;
  streamStopping: boolean;
  streamStartedAt: number | null;
  /** Seconds remaining while a delayed stream is draining */
  stopCountdownSec: number;
  delaySec: number;
  destinations: DestinationStatus[];
  recording: boolean;
  recordingStartedAt: number | null;
  recordingPath: string | null;
  replayBuffer: boolean;
  replayBufferSeconds: number;
  encoders: EncoderStatus[];
  lastError: string | null;
}

export interface CaptureRequest {
  active: boolean;
  port: number;
  token: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
}

export interface SystemStats {
  cpuPercent: number;
  appCpuPercent: number;
  memoryMB: number;
}

export interface EncoderInfo {
  id: EncoderId;
  label: string;
  hardware: boolean;
  codec: 'h264' | 'hevc';
  available: boolean;
}

export interface CaptureSourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  displayId?: string;
}

export interface RemoteState {
  scenes: { id: string; name: string }[];
  activeSceneId: string;
  previewSceneId: string | null;
  studioMode: boolean;
  audio: { id: string; name: string; muted: boolean; volumeDb: number }[];
  output: Pick<OutputStatus, 'streaming' | 'recording' | 'replayBuffer' | 'streamStartedAt' | 'recordingStartedAt'>;
}

export type RemoteCommand =
  | { type: 'switchScene'; sceneId: string }
  | { type: 'previewScene'; sceneId: string }
  | { type: 'transition' }
  | { type: 'toggleMute'; sourceId: string }
  | { type: 'setVolume'; sourceId: string; volumeDb: number }
  | { type: 'toggleStudioMode' }
  | { type: 'hotkey'; action: string };

export interface ServerInfo {
  running: boolean;
  port: number;
  token: string;
  urls: string[];
  error?: string;
}

export interface BrowserSourceOptions {
  url: string;
  width: number;
  height: number;
  fps: number;
  css: string;
  audible: boolean;
}

export interface BrowserSourceFrame {
  id: string;
  width: number;
  height: number;
  /** dirty rect */
  x: number;
  y: number;
  w: number;
  h: number;
  /** BGRA premultiplied pixels for the dirty rect */
  data: Uint8Array;
}
