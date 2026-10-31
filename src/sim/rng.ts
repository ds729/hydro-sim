// シード指定の乱数（mulberry32）。状態は uint32 1個なので SimState にそのまま持てる

export function nextRandom(s: { rng: number }): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 状態を閉じ込めた版（描画の配置など、sim の状態に残さない乱数用） */
export function mulberry32(seed: number): () => number {
  const s = { rng: seed >>> 0 };
  return () => nextRandom(s);
}
