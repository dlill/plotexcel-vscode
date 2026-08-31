/**
 * CRC-32, the checksum both PNG chunks and ZIP entries need.
 *
 * Its own module because it is the one piece of those two formats that has no
 * dependency at all — which means the ZIP writer a browser needs can use it
 * without dragging in the PNG codec, and the PNG codec without the ZIP writer.
 */

const TABLE = (() => {
  const table = new Int32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }

  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
