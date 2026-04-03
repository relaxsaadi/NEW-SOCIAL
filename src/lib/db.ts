import { ulid } from 'ulid'

export { ulid }

export function now(): number {
  return Math.floor(Date.now() / 1000)
}

export async function logEvent(
  db: D1Database,
  event_name: string,
  opts: { user_id?: string; analysis_id?: string; payload?: unknown } = {}
) {
  const id = ulid()
  await db
    .prepare(
      `INSERT INTO events_logs (id, user_id, analysis_id, event_name, event_payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.user_id ?? null,
      opts.analysis_id ?? null,
      event_name,
      opts.payload ? JSON.stringify(opts.payload) : null,
      now()
    )
    .run()
}

export async function getOrCreateUser(
  db: D1Database,
  email: string,
  opts: { locale?: string; source?: string } = {}
) {
  const existing = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>()

  if (existing) return existing.id

  const id = ulid()
  await db
    .prepare(
      `INSERT INTO users (id, email, created_at, locale, source) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, email, now(), opts.locale ?? 'fr', opts.source ?? null)
    .run()

  return id
}
