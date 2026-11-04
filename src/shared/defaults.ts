import type {
  AlertSettings,
  AlertType,
  AlertTypeConfig,
  AppSettings,
  AudioFilter,
  AudioFilterType,
  AudioSettings,
  EncoderSettings,
  Scene,
  SceneCollection,
  SceneItem,
  Source,
  SourceOf,
  SourceSettingsMap,
  SourceType,
  TextStyle,
  Transform,
  TransitionSettings,
  VideoFilter,
  VideoFilterType,
} from './types';
import { uid } from './util';

export const SETTINGS_VERSION = 1;
export const COLLECTION_VERSION = 1;

export const DEFAULT_STREAM_ENCODER: EncoderSettings = {
  encoder: 'libx264',
  rateControl: 'cbr',
  videoBitrate: 6000,
  maxBitrate: 9000,
  cq: 20,
  keyframeSec: 2,
  preset: 'balanced',
  profile: 'high',
  bframes: 2,
  audioBitrate: 160,
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Arial',
  fontSize: 48,
  bold: false,
  italic: false,
  underline: false,
  color: '#ffffff',
  outline: false,
  outlineColor: '#000000',
  outlineWidth: 4,
  shadow: false,
  shadowColor: '#000000',
  shadowBlur: 6,
  shadowOffset: 3,
  align: 'left',
};

function alertConfig(template: string, extra: Partial<AlertTypeConfig> = {}): AlertTypeConfig {
  return {
    enabled: true,
    messageTemplate: template,
    durationMs: 6000,
    imagePath: '',
    soundPath: '',
    soundVolume: 0.8,
    layout: 'above',
    animationIn: 'bounce',
    animationOut: 'fade',
    textColor: '#ffffff',
    highlightColor: '#31c3a2',
    fontFamily: 'Arial',
    fontSize: 42,
    showUserMessage: true,
    minAmount: 0,
    ...extra,
  };
}

export const ALERT_TYPES: AlertType[] = [
  'follow',
  'subscription',
  'gift_sub',
  'donation',
  'bits',
  'raid',
  'superchat',
  'membership',
  'stars',
];

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  follow: 'Follow',
  subscription: 'Subscription',
  gift_sub: 'Gift Subs',
  donation: 'Donation / Tip',
  bits: 'Bits / Cheer',
  raid: 'Raid',
  superchat: 'Super Chat',
  membership: 'Membership',
  stars: 'Facebook Stars',
};

export const DEFAULT_ALERTS: AlertSettings = {
  globalVolume: 1,
  delayBetweenMs: 1000,
  types: {
    follow: alertConfig('{name} just followed!', { durationMs: 5000 }),
    subscription: alertConfig('{name} just subscribed! {months}', { durationMs: 7000 }),
    gift_sub: alertConfig('{name} gifted {count} subs!', { durationMs: 7000 }),
    donation: alertConfig('{name} donated {amount}!', { durationMs: 8000 }),
    bits: alertConfig('{name} cheered {amount}!', { durationMs: 7000 }),
    raid: alertConfig('{name} is raiding with {count} viewers!', { durationMs: 8000 }),
    superchat: alertConfig('{name} sent a Super Chat of {amount}!', { durationMs: 8000 }),
    membership: alertConfig('{name} became a member!', { durationMs: 7000 }),
    stars: alertConfig('{name} sent {amount}!', { durationMs: 7000 }),
  },
};

export const HOTKEY_LABELS: Record<string, string> = {
  toggleStream: 'Start / stop streaming',
  startStream: 'Start streaming',
  stopStream: 'Stop streaming',
  toggleRecording: 'Start / stop recording',
  startRecording: 'Start recording',
  stopRecording: 'Stop recording',
  toggleReplayBuffer: 'Start / stop replay buffer',
  saveReplay: 'Save replay',
  toggleStudioMode: 'Toggle studio mode',
  transition: 'Studio mode: transition',
  screenshot: 'Save screenshot of program',
};

export function defaultSettings(): AppSettings {
  return {
    version: SETTINGS_VERSION,
    general: {
      theme: 'dark',
      snapping: true,
      snapDistance: 12,
      showChat: true,
      keepRecordingWhenStreamStops: true,
      recordWhenStreaming: false,
      replayBufferWhileStreaming: false,
    },
    video: {
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNum: 30,
      fpsDen: 1,
      scaleFilter: 'bicubic',
    },
    audio: {
      sampleRate: 48000,
      monitoringDeviceId: '',
    },
    stream: {
      destinations: [],
      autoReconnect: true,
      reconnectDelaySec: 5,
      maxRetries: 25,
      delaySec: 0,
      confirmStart: false,
      confirmStop: true,
    },
    output: {
      stream: { ...DEFAULT_STREAM_ENCODER },
      recording: {
        path: '',
        format: 'mp4',
        quality: 'stream',
        encoder: { ...DEFAULT_STREAM_ENCODER, rateControl: 'cqp', cq: 18, videoBitrate: 20000, maxBitrate: 40000, preset: 'quality' },
        filenameFormat: 'Streamzar %Y-%m-%d %H-%M-%S',
      },
      replayBuffer: {
        durationSec: 30,
        format: 'mp4',
      },
    },
    hotkeys: {},
    integrations: {
      twitch: { enabled: false, channel: '', username: '', oauthToken: '' },
      youtube: { enabled: false, apiKey: '', channelId: '', videoId: '', oauthToken: '' },
      facebook: { enabled: false, liveVideoId: '', accessToken: '' },
    },
    alerts: JSON.parse(JSON.stringify(DEFAULT_ALERTS)) as AlertSettings,
    server: {
      enabled: true,
      port: 59650,
      token: '',
      allowLan: false,
    },
    advanced: {
      ffmpegPath: '',
      processPriority: 'above_normal',
      verboseLogging: false,
      hardwareAcceleration: true,
    },
  };
}

export function defaultTransform(): Transform {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false };
}

export function defaultAudioSettings(): AudioSettings {
  return { volumeDb: 0, muted: false, monitoring: 'off', syncOffsetMs: 0, balance: 0, mono: false, filters: [] };
}

export function defaultTransition(): TransitionSettings {
  return {
    type: 'fade',
    durationMs: 300,
    direction: 'left',
    color: '#000000',
    lumaPattern: 'linear_h',
    softness: 0.1,
    invert: false,
    stingerPath: '',
    stingerPointMs: 500,
    stingerVolume: 1,
  };
}

export function defaultSourceSettings<K extends SourceType>(type: K, base = { width: 1920, height: 1080 }): SourceSettingsMap[K] {
  const map: { [T in SourceType]: () => SourceSettingsMap[T] } = {
    color: () => ({ color: '#2b2f3a', width: base.width, height: base.height }),
    image: () => ({ path: '' }),
    slideshow: () => ({ paths: [], intervalMs: 5000, transition: 'fade', transitionMs: 700, loop: true, shuffle: false, width: base.width, height: base.height }),
    media: () => ({ path: '', loop: true, restartOnActivate: true, speedPercent: 100 }),
    text: () => ({
      ...DEFAULT_TEXT_STYLE,
      text: 'Hello, world!',
      readFromFile: false,
      filePath: '',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      wrapWidth: 0,
      padding: 8,
      lineSpacing: 1.2,
    }),
    browser: () => ({ url: 'https://example.com', width: 800, height: 600, fps: 30, css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }', captureAudio: false, refreshOnActivate: false }),
    video_capture: () => ({ deviceId: '', deviceLabel: '', width: 1920, height: 1080, fps: 30 }),
    display_capture: () => ({ captureId: '', captureName: '', captureCursor: true, fps: 30 }),
    window_capture: () => ({ captureId: '', captureName: '', fps: 30 }),
    audio_input: () => ({ deviceId: 'default', deviceLabel: 'Default', noiseSuppression: true, echoCancellation: false, autoGainControl: false }),
    audio_output: () => ({ deviceId: 'default' }),
    scene: () => ({ sceneId: '' }),
    alert_box: () => ({ width: 800, height: 600, types: [] }),
    chat_box: () => ({
      ...DEFAULT_TEXT_STYLE,
      fontSize: 26,
      width: 520,
      height: 640,
      maxMessages: 30,
      hideAfterSec: 0,
      showPlatformIcon: true,
      showBadges: true,
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      messageBackground: true,
    }),
    event_list: () => ({
      ...DEFAULT_TEXT_STYLE,
      fontSize: 24,
      width: 420,
      height: 360,
      maxEvents: 6,
      types: [],
      backgroundColor: '#000000',
      backgroundOpacity: 0.35,
    }),
    goal: () => ({
      ...DEFAULT_TEXT_STYLE,
      fontSize: 26,
      bold: true,
      width: 600,
      height: 110,
      title: 'Subscriber goal',
      goalType: 'subscriber',
      current: 0,
      target: 50,
      barColor: '#31c3a2',
      barBackground: '#1b1f27',
      currency: 'USD',
    }),
    countdown: () => ({
      ...DEFAULT_TEXT_STYLE,
      fontSize: 72,
      bold: true,
      mode: 'countdown',
      durationSec: 300,
      targetTime: '',
      format: 'auto',
      endText: "We're starting!",
      prefix: '',
      clock24h: false,
      backgroundColor: '#000000',
      backgroundOpacity: 0,
    }),
    stream_label: () => ({
      ...DEFAULT_TEXT_STYLE,
      fontSize: 36,
      kind: 'latest_follower',
      template: 'Latest follower: {name}',
      emptyText: 'Latest follower: —',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
    }),
  };
  return map[type]() as SourceSettingsMap[K];
}

export function createSource<K extends SourceType>(type: K, name: string, settings?: Partial<SourceSettingsMap[K]>, base?: { width: number; height: number }): SourceOf<K> {
  const audio = defaultAudioSettings();
  return {
    id: uid('src'),
    name,
    type,
    settings: { ...defaultSourceSettings(type, base), ...(settings ?? {}) },
    filters: [],
    audio,
  } as SourceOf<K>;
}

export function createSceneItem(sourceId: string, transform?: Partial<Transform>): SceneItem {
  return { id: uid('item'), sourceId, visible: true, locked: false, transform: { ...defaultTransform(), ...(transform ?? {}) } };
}

export function createScene(name: string): Scene {
  return { id: uid('scene'), name, items: [] };
}

export function createCollection(name: string, base = { width: 1920, height: 1080 }): SceneCollection {
  const scene = createScene('Scene');
  const desktop = createSource('audio_output', 'Desktop Audio');
  const mic = createSource('audio_input', 'Mic/Aux');
  const sources: Source[] = [desktop, mic];
  void base;
  return {
    id: uid('col'),
    name,
    version: COLLECTION_VERSION,
    scenes: [scene],
    sources,
    activeSceneId: scene.id,
    globalAudioSourceIds: [desktop.id, mic.id],
    transition: defaultTransition(),
    updatedAt: Date.now(),
  };
}

export const SOURCE_TYPE_INFO: Record<SourceType, { label: string; description: string; video: boolean; audio: boolean; group: 'standard' | 'capture' | 'widget' }> = {
  video_capture: { label: 'Video Capture Device', description: 'Webcam, capture card or other camera.', video: true, audio: false, group: 'capture' },
  display_capture: { label: 'Display Capture', description: 'Capture an entire monitor.', video: true, audio: false, group: 'capture' },
  window_capture: { label: 'Window / Game Capture', description: 'Capture a single application window or game.', video: true, audio: false, group: 'capture' },
  audio_input: { label: 'Audio Input Capture', description: 'Microphone, line-in or any input device.', video: false, audio: true, group: 'capture' },
  audio_output: { label: 'Audio Output Capture', description: 'Desktop / system sound.', video: false, audio: true, group: 'capture' },
  image: { label: 'Image', description: 'PNG, JPG, GIF (animated), WebP or SVG.', video: true, audio: false, group: 'standard' },
  slideshow: { label: 'Image Slide Show', description: 'Cycle through a set of images.', video: true, audio: false, group: 'standard' },
  media: { label: 'Media File', description: 'Video or audio file (MP4, WebM, MOV, MP3, WAV...).', video: true, audio: true, group: 'standard' },
  text: { label: 'Text', description: 'Styled text, optionally read from a file.', video: true, audio: false, group: 'standard' },
  color: { label: 'Color Block', description: 'A solid color rectangle.', video: true, audio: false, group: 'standard' },
  browser: { label: 'Browser Source', description: 'Any web page or online overlay / widget URL.', video: true, audio: true, group: 'standard' },
  scene: { label: 'Scene', description: 'Nest another scene inside this one.', video: true, audio: false, group: 'standard' },
  alert_box: { label: 'Alert Box', description: 'Animated alerts for follows, subs, donations, raids, super chats...', video: true, audio: true, group: 'widget' },
  chat_box: { label: 'Chat Box', description: 'Show your live chat on stream.', video: true, audio: false, group: 'widget' },
  event_list: { label: 'Event List', description: 'Recent followers, subscribers, donations...', video: true, audio: false, group: 'widget' },
  goal: { label: 'Goal', description: 'Progress bar for follower, sub or donation goals.', video: true, audio: false, group: 'widget' },
  countdown: { label: 'Timer / Clock', description: 'Countdown, stopwatch, clock or stream uptime.', video: true, audio: false, group: 'widget' },
  stream_label: { label: 'Stream Label', description: 'Text such as "Latest follower" that updates automatically.', video: true, audio: false, group: 'widget' },
};

export const VIDEO_FILTER_INFO: Record<VideoFilterType, { label: string; defaults: VideoFilter['settings'] }> = {
  chroma_key: { label: 'Chroma Key (Green Screen)', defaults: { keyColor: '#00ff00', similarity: 400, smoothness: 80, spill: 100, opacity: 100, contrast: 0, brightness: 0, gamma: 0 } },
  color_key: { label: 'Color Key', defaults: { keyColor: '#00ff00', similarity: 80, smoothness: 50, opacity: 100 } },
  color_correction: { label: 'Color Correction', defaults: { gamma: 0, contrast: 0, brightness: 0, saturation: 0, hue: 0, opacity: 100, colorMultiply: '#ffffff', colorAdd: '#000000' } },
  blur: { label: 'Blur', defaults: { radius: 8 } },
  sharpen: { label: 'Sharpen', defaults: { amount: 0.08 } },
  pixelate: { label: 'Pixelate', defaults: { size: 16 } },
  scroll: { label: 'Scroll', defaults: { speedX: 50, speedY: 0, loop: true } },
  image_mask: { label: 'Image Mask / Blend', defaults: { path: '', mode: 'alpha_mask_alpha', color: '#ffffff', opacity: 100 } },
  lut: { label: 'Apply LUT', defaults: { path: '', amount: 100 } },
};

export const AUDIO_FILTER_INFO: Record<AudioFilterType, { label: string; defaults: AudioFilter['settings'] }> = {
  gain: { label: 'Gain', defaults: { gainDb: 0 } },
  noise_gate: { label: 'Noise Gate', defaults: { openThreshold: -26, closeThreshold: -32, attackMs: 25, holdMs: 200, releaseMs: 150 } },
  compressor: { label: 'Compressor', defaults: { threshold: -18, ratio: 4, attackMs: 6, releaseMs: 60, knee: 6, outputGain: 0 } },
  limiter: { label: 'Limiter', defaults: { threshold: -6, releaseMs: 60 } },
  eq3: { label: '3-Band Equalizer', defaults: { low: 0, mid: 0, high: 0, lowFreq: 250, highFreq: 4000 } },
  highpass: { label: 'High-Pass (Low Cut)', defaults: { frequency: 80 } },
};

export function createVideoFilter(type: VideoFilterType): VideoFilter {
  return { id: uid('vf'), type, name: VIDEO_FILTER_INFO[type].label, enabled: true, settings: { ...VIDEO_FILTER_INFO[type].defaults } };
}

export function createAudioFilter(type: AudioFilterType): AudioFilter {
  return { id: uid('af'), type, name: AUDIO_FILTER_INFO[type].label, enabled: true, settings: { ...AUDIO_FILTER_INFO[type].defaults } };
}

export function sourceHasVideo(type: SourceType): boolean {
  return SOURCE_TYPE_INFO[type].video;
}

export function sourceHasAudio(type: SourceType): boolean {
  return SOURCE_TYPE_INFO[type].audio;
}
