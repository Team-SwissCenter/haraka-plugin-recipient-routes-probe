const assert = require('node:assert')
const { describe, it, beforeEach } = require('node:test')

// npm modules
const { makeConnection, makePlugin } = require('haraka-test-fixtures')

// start of tests
//    assert: https://nodejs.org/api/assert.html
//    mocha: http://mochajs.org

let plugin

beforeEach(() => {
    plugin = makePlugin('recipient-routes-probe', { register: false })
    plugin.inherits('haraka-plugin-redis')
})

describe('recipient-routes-probe', () => {
    it('loads', () => {
        assert.ok(plugin)
    })
})

describe('load-recipient-routes-probe.ini', () => {
    it('loads recipient-routes-probe.ini from config/recipient-routes-probe.ini', () => {
        plugin.load_config()
        assert.ok(plugin.cfg)
    })

    it('initializes enabled boolean', () => {
        plugin.load_config()
        assert.equal(plugin.cfg.cache.enabled, true, plugin.cfg)
    })
})

describe('uses text fixtures', () => {
    it('sets up a connection', () => {
        const connection = makeConnection()
        assert.ok(connection.server)
    })

    it('sets up a transaction', () => {
        const connection = makeConnection({ withTxn: true })
        assert.ok(connection.transaction.header)
    })
})
