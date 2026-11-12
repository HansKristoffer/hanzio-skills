#!/usr/bin/env bun
// A stand-in for `bunx buncargo` in tests. It records each call as a JSON line in FAKE_BUNCARGO_LOG.
// `url` prints two addresses the way buncargo does; FAKE_BUNCARGO_FAIL makes `dev` exit 1 with no URL.
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.FAKE_BUNCARGO_LOG) appendFileSync(process.env.FAKE_BUNCARGO_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`)
const failing = !!process.env.FAKE_BUNCARGO_FAIL
if (args[0] === 'dev' && failing) {
	console.error('api did not come up: port 3000 is held by another checkout')
	process.exit(1)
}
if (args[0] === 'url') {
	if (failing) {
		console.error('Nothing has a URL yet: is `buncargo dev` running?')
		process.exit(1)
	}
	console.log('web            http://localhost:5173')
	console.log('shopify admin  https://admin.example.test/store')
}
