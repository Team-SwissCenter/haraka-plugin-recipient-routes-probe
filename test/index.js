const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { describe, it, beforeEach } = require('node:test')

// npm modules
const { makeConnection, makePlugin } = require('haraka-test-fixtures')
const OldAddress = require('address-rfc2821').Address // Haraka < 3.2
const NewAddress = require('@haraka/email-address').Address // Haraka >= 3.2

let plugin

beforeEach(() => {
    plugin = makePlugin('recipient-routes-probe', { register: false })
    plugin.inherits('haraka-plugin-redis')
})

// A stand-in for core's smtp_client: records commands and lets a test
// drive the server side through `script(client, command)`.
function fakeSmtpClientModule(script) {
    const mod = { clients: [] }
    mod.get_client_plugin = (plg, conn, cfg, cb) => {
        const client = new EventEmitter()
        client.cfg = cfg
        client.sent = []
        client.released = false
        client.socket = new EventEmitter()
        client.release = () => {
            client.released = true
        }
        client.send_command = (cmd, data) => {
            client.sent.push(`${cmd} ${data}`)
            client.command = cmd.toLowerCase()
            setImmediate(() => script(client, client.command))
        }
        mod.clients.push(client)
        cb(null, client)
        // core sends EHLO + MAIL FROM, then emits 'mail' on 250
        client.command = 'mail'
        setImmediate(() => script(client, 'mail'))
    }
    return mod
}

const answer = (codes) => (client, command) => {
    const reply = codes[command]
    if (reply === undefined) return // stay silent
    if (reply === 'socket-error') return client.socket.emit('error', new Error('connect ECONNREFUSED'))
    if (/^[45]/.test(reply)) return client.emit('bad_code', reply.slice(0, 3), reply.slice(4))
    client.emit(command)
}

describe('recipient-routes-probe', () => {
    it('loads', () => {
        assert.ok(plugin)
    })
})

describe('load_config', () => {
    it('loads recipient-routes-probe.ini from config/recipient-routes-probe.ini', () => {
        plugin.load_config()
        assert.ok(plugin.cfg)
    })

    it('initializes enabled boolean', () => {
        plugin.load_config()
        assert.equal(plugin.cfg.cache.enabled, true, plugin.cfg)
    })

    it('honors [probe] timeout', () => {
        const get = plugin.config.get.bind(plugin.config)
        plugin.config.get = (name, ...rest) => {
            if (name !== 'recipient-routes-probe.ini') return get(name, ...rest)
            return { main: {}, probe: { timeout: '3' }, cache: { enabled: true } }
        }
        plugin.load_config()
        assert.equal(plugin.cfg.probe.timeout, 3)
    })

    it('defaults [probe] timeout to 5', () => {
        plugin.load_config()
        assert.equal(plugin.cfg.probe.timeout, 5)
    })
})

describe('load_domains', () => {
    beforeEach(() => {
        plugin.load_config()
        plugin.load_domains()
    })

    it('loads the routes, keyed by lower-case domain', () => {
        assert.equal(plugin.domains_list.get('cooldomain.com'), 'smtp://somemx.example.com:25')
    })

    it('does not resolve Object.prototype names as domains', () => {
        for (const d of ['constructor', '__proto__', 'tostring', 'hasownproperty']) {
            assert.equal(plugin.domains_list.has(d), false, d)
        }
    })

    it('stores IDN keys as A-labels', () => {
        const get = plugin.config.get.bind(plugin.config)
        plugin.config.get = (name, ...rest) => {
            if (name !== 'recipient-routes-probe-domains.ini') return get(name, ...rest)
            return { main: { 'BÜCHER.ch': 'smtp://mx.example.com:25' } }
        }
        plugin.load_domains()
        assert.equal(plugin.domains_list.get('xn--bcher-kva.ch'), 'smtp://mx.example.com:25')
    })
})

describe('get_rcpt_address', () => {
    for (const [label, Address] of [
        ['address-rfc2821 (Haraka < 3.2)', OldAddress],
        ['@haraka/email-address (Haraka >= 3.2)', NewAddress],
    ]) {
        it(`returns lower-case address and domain with ${label}`, () => {
            const rcpt = new Address('<John.Doe@Example.COM>')
            assert.deepEqual(plugin.get_rcpt_address(rcpt), ['john.doe@example.com', 'example.com'])
        })

        it(`returns only the address when there is no domain with ${label}`, () => {
            assert.deepEqual(plugin.get_rcpt_address(new Address('<postmaster>')), ['postmaster'])
        })
    }
})

describe('parse_mx', () => {
    const cases = {
        'smtp://mx.example.com:2525': { exchange: 'mx.example.com', port: 2525 },
        'smtp://mx.example.com': { exchange: 'mx.example.com', port: 25 },
        'mx.example.com:26': { exchange: 'mx.example.com', port: 26 },
        'SMTP://MX.example.com:25': { exchange: 'mx.example.com', port: 25 },
        'smtp://[2001:db8::1]:25': { exchange: '2001:db8::1', port: 25 },
        ' smtp://mx.example.com:25 ': { exchange: 'mx.example.com', port: 25 },
        'lmtp://192.0.2.10': { exchange: '192.0.2.10', port: 24, using_lmtp: true },
    }
    for (const [entry, expected] of Object.entries(cases)) {
        it(`parses ${JSON.stringify(entry)}`, () => {
            assert.deepEqual(plugin.parse_mx(entry), expected)
        })
    }

    for (const bad of [undefined, null, '', 'http://mx.example.com', 'smtp://', 42, Object]) {
        it(`rejects ${typeof bad === 'function' ? 'a function' : JSON.stringify(bad)}`, () => {
            assert.equal(plugin.parse_mx(bad), false)
        })
    }
})

describe('probe_mx_for_recipient', () => {
    const cfg = { host: '192.0.2.1', port: 25, timeout: 1 }
    let connection

    beforeEach(() => {
        connection = makeConnection({ withTxn: true })
    })

    it('accepts when the backend accepts RCPT', async () => {
        plugin.smtp_client_module = fakeSmtpClientModule(answer({ mail: '250', rcpt: '250' }))
        const r = await plugin.probe_mx_for_recipient(connection, cfg, 'a@example.com')
        assert.deepEqual(r, { code: OK, msg: 'Recipient accepted', cacheable: true })
        assert.deepEqual(plugin.smtp_client_module.clients[0].sent, ['RCPT TO:<a@example.com>'])
        assert.ok(plugin.smtp_client_module.clients[0].released)
    })

    it('denies (cacheable) on a 5xx to RCPT', async () => {
        plugin.smtp_client_module = fakeSmtpClientModule(answer({ mail: '250', rcpt: '550 No such user here' }))
        const r = await plugin.probe_mx_for_recipient(connection, cfg, 'a@example.com')
        assert.deepEqual(r, { code: DENY, msg: 'No such user here', cacheable: true })
    })

    it('defers (cacheable) on a 4xx to RCPT', async () => {
        plugin.smtp_client_module = fakeSmtpClientModule(answer({ mail: '250', rcpt: '452 Mailbox full' }))
        const r = await plugin.probe_mx_for_recipient(connection, cfg, 'a@example.com')
        assert.deepEqual(r, { code: DENYSOFT, msg: 'Mailbox full', cacheable: true })
    })

    it('does not cache a verdict on the sender (MAIL FROM rejected)', async () => {
        plugin.smtp_client_module = fakeSmtpClientModule(answer({ mail: '550 Sender rejected' }))
        const r = await plugin.probe_mx_for_recipient(connection, cfg, 'a@example.com')
        assert.equal(r.code, DENY)
        assert.equal(r.cacheable, false)
    })

    it('defers quickly when the backend refuses the connection', async () => {
        plugin.smtp_client_module = fakeSmtpClientModule(answer({ mail: 'socket-error' }))
        const t = Date.now()
        const r = await plugin.probe_mx_for_recipient(connection, cfg, 'a@example.com')
        assert.equal(r.code, DENYSOFT)
        assert.equal(r.cacheable, false)
        assert.ok(Date.now() - t < 500)
    })

    it('defers after [probe] timeout when the backend stays silent', async () => {
        plugin.smtp_client_module = fakeSmtpClientModule(answer({}))
        const t = Date.now()
        const r = await plugin.probe_mx_for_recipient(connection, cfg, 'a@example.com')
        assert.deepEqual(r, { code: DENYSOFT, msg: 'Backend timeout', cacheable: false })
        assert.ok(Date.now() - t >= 900)
        assert.ok(plugin.smtp_client_module.clients[0].released)
    })

    it('settles once even if the backend answers after the timeout', async () => {
        let late
        plugin.smtp_client_module = fakeSmtpClientModule((client, command) => {
            if (command === 'mail') late = () => client.emit('mail')
        })
        const r = await plugin.probe_mx_for_recipient(connection, { ...cfg, timeout: 0.1 }, 'a@example.com')
        assert.equal(r.msg, 'Backend timeout')
        late() // must not throw nor re-resolve
    })
})

describe('rcpt', () => {
    let connection

    beforeEach(() => {
        plugin.load_config()
        plugin.load_domains()
        plugin.cfg.cache.enabled = false
        connection = makeConnection({ withTxn: true })
    })

    const rcpt = (address) =>
        new Promise((resolve) => {
            plugin.rcpt((code, msg) => resolve({ code, msg }), connection, [new NewAddress(address)])
        })

    it('denies domains that are not routed', async () => {
        assert.deepEqual(await rcpt('<a@unknown.example>'), { code: DENY, msg: 'Sorry, this domain not in my routes' })
    })

    it('denies Object.prototype names instead of throwing', async () => {
        assert.equal((await rcpt('<a@constructor>')).code, DENY)
    })

    it('accepts and routes via outbound when the backend accepts', async () => {
        plugin.smtp_client_module = fakeSmtpClientModule(answer({ mail: '250', rcpt: '250' }))
        assert.equal((await rcpt('<a@cooldomain.com>')).code, OK)
        assert.equal(connection.relaying, true)
        assert.equal(connection.transaction.notes.get('queue.wants'), 'outbound')
    })

    it('defers instead of crashing when something throws', async () => {
        plugin.smtp_client_module = {
            get_client_plugin: () => {
                throw new Error('boom')
            },
        }
        assert.equal((await rcpt('<a@cooldomain.com>')).code, DENYSOFT)
    })
})

describe('get_mx', () => {
    beforeEach(() => {
        plugin.load_config()
        plugin.load_domains()
    })

    const get_mx = (domain) =>
        new Promise((resolve) => {
            plugin.get_mx((code, mx) => resolve({ code, mx }), { todo: { uuid: 'test' } }, domain)
        })

    it('returns the route of a known domain', async () => {
        assert.deepEqual(await get_mx('CoolDomain.com'), {
            code: OK,
            mx: { exchange: 'somemx.example.com', port: 25, priority: 0 },
        })
    })

    it('falls through to DNS for other domains, without logging an error', async () => {
        let errors = 0
        plugin.logerror = () => errors++
        assert.deepEqual(await get_mx('example.net'), { code: undefined, mx: undefined })
        assert.equal(errors, 0)
    })
})
