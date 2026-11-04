// Framing used on the local TCP link that carries raw program output from the renderer to the
// main-process MediaHub. After a single handshake line ("<token>\n") the stream is a sequence of:
//
//   magic   u32 LE  'SZRW'
//   type    u8      1 = video (I420 frame), 2 = audio (f32le interleaved stereo)
//   pad     u8[3]
//   length  u32 LE  payload bytes
//   tsUs    f64 LE  presentation timestamp in microseconds (shared audio clock)
//   pad     u8[4]
//   payload

export const RAW_MAGIC = 0x5752_5a53; // 'SZRW' little endian
export const RAW_HEADER_SIZE = 24;
export const RAW_TYPE_VIDEO = 1;
export const RAW_TYPE_AUDIO = 2;
export const RAW_MAX_PAYLOAD = 3840 * 2160 * 2; // generous upper bound (4K I420 is 1.5 bytes/px)

export function writeRawHeader(view: DataView, type: number, length: number, tsUs: number): void {
  view.setUint32(0, RAW_MAGIC, true);
  view.setUint8(4, type);
  view.setUint8(5, 0);
  view.setUint8(6, 0);
  view.setUint8(7, 0);
  view.setUint32(8, length, true);
  view.setFloat64(12, tsUs, true);
  view.setUint32(20, 0, true);
}
