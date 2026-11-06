/**
 * Reads a plugin's `.zip` (P10-T03, ADR-72 item 8) with the browser's own `DecompressionStream`,
 * so no library is downloaded for it. Only what plugins need: entries stored (method 0) or
 * deflated (method 8), from the central directory; no encryption, no ZIP64, no spanning.
 *
 * A zip is something a person was sent, so it is read defensively: a cap on entries and on the
 * bytes they expand to (a zip bomb ends in a sentence, not a hung tab), and every name kept as
 * written. Nothing is ever written to disk from a name: the plugin's files are read by the exact
 * paths its manifest names, which the schema already holds inside the folder.
 */

export const ZIP_LIMITS = { entries: 2_000, bytes: 100_000_000 } as const;

export class ZipProblem extends Error {}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;

/** The files in a zip, by name (folders left out). */
export async function readZip(bytes: Uint8Array, limits: { readonly entries: number; readonly bytes: number } = ZIP_LIMITS): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count > limits.entries) throw new ZipProblem(`The zip holds ${count} entries; a plugin may have ${limits.entries}.`);

  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_ENTRY) throw new ZipProblem('The zip is damaged: its list of files does not read.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if ((flags & 1) !== 0) throw new ZipProblem(`"${name}" in the zip is encrypted.`);
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ZipProblem('The zip is a ZIP64 archive, which plugins do not use.');
    total += size;
    if (total > limits.bytes) throw new ZipProblem(`The zip expands to more than ${Math.round(limits.bytes / 1_000_000)} MB.`);

    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_ENTRY) throw new ZipProblem(`The zip is damaged at "${name}".`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (data.length !== compressed) throw new ZipProblem(`The zip is cut short at "${name}".`);

    let content: Uint8Array;
    if (method === 0) content = data.slice();
    else if (method === 8) content = await inflate(data, size, name);
    else throw new ZipProblem(`"${name}" in the zip is compressed in a way this app does not read (method ${method}).`);
    if (content.length !== size) throw new ZipProblem(`"${name}" in the zip did not expand to the size the zip says.`);
    files.set(name, content);
  }
  return files;
}

function findEnd(view: DataView): number {
  // The record is 22 bytes plus a comment of up to 65,535.
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 65_535); at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new ZipProblem('This is not a zip file.');
}

async function inflate(data: Uint8Array, size: number, name: string): Promise<Uint8Array> {
  try {
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(data as Uint8Array<ArrayBuffer>);
        controller.close();
      },
    });
    const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const out = new Uint8Array(size);
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > size) {
        await reader.cancel();
        throw new ZipProblem(`"${name}" in the zip expands past the size the zip says.`);
      }
      out.set(value, length);
      length += value.length;
    }
    return out.subarray(0, length);
  } catch (error) {
    if (error instanceof ZipProblem) throw error;
    throw new ZipProblem(`"${name}" in the zip is damaged.`);
  }
}
