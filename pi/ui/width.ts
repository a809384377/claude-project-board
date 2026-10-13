/** Terminal columns of one code point: 0 for marks and joiners, 2 for East Asian wide and emoji, else 1. */
export function cpWidth(c: number): number {
  if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f)) return 0
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
    return 2
  return 1
}

/** Columns of a string. */
export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += cpWidth(ch.codePointAt(0) as number)
  return n
}
