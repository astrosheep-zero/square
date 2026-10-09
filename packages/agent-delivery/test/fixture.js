import './sandbox-env.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sandbox } from './sandbox-env.js'

export const sessionId = 'ses_fixture'
export const secret = 'private-fixture-password'
export const authorization = `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`

export function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export async function fixture(t, handler) {
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = raw ? JSON.parse(raw) : undefined
      const record = { method: request.method, path: request.url, auth: request.headers.authorization, body }
      requests.push(record)
      if (request.headers.authorization !== authorization) {
        return json(response, 401, { _tag: 'Unauthorized', message: `${secret} ${raw}` })
      }
      if (handler && await handler(record, response) === true) return
      if (record.path === '/api/info') return json(response, 200, {
        version: '2.0.20', pid: process.pid, urls: [endpoint.url], paths: { tmp: sandbox },
      })
      if (record.path === `/api/session/${sessionId}` && record.method === 'GET') {
        return json(response, 200, { data: { id: sessionId, projectID: 'prj_fixture',
          time: { created: 1, updated: 1 }, cost: 0, tokens: {},
          location: { type: 'local', directory: sandbox } } })
      }
      if (record.path === `/api/session/${sessionId}/prompt` && record.method === 'POST') {
        return json(response, 200, { data: { id: body.id, sessionID: sessionId,
          type: 'user', payload: { text: body.text }, delivery: body.delivery, time: { created: 1 } } })
      }
      json(response, 404, { _tag: 'NotFound', message: secret })
    } catch (error) {
      response.destroy(error)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = { url: `http://127.0.0.1:${server.address().port}`,
    auth: { type: 'basic', username: 'opencode', password: secret } }
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { endpoint, requests, server, async register(file = join(sandbox, `registration-${server.address().port}.json`), overrides = {}) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ id: 'fixture-instance', url: endpoint.url,
      pid: process.pid, version: '2.0.20', password: secret, ...overrides }))
    return file
  } }
}
