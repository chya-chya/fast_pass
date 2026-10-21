export function bitmapIndicesFromBytes(bytes) {
  if (bytes === null || bytes === undefined) return [];
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('Redis bitmap must be a byte array');
  }
  const indices = [];
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
    const byte = bytes[byteIndex];
    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      if ((byte & (1 << (7 - bitIndex))) !== 0) {
        indices.push(byteIndex * 8 + bitIndex);
      }
    }
  }
  return indices;
}
