// このブラウザへの保存（localStorage）。使えない環境（プライベートモード・Node のテスト）では何もしない

const ls = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
};

export function readStore(key: string): string | null {
  try { return ls()?.getItem(key) ?? null; } catch { return null; }
}

export function writeStore(key: string, value: string): void {
  try { ls()?.setItem(key, value); } catch { /* 保存できなくても今回は効く */ }
}
