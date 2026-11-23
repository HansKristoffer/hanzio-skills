// Lists the tests that a PR removes: one "<path>\t<line at the merge base>\t<test name>" line for each.
// Usage: node removed-tests.mjs <full.diff>
// The diff is enough. A removed test has its name on a removed line and on no added line of a test file. A test that
// only moves, also to another file, has its name on both, and a test that the PR does not touch is on neither.
import { readFileSync } from "node:fs"

const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$|_test\.py$/
const TEST_NAMES = [
	// Jest, Vitest and Mocha: it("…"), test.only('…'). The name of it.each(…)("…") is not on the it line, so it is left out.
	/(?:^|[^\w.])(?:it|test)(?:\.\w+)*\(\s*(["'`])(?<name>.*?)\1/,
	/^func (?<name>Test\w*)\(/,
	/^\s*(?:async\s+)?def (?<name>test_\w*)\(/,
]

const diffPath = process.argv[2]
if (!diffPath) {
	console.error("Usage: node removed-tests.mjs <full.diff>")
	process.exit(2)
}

const testName = line => TEST_NAMES.map(pattern => line.match(pattern)?.groups.name).find(Boolean)

const removed = []
const added = new Set()
let path
let isInHunk = false
let oldLine = 0

for (const line of readFileSync(diffPath, "utf8").split("\n")) {
	if (line.startsWith("diff --git ")) {
		path = undefined
		isInHunk = false
		continue
	}
	const hunk = line.match(/^@@ -(\d+)/)
	if (hunk) {
		isInHunk = true
		oldLine = Number(hunk[1])
		continue
	}
	if (!isInHunk) {
		// "--- a/<path>" names the file at the merge base. "+++ b/<path>" names it at the head, and a deleted file has
		// "+++ /dev/null". Both count, so that a test file that moves keeps its path for the added names.
		const filePath = line.match(/^(?:---|\+\+\+) [ab]\/(.*)/)?.[1]
		if (filePath && TEST_FILE.test(filePath)) path ??= filePath
		continue
	}
	const name = path && testName(line.slice(1))
	if (line.startsWith("-")) {
		if (name) removed.push({ path, line: oldLine, name })
		oldLine++
	}
	if (line.startsWith("+") && name) added.add(name)
	if (line.startsWith(" ")) oldLine++
}

const printed = new Set()
for (const test of removed) {
	const key = `${test.path}\t${test.name}`
	if (added.has(test.name) || printed.has(key)) continue
	printed.add(key)
	console.log(`${test.path}\t${test.line}\t${test.name}`)
}
