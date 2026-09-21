import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Name the window after the page it is comparing.
 *
 * `document.title` does not reach it: the window's title is the *native*
 * window's, which the config named once and which nothing in the document can
 * change. That was invisible while there was one window — nobody reads the
 * title bar of the only window an app has — and stops being invisible the
 * moment there are tabs, because a tab is a title and nothing else. Three tabs
 * reading "DevKit" are three tabs you have to click to tell apart.
 *
 * The page's own title where it has one, the host where it does not. A URL
 * makes a poor tab: the part that distinguishes two pages of the same site is
 * usually the end of the path, which is the part a narrow tab drops.
 */
export function nameWindow(title: string, url: string): void {
  void getCurrentWindow()
    .setTitle(title || hostOf(url) || 'DevKit')
    .catch(() => {
      // A window that is going away is not worth a report; its title will
      // never be seen either way.
    });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
