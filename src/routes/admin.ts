import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import type { Bindings } from '../lib/types'
import { authRateLimit } from '../lib/rate-limit'

const admin = new Hono<{ Bindings: Bindings }>()

// Brute-force protection: lock out after 5 failed attempts for 15 minutes
admin.use('/admin/*', authRateLimit(5, 15 * 60_000))

// Basic Auth middleware for all admin routes
admin.use('/admin/*', async (c, next) => {
  const user = c.env.ADMIN_USER || 'admin'
  const pass = c.env.ADMIN_PASS
  if (!pass || pass === 'admin') {
    console.warn('⚠️  ADMIN_PASS is not set or uses the default value. Set a strong password in .dev.vars / secrets.')
  }
  const auth = basicAuth({ username: user, password: pass || 'admin' })
  return auth(c, next)
})

// Admin dashboard — redirect to analyses
admin.get('/admin', (c) => c.redirect('/admin/dashboard'))

// Admin login page (handled by basic auth)
admin.get('/admin/login', (c) => c.redirect('/admin/dashboard'))

// Admin dashboard
admin.get('/admin/dashboard', async (c) => {
  const status = c.req.query('status') ?? ''
  const offerType = c.req.query('offerType') ?? ''
  const limit = parseInt(c.req.query('limit') ?? '50')
  const offset = parseInt(c.req.query('offset') ?? '0')

  let query = `
    SELECT a.id, a.offer_type, a.mode, a.status, a.confidence_score, a.created_at,
           u.email, p.amount_cents
    FROM analyses a
    LEFT JOIN users u ON a.user_id = u.id
    LEFT JOIN payments p ON a.id = p.analysis_id
    WHERE 1=1
  `
  const params: unknown[] = []

  if (status) { query += ' AND a.status = ?'; params.push(status) }
  if (offerType) { query += ' AND a.offer_type = ?'; params.push(offerType) }

  query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const analyses = await c.env.DB.prepare(query).bind(...params).all<{
    id: string
    offer_type: string
    mode: string
    status: string
    confidence_score: number
    created_at: number
    email: string | null
    amount_cents: number | null
  }>()

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM analyses`).first<{ cnt: number }>()
  const total = countRow?.cnt ?? 0

  // Revenue stats
  const revenueRow = await c.env.DB.prepare(
    `SELECT SUM(amount_cents) as total FROM payments WHERE status = 'paid'`
  ).first<{ total: number | null }>()

  const completedRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM analyses WHERE status = 'completed'`
  ).first<{ cnt: number }>()

  const revenue = (revenueRow?.total ?? 0) / 100

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Signal Decoder</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">
  <nav class="bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 bg-violet-600 rounded-lg flex items-center justify-center text-sm font-bold">SST</div>
      <span class="font-semibold text-white">Admin Dashboard</span>
    </div>
    <a href="/" class="text-gray-400 hover:text-white text-sm">← Back to site</a>
  </nav>

  <div class="max-w-7xl mx-auto px-6 py-8">
    <!-- Stats -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Total Analyses</div>
        <div class="text-3xl font-bold text-white">${total}</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Completed</div>
        <div class="text-3xl font-bold text-green-400">${completedRow?.cnt ?? 0}</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Revenue</div>
        <div class="text-3xl font-bold text-violet-400">${revenue.toFixed(2)}€</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
        <div class="text-gray-400 text-sm mb-1">Conversion Rate</div>
        <div class="text-3xl font-bold text-blue-400">${total > 0 ? (((completedRow?.cnt ?? 0) / total) * 100).toFixed(1) : 0}%</div>
      </div>
    </div>

    <!-- Filters -->
    <form method="GET" class="flex gap-3 mb-6">
      <select name="status" class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
        <option value="">All statuses</option>
        <option value="pending_payment" ${status === 'pending_payment' ? 'selected' : ''}>pending_payment</option>
        <option value="paid" ${status === 'paid' ? 'selected' : ''}>paid</option>
        <option value="generating" ${status === 'generating' ? 'selected' : ''}>generating</option>
        <option value="completed" ${status === 'completed' ? 'selected' : ''}>completed</option>
        <option value="failed" ${status === 'failed' ? 'selected' : ''}>failed</option>
        <option value="blocked" ${status === 'blocked' ? 'selected' : ''}>blocked</option>
      </select>
      <select name="offerType" class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200">
        <option value="">All offers</option>
        <option value="quick_decode" ${offerType === 'quick_decode' ? 'selected' : ''}>Quick Decode</option>
        <option value="deep_read" ${offerType === 'deep_read' ? 'selected' : ''}>Deep Read</option>
        <option value="pattern_analysis" ${offerType === 'pattern_analysis' ? 'selected' : ''}>Pattern Analysis</option>
      </select>
      <button type="submit" class="bg-violet-600 hover:bg-violet-500 text-white px-4 py-2 rounded-lg text-sm">Filter</button>
    </form>

    <!-- Table -->
    <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
            <th class="px-4 py-3 text-left">ID</th>
            <th class="px-4 py-3 text-left">Email</th>
            <th class="px-4 py-3 text-left">Offer</th>
            <th class="px-4 py-3 text-left">Mode</th>
            <th class="px-4 py-3 text-left">Status</th>
            <th class="px-4 py-3 text-left">Score</th>
            <th class="px-4 py-3 text-left">Amount</th>
            <th class="px-4 py-3 text-left">Date</th>
            <th class="px-4 py-3 text-left">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${analyses.results.map((a) => `
          <tr class="border-b border-gray-800/50 hover:bg-gray-800/30">
            <td class="px-4 py-3 font-mono text-xs text-gray-400">${a.id.substring(0, 12)}...</td>
            <td class="px-4 py-3 text-gray-300">${maskEmail(a.email ?? '')}</td>
            <td class="px-4 py-3"><span class="bg-violet-900/50 text-violet-300 px-2 py-0.5 rounded text-xs">${a.offer_type}</span></td>
            <td class="px-4 py-3 text-gray-400 text-xs">${a.mode}</td>
            <td class="px-4 py-3">${statusBadge(a.status)}</td>
            <td class="px-4 py-3 font-mono text-xs">${a.confidence_score ? (a.confidence_score * 100).toFixed(0) + '%' : '—'}</td>
            <td class="px-4 py-3 text-green-400">${a.amount_cents ? (a.amount_cents / 100).toFixed(2) + '€' : '—'}</td>
            <td class="px-4 py-3 text-gray-400 text-xs">${new Date(a.created_at * 1000).toLocaleDateString('en-US')}</td>
            <td class="px-4 py-3">
              <a href="/admin/analyses/${a.id}" class="text-blue-400 hover:text-blue-300 text-xs">Detail</a>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="flex justify-between items-center mt-4 text-sm text-gray-400">
      <span>${offset + 1}–${Math.min(offset + limit, total)} of ${total}</span>
      <div class="flex gap-2">
        ${offset > 0 ? `<a href="?offset=${offset - limit}&status=${status}&offerType=${offerType}" class="bg-gray-800 px-3 py-1 rounded hover:bg-gray-700">← Prev</a>` : ''}
        ${offset + limit < total ? `<a href="?offset=${offset + limit}&status=${status}&offerType=${offerType}" class="bg-gray-800 px-3 py-1 rounded hover:bg-gray-700">Next →</a>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`

  return c.html(html)
})

// Admin — analyse detail
admin.get('/admin/analyses/:id', async (c) => {
  const id = c.req.param('id')
  const analysis = await c.env.DB.prepare(
    `SELECT a.*, u.email FROM analyses a LEFT JOIN users u ON a.user_id = u.id WHERE a.id = ?`
  ).bind(id).first<Record<string, unknown>>()

  if (!analysis) return c.notFound()

  const resultJson = analysis.ai_result_json
    ? JSON.stringify(JSON.parse(analysis.ai_result_json as string), null, 2)
    : 'No result yet'

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Analysis ${id} — Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen p-8">
  <div class="max-w-4xl mx-auto">
    <a href="/admin/dashboard" class="text-gray-400 hover:text-white text-sm mb-4 inline-block">← Back</a>
    <h1 class="text-2xl font-bold mb-6">Analysis <span class="font-mono text-violet-400">${id}</span></h1>

    <div class="grid grid-cols-2 gap-4 mb-6">
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <div class="text-gray-400 text-xs mb-1">Email</div>
        <div>${analysis.email ?? '—'}</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <div class="text-gray-400 text-xs mb-1">Status</div>
        <div class="font-semibold">${analysis.status}</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <div class="text-gray-400 text-xs mb-1">Offer</div>
        <div>${analysis.offer_type}</div>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <div class="text-gray-400 text-xs mb-1">Mode</div>
        <div>${analysis.mode}</div>
      </div>
    </div>

    <div class="bg-gray-900 rounded-xl p-4 border border-gray-800 mb-4">
      <div class="text-gray-400 text-xs mb-2">Input Text</div>
      <p class="text-gray-200">${escapeHtml(String(analysis.input_text ?? 'Not submitted'))}</p>
    </div>

    <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div class="text-gray-400 text-xs mb-2">AI JSON Result</div>
      <pre class="text-xs text-green-300 overflow-x-auto max-h-96">${escapeHtml(resultJson)}</pre>
    </div>
  </div>
</body>
</html>`

  return c.html(html)
})

// Admin API — list analyses JSON
admin.get('/api/admin/analyses', async (c) => {
  const status = c.req.query('status') ?? ''
  const offerType = c.req.query('offerType') ?? ''
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 100)
  const offset = parseInt(c.req.query('offset') ?? '0')

  let query = `
    SELECT a.id, a.offer_type, a.mode, a.status, a.confidence_score, a.created_at,
           u.email, p.amount_cents
    FROM analyses a
    LEFT JOIN users u ON a.user_id = u.id
    LEFT JOIN payments p ON a.id = p.analysis_id
    WHERE 1=1
  `
  const params: unknown[] = []
  if (status) { query += ' AND a.status = ?'; params.push(status) }
  if (offerType) { query += ' AND a.offer_type = ?'; params.push(offerType) }
  query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const results = await c.env.DB.prepare(query).bind(...params).all()
  const total = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM analyses').first<{ cnt: number }>()

  const analyses = results.results.map((a: Record<string, unknown>) => ({
    ...a,
    email: maskEmail(String(a.email ?? '')),
    amountCents: a.amount_cents,
    confidenceScore: a.confidence_score,
    createdAt: new Date((a.created_at as number) * 1000).toISOString(),
  }))

  return c.json({ total: total?.cnt ?? 0, analyses })
})

function maskEmail(email: string): string {
  if (!email) return '—'
  const [user, domain] = email.split('@')
  if (!domain) return email
  return `${user.substring(0, 2)}***@${domain.split('.')[0].substring(0, 2)}***.${domain.split('.').pop()}`
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    completed: 'bg-green-900/50 text-green-300',
    paid: 'bg-blue-900/50 text-blue-300',
    generating: 'bg-yellow-900/50 text-yellow-300',
    failed: 'bg-red-900/50 text-red-300',
    blocked: 'bg-orange-900/50 text-orange-300',
    pending_payment: 'bg-gray-800 text-gray-400',
    intake_pending: 'bg-purple-900/50 text-purple-300',
  }
  const cls = colors[status] ?? 'bg-gray-800 text-gray-400'
  return `<span class="${cls} px-2 py-0.5 rounded text-xs font-medium">${status}</span>`
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export default admin
