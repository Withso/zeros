export function float32ToPcm16Base64(channels: Float32Array[]): {
  data: string;
  samplesPerChannel: number;
  numChannels: number;
} {
  if (channels.length === 0) {
    return { data: "", samplesPerChannel: 0, numChannels: 0 };
  }
  const samplesPerChannel = Math.min(...channels.map((channel) => channel.length));
  const bytes = new Uint8Array(samplesPerChannel * channels.length * 2);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (let sample = 0; sample < samplesPerChannel; sample += 1) {
    for (const channel of channels) {
      const value = Math.max(-1, Math.min(1, channel[sample] ?? 0));
      view.setInt16(
        offset,
        value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff),
        true,
      );
      offset += 2;
    }
  }
  return {
    data: bytesToBase64(bytes),
    samplesPerChannel,
    numChannels: channels.length,
  };
}

export function pcm16Base64ToChannels(
  data: string,
  numChannels: number,
): Float32Array[] {
  if (!Number.isInteger(numChannels) || numChannels < 1 || numChannels > 8) {
    throw new Error("Realtime audio channel count is invalid.");
  }
  const bytes = base64ToBytes(data);
  if (bytes.byteLength % (numChannels * 2) !== 0) {
    throw new Error("Realtime PCM audio is not frame-aligned.");
  }
  const frames = bytes.byteLength / (numChannels * 2);
  const channels = Array.from(
    { length: numChannels },
    () => new Float32Array(frames),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < numChannels; channel += 1) {
      const value = view.getInt16(offset, true);
      channels[channel]![frame] = value < 0 ? value / 0x8000 : value / 0x7fff;
      offset += 2;
    }
  }
  return channels;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
