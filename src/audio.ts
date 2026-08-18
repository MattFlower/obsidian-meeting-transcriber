export const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".flac",
  ".ogg",
  ".aac",
  ".opus",
] as const;

/**
 * Return true if the given file path ends with a supported audio extension.
 */
export function isAudioFile(path: string): boolean {
  const name = path.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Average N channel buffers of equal length into a single mono buffer.
 * Pure so it can be unit-tested without a Web Audio context.
 */
export function downmixToMono(
  channels: Float32Array[],
  length: number,
): Float32Array {
  const out = new Float32Array(length);
  if (channels.length === 0) return out;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of channels) {
      sum += ch[i] ?? 0;
    }
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Decode an audio file's bytes into an AudioBuffer using the Web Audio API.
 * The context factory is injected so tests can stub it.
 */
export async function decodeAudioData(
  arrayBuffer: ArrayBuffer,
  getAudioContext: () => AudioContext,
): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  return await ctx.decodeAudioData(arrayBuffer);
}

/**
 * Resample an AudioBuffer to a mono Float32Array at `targetRate` (16 kHz by
 * default) using an OfflineAudioContext. The offline-context factory is
 * injected so it can be stubbed in tests.
 */
export async function resampleToMono16k(
  buffer: AudioBuffer,
  getOfflineContext: (length: number, sampleRate: number) => OfflineAudioContext,
  targetRate = 16000,
): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil(buffer.duration * targetRate));
  const offline = getOfflineContext(length, targetRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const channels: Float32Array[] = [];
  for (let i = 0; i < rendered.numberOfChannels; i++) {
    channels.push(rendered.getChannelData(i));
  }
  return downmixToMono(channels, rendered.length);
}

/**
 * Decode raw audio bytes and resample to mono 16 kHz, the format expected by
 * the Parakeet recognizer.
 */
export async function decodeToMono16k(
  arrayBuffer: ArrayBuffer,
  getAudioContext: () => AudioContext,
  getOfflineContext: (length: number, sampleRate: number) => OfflineAudioContext,
  targetRate = 16000,
): Promise<Float32Array> {
  const buffer = await decodeAudioData(arrayBuffer, getAudioContext);
  return await resampleToMono16k(buffer, getOfflineContext, targetRate);
}
