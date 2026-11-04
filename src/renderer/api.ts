import type { StreamzarApi } from '@shared/ipc';

declare global {
  interface Window {
    streamzar: StreamzarApi;
  }
}

export const api: StreamzarApi = window.streamzar;
