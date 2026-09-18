import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';

/**
 * Whether a newer DevKit has been published, and installing it.
 *
 * The check is signed: the manifest and every artifact carry a signature made
 * with the release key, and the updater refuses anything it cannot verify. So
 * the endpoint being a plain public URL costs nothing — a tampered manifest is
 * rejected rather than installed.
 *
 * Nothing here runs in development: there is no bundle to replace, and asking
 * anyway would report a failure on every launch.
 */

export interface AvailableUpdate {
  version: string;
  install: () => Promise<void>;
}

export async function availableUpdate(): Promise<AvailableUpdate | null> {
  if (import.meta.env.DEV) {
    return null;
  }

  try {
    const update = await check();
    if (!update) {
      return null;
    }
    return {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall();
        // The binary on disk is the new one now; the running process is not.
        await relaunch();
      },
    };
  } catch {
    // Being offline, or a release that has not published its manifest yet, is
    // not worth telling anyone about: the app works either way.
    return null;
  }
}
