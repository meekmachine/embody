/** Own the caller's storage before asynchronous file processing begins. */
export function readGlbSource(source, label = 'Actor Model') {
  if (!(source instanceof Uint8Array)) throw new TypeError(`${label} source must be a Uint8Array.`);
  const bytes = new Uint8Array(source);
  if (bytes.byteLength < 20) throw new Error(`${label} must be a glTF 2.0 binary (.glb).`);
  const view = new DataView(bytes.buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error(`${label} has an invalid GLB header or length.`);
  }
  let json;
  let binary = new Uint8Array();
  let chunkCount = 0;
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error(`${label} has an incomplete GLB chunk.`);
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.byteLength) throw new Error(`${label} has an invalid GLB chunk length.`);
    if (chunkCount === 0 && type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length)));
    } else if (chunkCount !== 1 || type !== 0x004e4942) {
      throw new Error(`${label} must contain only the GLB JSON and optional binary chunks.`);
    } else {
      binary = bytes.subarray(offset + 8, offset + 8 + length);
    }
    offset += 8 + length;
    chunkCount++;
  }
  if (!json || json.asset?.version !== '2.0') throw new Error(`${label} must declare glTF version 2.0.`);
  return { bytes, json, binary };
}
