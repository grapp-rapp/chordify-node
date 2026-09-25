/**
 * Minimal iterative radix-2 FFT operating in place on split real/imag arrays.
 * Twiddle tables and bit-reversal permutations are cached per size.
 */

interface FFTTables {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const tableCache = new Map<number, FFTTables>();

function getTables(n: number): FFTTables {
  let t = tableCache.get(n);
  if (t) return t;
  if (n & (n - 1)) throw new Error(`FFT size must be a power of two, got ${n}`);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  tableCache.set(n, t);
  return t;
}

/** In-place forward FFT. Pass inverse=true for the (unscaled) inverse transform. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  const { cos, sin, rev } = getTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Periodic Hann window of the given length (cached). */
const hannCache = new Map<number, Float64Array>();
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
  }
  return w;
}
