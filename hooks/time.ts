/** Local time as ISO 8601 with the UTC offset, e.g. 2026-10-11T09:00:00+08:00. */
export function isoLocal(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.trunc(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  )
}
