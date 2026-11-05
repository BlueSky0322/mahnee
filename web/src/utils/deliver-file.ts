// Handing a file the app made to the person: a download on computers, and on phones and
// tablets the share sheet where the device has one for files (an installed app on an
// iPhone can't download, but Save to Files is in its share sheet), else a download.

/** Saves `blob` to the device as `name`, through a link that lasts long enough to start */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** What became of a file: shared, saved, or the share sheet closed without sharing */
export type Delivery = 'shared' | 'saved' | 'cancelled';

/**
 * Opens the share sheet with the file where the device can share files, or saves it
 * where it can't. Closing the share sheet does nothing more; if sharing fails any other
 * way (the browser decided the tap was too long ago, say), the file is saved instead.
 * Computers always save it: their share sheets (Windows, macOS) only offer to send it on.
 */
export async function deliverFile(
  blob: Blob,
  name: string,
  { title, share }: { title: string; share: boolean },
): Promise<Delivery> {
  if (share && typeof navigator.canShare === 'function') {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return 'shared';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      }
    }
  }
  saveBlob(blob, name);
  return 'saved';
}
