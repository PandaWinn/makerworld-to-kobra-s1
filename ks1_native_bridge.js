// Pure native-bridge protocol helpers (no browser APIs — node-testable).
//
// Shared by background.js (sender) for the one-click "Open in Slicer Next"
// flow. Chunking keeps every native message under browser size limits.

const KS1_BRIDGE_HOST =
  'com.pandawinn.makerworld_kobra_s1';

const KS1_BRIDGE_PROTOCOL =
  1;

const KS1_BRIDGE_CHUNK_SIZE =
  524288; // 512 KiB raw bytes per open-chunk message

function sanitizeKS1BridgeFilename(raw) {
  let name =
    String(raw || '').split(/[\\/]/).pop() || '';

  name =
    name.replace(/[^A-Za-z0-9._\-+() ]/g, '_').trim();

  if (!name || name === '.' || name === '..') {
    name = 'model-KobraS1.3mf';
  }

  if (!/\.3mf$/i.test(name)) {
    name += '.3mf';
  }

  if (name.length > 120) {
    name =
      name.slice(0, 120 - 4) + '.3mf';
  }

  return name;
}

function buildKS1OpenPlan(filename, totalBytes) {
  const safeBytes =
    Math.floor(Number(totalBytes) || 0);

  if (!Number.isSafeInteger(safeBytes) || safeBytes <= 0) {
    throw new TypeError('Invalid totalBytes for bridge open plan.');
  }

  let transferId = '';

  try {
    const randomValues = new Uint32Array(4);
    globalThis.crypto?.getRandomValues?.(randomValues);
    transferId = Array.from(randomValues)
      .map(value => value.toString(16).padStart(8, '0'))
      .join('');
  } catch {
    transferId = '';
  }

  if (!transferId) {
    transferId = `${Date.now().toString(16)}${Math.random()
      .toString(16)
      .slice(2, 18)}`.slice(0, 32);
  }

  return {
    transferId,
    filename: sanitizeKS1BridgeFilename(filename),
    totalBytes: safeBytes,
    totalChunks: Math.ceil(safeBytes / KS1_BRIDGE_CHUNK_SIZE),
  };
}

function encodeKS1Chunk(bytes, index) {
  const input =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);

  const start = index * KS1_BRIDGE_CHUNK_SIZE;
  const slice = input.subarray(start, start + KS1_BRIDGE_CHUNK_SIZE);

  if (slice.byteLength === 0) {
    throw new RangeError('Chunk index out of range.');
  }

  let binary = '';
  const BLOCK = 0x8000;
  for (let i = 0; i < slice.byteLength; i += BLOCK) {
    binary += String.fromCharCode.apply(
      null,
      slice.subarray(i, i + BLOCK)
    );
  }

  return btoa(binary);
}

function decodeKS1ChunkB64(b64) {
  const binary = atob(String(b64 || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
