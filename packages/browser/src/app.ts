import { buildFromFolder, type BuildResult } from './build.ts';
import { chooseFolder, ensureWritable, folderFromDrop, isSupported, scanFolder, writeInto, type FolderFile } from './folder.ts';

/**
 * The page.
 *
 * Deliberately one screen with one path through it: drop a folder, look at
 * what was found, press the button. Everything else — resolution, pages per
 * file — has a default that is right often enough that nobody has to touch it.
 */

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dropZone = element('drop');
const status = element('status');
let directory: FileSystemDirectoryHandle | undefined;
let files: FolderFile[] = [];

if (!isSupported()) {
  element('unsupported').classList.remove('hidden');
  dropZone.classList.add('hidden');
}

element<HTMLButtonElement>('choose').addEventListener('click', async () => {
  const picked = await chooseFolder();
  if (picked !== undefined) await use(picked);
});

for (const event of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(event, (dragEvent) => {
    dragEvent.preventDefault();
    dropZone.classList.add('hot');
  });
}

for (const event of ['dragleave', 'drop'] as const) {
  dropZone.addEventListener(event, () => dropZone.classList.remove('hot'));
}

dropZone.addEventListener('drop', async (dragEvent) => {
  dragEvent.preventDefault();

  const items = (dragEvent as DragEvent).dataTransfer?.items;
  if (items === undefined) return;

  const dropped = await folderFromDrop(items);
  if (dropped === undefined) {
    say('That was not a folder. Drop the folder itself, not the files inside it.');
    return;
  }

  await use(dropped);
});

async function use(handle: FileSystemDirectoryHandle): Promise<void> {
  directory = handle;

  const dropped = element('dropped');
  dropped.classList.remove('hidden');
  dropped.textContent = `Reading ${handle.name}…`;

  files = await scanFolder(handle, {
    onProgress: (found, name) => {
      dropped.textContent = `${handle.name} — ${found} plot${found === 1 ? '' : 's'}, reading ${name}`;
    },
  });

  dropped.textContent =
    files.length === 0
      ? `${handle.name} — no plots found. plotExcel reads PDF and PNG here.`
      : `${handle.name} — ${files.length} plot${files.length === 1 ? '' : 's'}`;

  showFiles();
}

function showFiles(): void {
  const rows = element('fileRows');
  rows.textContent = '';

  for (const file of files) {
    const row = document.createElement('tr');

    const path = document.createElement('td');
    path.className = 'path';
    path.textContent = file.path;

    const kind = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${file.extension === 'png' || file.extension === 'pdf' ? 'ok' : 'warn'}`;
    pill.textContent = file.extension;
    kind.append(pill);

    const pages = document.createElement('td');
    pages.className = 'num';
    pages.textContent = file.pages.confidence === 'exact' ? String(file.pages.pages) : `~${file.pages.pages}`;
    if (file.pages.reason !== undefined) pages.title = file.pages.reason;

    const size = document.createElement('td');
    size.className = 'num';
    size.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB`;

    row.append(path, kind, pages, size);
    rows.append(row);
  }

  const found = files.length > 0;
  element('files').classList.toggle('hidden', !found);
  element('options').classList.toggle('hidden', !found);
  element('actions').classList.toggle('hidden', !found);
  element('result').classList.add('hidden');
}

element<HTMLButtonElement>('build').addEventListener('click', async () => {
  if (directory === undefined || files.length === 0) return;

  const button = element<HTMLButtonElement>('build');
  button.disabled = true;

  try {
    const result = await buildFromFolder(
      files,
      {
        resolution: Number(element<HTMLSelectElement>('resolution').value),
        nPagesMax: Number(element<HTMLInputElement>('maxPages').value),
        addBorders: element<HTMLInputElement>('borders').checked,
        textColumnWidthCm: Number(element<HTMLInputElement>('textWidth').value),
        sheetName: directory.name || 'Plots',
      },
      (done, total, label) => say(`${done}/${total} — ${label}`),
    );

    say('');
    await offer(result);
  } catch (error) {
    say(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    button.disabled = false;
  }
});

async function offer(result: BuildResult): Promise<void> {
  const panel = element('result');
  panel.classList.remove('hidden');

  const total = result.images + result.placeholders;

  element('summary').textContent =
    `${total} cell${total === 1 ? '' : 's'}: ${result.images} plot${result.images === 1 ? '' : 's'}` +
    `${result.placeholders > 0 ? `, ${result.placeholders} placeholder${result.placeholders === 1 ? '' : 's'}` : ''}. ` +
    `${Math.round(result.workbook.length / 1024)} KB.`;

  const notes = element('notes');
  notes.textContent = '';
  for (const note of result.notes) {
    const line = document.createElement('p');
    line.className = 'note';
    line.textContent = note;
    notes.append(line);
  }

  const buttons = element('downloads');
  buttons.textContent = '';

  const name = (directory?.name ?? 'plots').replace(/[^A-Za-z0-9._-]+/g, '-');
  const layout = new TextEncoder().encode(result.layoutText);

  buttons.append(
    action('Save into the folder', async () => {
      if (directory === undefined) return;
      if (!(await ensureWritable(directory))) {
        say('The browser did not grant permission to write into that folder.');
        return;
      }

      await writeInto(directory, `${name}.xlsx`, result.workbook);
      await writeInto(directory, `${name}.plotexcel.tsv`, layout);
      say(`Written into ${directory.name}: ${name}.xlsx and ${name}.plotexcel.tsv`);
    }),
    action('Download the workbook', () => download(`${name}.xlsx`, result.workbook), true),
    action('Download the layout', () => download(`${name}.plotexcel.tsv`, layout), true),
  );
}

function action(label: string, run: () => void | Promise<void>, secondary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = label;
  if (secondary) button.className = 'secondary';
  button.addEventListener('click', () => void run());
  return button;
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  const link = document.createElement('a');

  link.href = url;
  link.download = name;
  link.click();

  // Revoked on the next tick, so the click has already taken the data.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function say(message: string): void {
  status.textContent = message;
}

/**
 * A way in for the test harness.
 *
 * Opening a folder needs a real click on a real dialog, which no automated
 * browser can produce, so without this there is no way to exercise the page
 * end to end. Behind a URL flag, and doing nothing a drop would not also do.
 */
if (location.search.includes('harness')) {
  (window as unknown as Record<string, unknown>).plotExcelHarness = {
    show: async (handle: FileSystemDirectoryHandle, given: FolderFile[]) => {
      directory = handle;
      files = given;
      element('dropped').classList.remove('hidden');
      element('dropped').textContent = `${handle.name} — ${given.length} plots`;
      showFiles();
    },
    build: async () => element<HTMLButtonElement>('build').click(),
  };
}
