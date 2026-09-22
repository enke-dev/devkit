import { invoke } from '@tauri-apps/api/core';

/**
 * Where this comparison is, so quitting and relaunching brings it back.
 *
 * Kept by the backend rather than here, because restoring needs two things
 * known at once and this side only knows one of them: the page. Whether a
 * window went away because somebody closed it — stay closed — or because the
 * app was quitting — come back — is the backend's to tell apart, and it is the
 * difference between restoring a workspace and reopening tabs somebody threw
 * away.
 *
 * Said on every navigation rather than asked for on the way out: a window being
 * torn down cannot answer a question, and this costs a message nobody waits on.
 */
export function rememberUrl(url: string): void {
  void invoke('remember_url', { url }).catch(() => {
    // Losing one of these costs a restored page, not a navigation.
  });
}

/**
 * The page this window was showing before, if it was showing one.
 *
 * Two cases, answered the same way: a comparison reopened on relaunch, and one
 * whose webview reloaded while its panes carried on behind it. Nothing means a
 * new comparison, which opens on no page at all.
 */
export function restoredUrl(): Promise<string | null> {
  return invoke<string | null>('restored_url').catch(() => null);
}
