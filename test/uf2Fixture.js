// A minimal RP2040 flash UF2 image; no hardware access.
export const RP2040_INFO = 'UF2 Bootloader v3.0\nModel: Raspberry Pi RP2\nBoard-ID: RPI-RP2\n';
export function makeUf2(count = 2) {
  const image = Buffer.alloc(count * 512);
  for (let i = 0; i < count; i++) {
    const start = i * 512;
    const words = [0x0a324655, 0x9e5d5157, 0x2000, 0x10000000 + i * 256, 256, i, count, 0xe48bff56];
    words.forEach((value, j) => image.writeUInt32LE(value, start + j * 4));
    image.fill(i + 1, start + 32, start + 288);
    image.writeUInt32LE(0x0ab16f30, start + 508);
  }
  return image;
}
