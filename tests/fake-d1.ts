// D1 en mémoire, juste assez pour le webhook Stripe (tests uniquement).
type Row = Record<string, any>
export function fakeD1(seed: Partial<Record<string, Row[]>> = {}) {
  const t: Record<string, Row[]> = { users: [], analyses: [], payments: [], upsells: [], events_logs: [], ...seed } as any
  const writes: string[] = []
  const prepare = (sql: string) => {
    let args: any[] = []
    const q = sql.replace(/\s+/g, ' ').trim()
    const stmt = {
      bind: (...a: any[]) => { args = a; return stmt },
      first: async <T>() => {
        let m
        if ((m = q.match(/^SELECT .* FROM (\w+) WHERE (.+)$/i))) {
          const table = m[1]; const conds = m[2].split(/ AND /i).map(s => s.trim())
          return (t[table].find(r => conds.every((cnd, i) => {
            const like = cnd.match(/^(\w+) LIKE \?$/i); const eq = cnd.match(/^(\w+) = \?$/)
            const v = args[i]
            if (like) return String(r[like[1]] ?? '').includes(String(v).replace(/%/g, ''))
            if (eq) return r[eq[1]] === v
            throw new Error('cond non gérée: ' + cnd)
          })) ?? null) as T
        }
        throw new Error('SELECT non géré: ' + q)
      },
      run: async () => {
        writes.push(q)
        let m
        if ((m = q.match(/^INSERT INTO (\w+) \(([^)]+)\)/i))) {
          const cols = m[2].split(',').map(s => s.trim()); const row: Row = {}
          const vals = q.slice(q.indexOf('VALUES')).match(/\(([^)]*)\)/)![1].split(',').map(s => s.trim())
          let i = 0; cols.forEach((col, k) => { row[col] = vals[k] === '?' ? args[i++] : vals[k].replace(/'/g, '') })
          t[m[1]].push(row)
        } else if ((m = q.match(/^UPDATE (\w+) SET (.+) WHERE (\w+) = \?$/i))) {
          const sets = m[2].split(',').map(s => s.trim()); const key = m[3]; const target = args[args.length - 1]
          for (const r of t[m[1]].filter(r => r[key] === target)) {
            let i = 0; for (const s of sets) { const [col, val] = s.split('=').map(x => x.trim()); r[col] = val === '?' ? args[i++] : val.replace(/'/g, '') }
          }
        } else throw new Error('écriture non gérée: ' + q)
        return { success: true }
      },
    }
    return stmt
  }
  return { db: { prepare } as unknown as D1Database, tables: t, writes }
}
