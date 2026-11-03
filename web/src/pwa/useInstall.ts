import { useSyncExternalStore } from 'react';
import { installState, promptInstall, subscribeInstall } from './install';

/** Whether and how this browser can install the app (see install.ts) */
export function useInstall() {
  const state = useSyncExternalStore(subscribeInstall, installState);
  return {
    ...state,
    /** Something to offer: the browser's prompt, or the steps on iOS and Android */
    available: !state.installed && (state.canPrompt || state.ios || state.android),
    prompt: promptInstall,
  };
}
