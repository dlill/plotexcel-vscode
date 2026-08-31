import { countPdfPagesInText, type PageCount } from '../../core/src/documents/pdfPages.ts';
import { plotExtensionOf } from '../../core/src/spec/classify.ts';

/**
 * Reading a folder the person dropped onto the page.
 *
 * The File System Access API gives a real handle to a real directory, with
 * permission to read it and — once granted — to write back into it. That is
 * the whole reason this can be a page rather than an upload form: the workbook
 * lands next to the plots, where the person expected it, rather than in
 * Downloads.
 *
 * It works from a `file://` page, so the delivery is one HTML file to
 * double-click. Chrome and Edge have it; Firefox and Safari do not.
 */

export interface FolderFile {
  /** Path relative to the dropped folder, with forward slashes. */
  readonly path: string;
  readonly handle: FileSystemFileHandle;
  readonly extension: string;
  readonly size: number;
  readonly pages: PageCount;
}

export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** The folder chooser. Needs a click behind it — browsers insist. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    // Cancelling the dialog is not an error worth reporting.
    return undefined;
  }
}

/** The folder from a drop, when the browser hands over a handle. */
export async function folderFromDrop(items: DataTransferItemList): Promise<FileSystemDirectoryHandle | undefined> {
  for (const item of items) {
    if (item.kind !== 'file') continue;

    const handle = await item.getAsFileSystemHandle?.();
    if (handle?.kind === 'directory') return handle as FileSystemDirectoryHandle;
  }

  return undefined;
}

export interface ScanOptions {
  readonly maxDepth?: number;
  readonly onProgress?: (found: number, name: string) => void;
}

/**
 * Walk the folder and describe every plot in it.
 *
 * Page counts come from the file's own structure, the same way the extension
 * does it — no rendering, because rendering forty PDFs to find out how long
 * they are is how a folder scan becomes a coffee break.
 */
export async function scanFolder(
  directory: FileSystemDirectoryHandle,
  options: ScanOptions = {},
): Promise<FolderFile[]> {
  const maxDepth = options.maxDepth ?? 6;
  const found: FolderFile[] = [];

  async function walk(handle: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    for await (const [name, child] of handle.entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue;

      const path = prefix === '' ? name : `${prefix}/${name}`;

      if (child.kind === 'directory') {
        await walk(child as FileSystemDirectoryHandle, path, depth + 1);
        continue;
      }

      const extension = plotExtensionOf(name);
      if (extension === undefined) continue;

      const fileHandle = child as FileSystemFileHandle;
      const file = await fileHandle.getFile();

      found.push({
        path,
        handle: fileHandle,
        extension,
        size: file.size,
        pages: await countPages(file, extension),
      });

      options.onProgress?.(found.length, path);
    }
  }

  await walk(directory, '', 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function countPages(file: File, extension: string): Promise<PageCount> {
  if (extension === 'png') return { pages: 1, confidence: 'exact' };

  if (extension === 'pdf') {
    // latin1 keeps every byte a character, which is what the scan expects.
    const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
    return countPdfPagesInText(text);
  }

  return {
    pages: 1,
    confidence: 'estimated',
    reason: `A browser cannot open .${extension} files without a converter.`,
  };
}

/** Write a file into the folder that was dropped. */
export async function writeInto(
  directory: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();

  await writable.write(bytes as unknown as BufferSource);
  await writable.close();
}

/** Ask for write permission, which a dropped folder does not carry by default. */
export async function ensureWritable(directory: FileSystemDirectoryHandle): Promise<boolean> {
  const options = { mode: 'readwrite' } as const;

  if ((await directory.queryPermission?.(options)) === 'granted') return true;
  return (await directory.requestPermission?.(options)) === 'granted';
}
