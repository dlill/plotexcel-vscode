import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createZip, listZip, readZipEntries, readZipEntry, ZipError } from '../src/zip/zip.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const docx = readFileSync(path.join(here, 'fixtures', 'docs', '21-Word.docx'));

describe('createZip', () => {
  const archive = createZip([
    { name: 'hello.txt', data: Buffer.from('hello world hello world hello world') },
    { name: 'raw.bin', data: Buffer.from([1, 2, 3, 4]), store: true },
    { name: 'nested/path/файл.txt', data: Buffer.from('unicode name', 'utf8') },
  ]);

  it('round-trips through its own reader', () => {
    assert.equal(readZipEntry(archive, 'hello.txt')?.toString(), 'hello world hello world hello world');
    assert.deepEqual([...readZipEntry(archive, 'raw.bin')!], [1, 2, 3, 4]);
    assert.equal(readZipEntry(archive, 'nested/path/файл.txt')?.toString(), 'unicode name');
  });

  it('compresses by default and stores when asked', () => {
    const entries = listZip(archive);
    assert.equal(entries.find((entry) => entry.name === 'hello.txt')?.method, 8);
    assert.equal(entries.find((entry) => entry.name === 'raw.bin')?.method, 0);
  });

  it('actually makes repetitive data smaller', () => {
    const repetitive = Buffer.from('x'.repeat(5000));
    const compressed = createZip([{ name: 'a', data: repetitive }]);
    const stored = createZip([{ name: 'a', data: repetitive, store: true }]);
    assert.ok(compressed.length < stored.length / 10);
  });

  it('is deterministic, so building twice gives the same bytes', () => {
    const first = createZip([{ name: 'a.txt', data: Buffer.from('same') }]);
    const second = createZip([{ name: 'a.txt', data: Buffer.from('same') }]);
    assert.deepEqual(first, second);
  });

  it('returns undefined for a file that is not there', () => {
    assert.equal(readZipEntry(archive, 'nope.txt'), undefined);
  });
});

describe('reading archives written elsewhere', () => {
  it('lists the parts of a real Word document', () => {
    const names = listZip(docx).map((entry) => entry.name);
    assert.ok(names.includes('[Content_Types].xml'));
    assert.ok(names.includes('word/document.xml'));
  });

  it('inflates a part written by Word', () => {
    const document = readZipEntry(docx, 'word/document.xml')!.toString('utf8');
    assert.match(document, /<w:document/);
    assert.ok(document.length > 1000);
  });

  it('finds parts by pattern', () => {
    const found = readZipEntries(docx, /^docProps\//);
    assert.ok(found.length >= 1);
    assert.ok(found.every((entry) => entry.data.length > 0));
  });

  it('refuses a file that is not an archive', () => {
    assert.throws(() => listZip(Buffer.from('definitely not a zip')), ZipError);
  });

  /**
   * An `.xlsx`, a `.docx` and a `.pptx` are all ZIPs, and the pipeline opens
   * whatever the layout points at. An entry that claims to be small and then
   * inflates without end would take the extension host down with it.
   */
  it('stops an entry that inflates past the size the archive declares', () => {
    const archive = createZip([{ name: 'big.xml', data: Buffer.alloc(4 * 1024 * 1024, 0x61) }]);

    // Rewrite the uncompressed size in the central directory, which is where
    // the reader takes the entry's size from, so the entry now lies about it.
    const centralHeader = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(centralHeader > 0, 'the archive should have a central directory');
    archive.writeUInt32LE(64, centralHeader + 24);

    assert.throws(() => readZipEntry(archive, 'big.xml'), (error: Error) => {
      assert.ok(error instanceof ZipError);
      assert.match(error.message, /expands to more data than the archive declares/);
      return true;
    });
  });

  it('still reads an entry whose declared size is the truth', () => {
    const archive = createZip([{ name: 'honest.xml', data: Buffer.alloc(4 * 1024 * 1024, 0x61) }]);
    assert.equal(readZipEntry(archive, 'honest.xml')?.length, 4 * 1024 * 1024);
  });
});
