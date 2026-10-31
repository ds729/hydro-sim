// 適合度（0〜1）と律速因子。作物のほか、v2 の魚・硝化菌にも同じ形で使う

/** 台形の帯 [下限, 適正下限, 適正上限, 上限]。下限以下・上限以上で 0、適正帯で 1、その間は直線 */
export type Band = readonly [number, number, number, number];

export function trapezoid(x: number, [a, b, c, d]: Band): number {
  return x <= a || x >= d ? 0 : x < b ? (x - a) / (b - a) : x <= c ? 1 : (d - x) / (d - c);
}

/** 適正帯の中央より低いか高いか（症状と対処の向きを決める） */
export function side(x: number, band: Band): 'low' | 'high' {
  return x < (band[1] + band[2]) / 2 ? 'low' : 'high';
}

/** 律速因子：適合度が最も低い要因。同点なら先に並んだ要因 */
export function limiting<K extends string>(keys: readonly K[], f: Record<K, number>): { key: K; value: number } {
  let key = keys[0], value = f[key];
  for (const k of keys) if (f[k] < value) { key = k; value = f[k]; }
  return { key, value };
}
