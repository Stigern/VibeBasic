// 1 pixel = 15 twips everywhere. The model stores twips; rendering divides by 15.

export function twipsToPx(t: number): number { return Math.round(t / 15); }
export function pxToTwips(px: number): number { return px * 15; }
