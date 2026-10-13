/**
 * The lottery module's PRNG — the exact port of `Aegis\MathUtils::seededRandom`.
 *
 * A xorshift32 generator over an unsigned 32-bit state, returning `state / 2^32`.
 * It is ported bit-for-bit, with PHP's `& 0xFFFFFFFF` masks mapped onto
 * `Math.imul` and `>>> 0` (JavaScript's bitwise ops are *signed* 32-bit, so every
 * step is normalized back to unsigned before it is used), because the sandbox
 * provider's deterministic draws are the subject of the PHP differential harness:
 * a one-bit difference anywhere in this function produces a different but equally
 * plausible draw universe — the same failure mode finding F-34 (CRC-32 vs
 * `hash('crc32')`) was. Seed 0 becomes 1, as in PHP, so a zero seed cannot
 * collapse the sequence.
 *
 * @param {number} seed
 * @returns {() => number} each call returns a float in [0, 1)
 */
export function seededRandom(seed) {
  let s = seed !== 0 ? (seed & 0xFFFFFFFF) >>> 0 : 1;
  return function next() {
    // PHP: $s ^= ($s << 13) & 0xFFFFFFFF; $s &= 0xFFFFFFFF;
    s = ((s ^ Math.imul(s, 8192)) >>> 0);
    // PHP: $s ^= $s >> 17; — $s is a positive masked value, so >> is logical here.
    s = ((s ^ (s >>> 17)) >>> 0);
    // PHP: $s ^= ($s << 5) & 0xFFFFFFFF; $s &= 0xFFFFFFFF;
    s = ((s ^ Math.imul(s, 32)) >>> 0);
    return s / 4294967296.0;
  };
}
