import { describe, expect, it } from 'vitest'
import { isLocalHost } from '../server/net.mjs'

describe('the network proxy leaves local addresses alone', () => {
  it('knows this computer and the local network', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.20', '169.254.3.4', 'stash.local', 'fd12:3456::1', 'fe80::1'])
      expect(isLocalHost(h), h).toBe(true)
  })
  it('sends everything else through the proxy', () => {
    for (const h of ['discuss.eroscripts.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', '11.0.0.1', '', 'localhost.example.com', '2001:db8::1'])
      expect(isLocalHost(h), h).toBe(false)
  })
})
