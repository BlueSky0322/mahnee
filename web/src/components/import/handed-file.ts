import { onCacheCleared } from '../../offline/cache';

// A file chosen or dropped on Settings › Import and export, handed to the Import page it
// opens. Taken once: the page going back to it later starts with no file. One handed over
// and never taken goes on signing out, so it can't open for the next person here.

let handed: File | null = null;

export function handFile(file: File) {
  handed = file;
}

export function takeHandedFile(): File | null {
  const file = handed;
  handed = null;
  return file;
}

// Signing out, or someone else signing in: the file goes with the rest
onCacheCleared(() => {
  handed = null;
});
