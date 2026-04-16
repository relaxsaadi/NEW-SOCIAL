import type { Context, Next } from 'hono'
import type { Bindings } from './types'

interface RateLimitEntry {
  count: number
  resetAt: number
}

// In-memory store (per Worker isolate).
const store = new Map<string, RateLimitEntry>()
let lastCleanup = 0

// Lazy cleanup: runs during request handling, not via setInterval
function cleanup() {
  const now = Date.now()
  if (now - lastCleanup < 60_000) return
  lastCleanup = now
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key)
  }
}

/**
 * Rate limiting middleware for Cloudflare Workers.
 * @param maxRequests  Max requests allowed in the window
 * @param windowMs     Window duration in milliseconds
 * @param keyPrefix    Prefix for the rate limit key (to separate endpoints)
 */
export function rateLimit(maxRequests: number, windowMs: number, keyPrefix = 'global') {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    cleanup()

    const ip = c.req.header('cf-connecting-ip')
      || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || 'unknown'

    const key = `${keyPrefix}:${ip}`
    const now = Date.now()
    const entry = store.get(key)

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs })
      c.header('X-RateLimit-Limit', String(maxRequests))
      c.header('X-RateLimit-Remaining', String(maxRequests - 1))
      await next()
      return
    }

    entry.count++

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      c.header('Retry-After', String(retryAfter))
      c.header('X-RateLimit-Limit', String(maxRequests))
      c.header('X-RateLimit-Remaining', '0')
      return c.json(
        { error: 'RATE_LIMITED', message: `Trop de requêtes. Réessayez dans ${retryAfter}s.` },
        429
      )
    }

    c.header('X-RateLimit-Limit', String(maxRequests))
    c.header('X-RateLimit-Remaining', String(maxRequests - entry.count))
    await next()
  }
}

/**
 * Stricter rate limiter for auth endpoints.
 * Tracks failed attempts and locks out after too many failures.
 */
const authFailures = new Map<string, { count: number; lockedUntil: number }>()

export function authRateLimit(maxAttempts: number, lockoutMs: number) {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const ip = c.req.header('cf-connecting-ip')
      || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      || 'unknown'

    const now = Date.now()
    const entry = authFailures.get(ip)

    // Check if IP is locked out
    if (entry && entry.lockedUntil > now) {
      const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000)
      return c.json(
        { error: 'LOCKED_OUT', message: `Compte temporairement verrouillé. Réessayez dans ${retryAfter}s.` },
        429
      )
    }

    await next()

    // Track failed auth (401 response = failed attempt)
    if (c.res.status === 401) {
      const current = authFailures.get(ip) || { count: 0, lockedUntil: 0 }
      current.count++
      if (current.count >= maxAttempts) {
        current.lockedUntil = now + lockoutMs
        current.count = 0
      }
      authFailures.set(ip, current)
    } else {
      // Successful auth — reset counter
      authFailures.delete(ip)
    }
  }
}
