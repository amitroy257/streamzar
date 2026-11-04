import type { Source, SourceOf } from '@shared/types';
import type { EngineServices, SourceRuntime } from './base';
import { ColorRuntime, ImageRuntime, MediaRuntime, SceneRuntime, SlideshowRuntime } from './basic';
import { AudioInputRuntime, AudioOutputRuntime, DisplayCaptureRuntime, VideoCaptureRuntime, WindowCaptureRuntime } from './capture';
import { BrowserRuntime, TextRuntime } from './textBrowser';
import { AlertBoxRuntime, ChatBoxRuntime, CountdownRuntime, EventListRuntime, GoalRuntime, StreamLabelRuntime } from '../widgets/widgets';

export function createRuntime(source: Source, svc: EngineServices): SourceRuntime {
  const id = source.id;
  switch (source.type) {
    case 'color':
      return new ColorRuntime(id, svc, source as SourceOf<'color'>);
    case 'image':
      return new ImageRuntime(id, svc, source as SourceOf<'image'>);
    case 'slideshow':
      return new SlideshowRuntime(id, svc, source as SourceOf<'slideshow'>);
    case 'media':
      return new MediaRuntime(id, svc, source as SourceOf<'media'>);
    case 'text':
      return new TextRuntime(id, svc, source as SourceOf<'text'>);
    case 'browser':
      return new BrowserRuntime(id, svc, source as SourceOf<'browser'>);
    case 'video_capture':
      return new VideoCaptureRuntime(id, svc, source as SourceOf<'video_capture'>);
    case 'display_capture':
      return new DisplayCaptureRuntime(id, svc, source as SourceOf<'display_capture'>);
    case 'window_capture':
      return new WindowCaptureRuntime(id, svc, source as SourceOf<'window_capture'>);
    case 'audio_input':
      return new AudioInputRuntime(id, svc, source as SourceOf<'audio_input'>);
    case 'audio_output':
      return new AudioOutputRuntime(id, svc, source as SourceOf<'audio_output'>);
    case 'scene':
      return new SceneRuntime(id, svc, source as SourceOf<'scene'>);
    case 'alert_box':
      return new AlertBoxRuntime(id, svc, source as SourceOf<'alert_box'>);
    case 'chat_box':
      return new ChatBoxRuntime(id, svc, source as SourceOf<'chat_box'>);
    case 'event_list':
      return new EventListRuntime(id, svc, source as SourceOf<'event_list'>);
    case 'goal':
      return new GoalRuntime(id, svc, source as SourceOf<'goal'>);
    case 'countdown':
      return new CountdownRuntime(id, svc, source as SourceOf<'countdown'>);
    case 'stream_label':
      return new StreamLabelRuntime(id, svc, source as SourceOf<'stream_label'>);
  }
}
