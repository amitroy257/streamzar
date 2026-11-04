import {
  AppWindow,
  Bell,
  Clock,
  Film,
  Globe,
  Image,
  Images,
  Layers,
  List,
  MessageSquare,
  Mic,
  Monitor,
  Palette,
  Tag,
  Target,
  Type,
  Video,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import type { PlatformId, SourceType } from '@shared/types';
import { PLATFORMS } from '@shared/platforms';

export const SOURCE_ICONS: Record<SourceType, LucideIcon> = {
  color: Palette,
  image: Image,
  slideshow: Images,
  media: Film,
  text: Type,
  browser: Globe,
  video_capture: Video,
  display_capture: Monitor,
  window_capture: AppWindow,
  audio_input: Mic,
  audio_output: Volume2,
  scene: Layers,
  alert_box: Bell,
  chat_box: MessageSquare,
  event_list: List,
  goal: Target,
  countdown: Clock,
  stream_label: Tag,
};

export function SourceIcon(props: { type: SourceType; size?: number }) {
  const I = SOURCE_ICONS[props.type] ?? Layers;
  return <I size={props.size ?? 15} style={{ flex: 'none', opacity: 0.85 }} />;
}

const LETTERS: Record<PlatformId, string> = {
  youtube: '▶',
  facebook: 'f',
  twitch: 'T',
  kick: 'K',
  tiktok: '♪',
  x: '𝕏',
  linkedin: 'in',
  trovo: 'Tr',
  instagram: 'IG',
  rumble: 'R',
  custom: '⇪',
};

export function PlatformLogo(props: { platform: PlatformId; size?: number }) {
  const p = PLATFORMS[props.platform];
  const size = props.size ?? 30;
  return (
    <div className="logo" style={{ background: p.color, width: size, height: size, color: props.platform === 'x' || props.platform === 'kick' || props.platform === 'tiktok' ? '#000' : '#fff', fontSize: size * 0.42 }}>
      {LETTERS[props.platform]}
    </div>
  );
}
