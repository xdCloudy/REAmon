import http from 'node:http'

const upstream = process.env.AGENT_UPSTREAM_URL || 'http://go-agent:8080'
const internalKey = process.env.INTERNAL_API_KEY || ''
if (!internalKey) throw new Error('INTERNAL_API_KEY is required')

const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const url = new URL(request.url || '/', 'http://localhost')
  if (request.headers['x-internal-key'] !== internalKey) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ detail: 'Invalid internal API key' }))
    return
  }

  if (url.pathname === '/reamon/code/suggest-renames' && request.method === 'POST') {
    let payload
    try { payload = JSON.parse(body.toString('utf8')) } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }
    const candidates = Array.isArray(payload.bindings) ? payload.bindings : []
    const candidate = candidates.find((item) => item?.name === 'Do') || candidates.find((item) => item?.name === 'fn') || candidates[0]
    console.log(`deterministic rename candidates: ${JSON.stringify(candidates)}`)
    console.log(`deterministic rename selected: ${JSON.stringify(candidate)}`)
    const renames = candidate ? [{ bindingId: candidate.id, oldName: candidate.name, newName: candidate.name === 'Do' ? 'Serve' : 'calculate', rationale: 'The source and verified call sites identify the operation.' }] : []
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ renames, model_used: payload.model }))
    return
  }

  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === 'host' || value === undefined) continue
      headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const result = await fetch(new URL(url.pathname + url.search, upstream), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method || 'GET') ? undefined : body,
      signal: AbortSignal.timeout(120_000),
    })
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Agent upstream failed' }))
  }
})

server.listen(8080, '0.0.0.0')
