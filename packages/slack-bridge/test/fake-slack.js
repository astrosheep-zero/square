/** A fake Slack transport: no network, no credentials, fully inspectable. */
export class FakeSlack {
  posts = []
  failures = []
  auth = new Map()
  users = new Map()
  connection = undefined
  closed = false
  counter = 0

  addBot(token, userId, botId) {
    this.auth.set(token, { userId, ...(botId === undefined ? {} : { botId }) })
    return this
  }

  addUser(userId, names = {}) {
    this.users.set(userId, names)
    return this
  }

  failWhen(predicate, error = 'ratelimited') {
    this.failures.push({ predicate, error })
    return this
  }

  async authTest(token) {
    const identity = this.auth.get(token)
    if (identity === undefined) throw new Error('invalid_auth')
    return identity
  }

  async userInfo(token, userId) {
    if (!this.auth.has(token)) throw new Error('invalid_auth')
    const user = this.users.get(userId)
    if (user === undefined) throw new Error('users_not_found')
    return { userId, ...user }
  }

  async postMessage(request) {
    const failure = this.failures.find((entry) => entry.predicate(request))
    if (failure !== undefined) throw new Error(failure.error)
    this.counter += 1
    const ts = `1700000100.${String(this.counter).padStart(6, '0')}`
    this.posts.push({ ...request, ts })
    return { ts }
  }

  async connect(connection) {
    this.connection = connection
    this.closed = false
  }

  async close() {
    this.closed = true
    this.connection = undefined
  }

  deliver(message) {
    if (this.connection === undefined) throw new Error('not connected')
    this.connection.onMessage(message)
  }
}
