// Checks a summarize-pr page against the Form rules that a script can check.
// Usage: node check.mjs <page.html>
// Prints the shown-line budget and every rule the page breaks. Exits with 1 if it breaks any.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BUDGET_RATIO = 0.2
// Wider lines wrap in the split diff view at common window widths.
const MAX_COLUMNS = 100
const TAB_WIDTH = 2

const pagePath = process.argv[2]
if (!pagePath) {
	console.error("Usage: node check.mjs <page.html>")
	process.exit(2)
}

const html = readFileSync(pagePath, "utf8")
const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "template.html"), "utf8")
const errors = []
const warnings = []

const STYLE = /<style>([\s\S]*?)<\/style>/
const MODULE_SCRIPT = /<script type="module">([\s\S]*?)<\/script>/
if (html.match(STYLE)?.[1] !== template.match(STYLE)?.[1]) {
	errors.push("The <style> block is not the same as in template.html. Do not change the form.")
}
const moduleScript = html.match(MODULE_SCRIPT)?.[1]
if (moduleScript !== template.match(MODULE_SCRIPT)?.[1]) {
	errors.push(
		"The module script is not the same as in template.html. Do not change the form. If the template is newer than the page, copy its module script into the page.",
	)
}

const DIFF_SCRIPT = /<script type="text\/plain" class="(old|new)">([\s\S]*?)<\/script>/g
const withoutCode = html.replace(DIFF_SCRIPT, "").replace(MODULE_SCRIPT, "").replace(STYLE, "")

for (const placeholder of new Set(withoutCode.match(/\{\{[^}]*\}\}/g) ?? [])) {
	errors.push(`Placeholder left in the page: ${placeholder}`)
}
if (/class="eyebrow"/.test(html)) errors.push("The page has an eyebrow. Do not use eyebrows.")

const main = html.match(/<main([^>]*)>/)?.[1] ?? ""
const attribute = (attributes, name) => attributes.match(new RegExp(`${name}="([^"]*)"`))?.[1]
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(attribute(main, "data-repo-url") ?? "")) {
	errors.push('<main data-repo-url> must be "https://github.com/<owner>/<repo>".')
}
if (!/^\d+$/.test(attribute(main, "data-pr") ?? "")) errors.push("<main data-pr> must be the PR number.")
if (!/^[0-9a-f]{40}$/.test(attribute(main, "data-head-sha") ?? "")) {
	errors.push("<main data-head-sha> must be the full SHA of the PR head commit.")
}

// GitHub link texts leave out the owner of the PR's repo: "api#123", not "acme/api#123".
const owner = attribute(main, "data-repo-url")?.split("/")[3]
for (const [, text] of withoutCode.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)) {
	if (owner && text.startsWith(`${owner}/`)) {
		errors.push(`The link text "${text}" names the owner of the PR's repo. Write "${text.slice(owner.length + 1)}".`)
	}
}

// A term is explained one time, at its first use, in the tooltip of <dfn class="term" data-tip="…">.
const explainedTerms = new Set()
for (const [, attributes, text] of withoutCode.matchAll(/<dfn\b([^>]*)>([\s\S]*?)<\/dfn>/g)) {
	const term = text.replace(/<[^>]*>/g, "").trim()
	if (attribute(attributes, "class") !== "term") errors.push(`The term "${term}" needs class="term".`)
	const tip = attribute(attributes, "data-tip") ?? ""
	if (!tip.trim()) errors.push(`The term "${term}" needs its explanation in data-tip.`)
	// The template shows text between backticks as inline code. It reads all other text as plain text.
	if ((tip.match(/`/g) ?? []).length % 2 !== 0) {
		errors.push(`The data-tip of the term "${term}" has a backtick without its pair.`)
	}
	if (/<[a-z/]/i.test(tip)) {
		errors.push(`The data-tip of the term "${term}" has HTML. Write inline code between backticks.`)
	}
	if (explainedTerms.has(term.toLowerCase())) {
		errors.push(`The term "${term}" is explained more than one time. Keep only the <dfn> at its first use.`)
	}
	explainedTerms.add(term.toLowerCase())
}

// A decision keeps the form of the "Decisions" collapsibles of the PR template: closed, the choice in the summary, and the
// reason before what merging accepts.
for (const [, attributes, body] of withoutCode.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)) {
	if (attribute(attributes, "class") !== "decision") continue
	const title = body.match(/<span class="decision-title">([\s\S]*?)<\/span>/)?.[1]?.replace(/<[^>]*>/g, "").trim()
	const name = title ? `The decision "${title}"` : "A decision"
	if (/(^|\s)open(\s|=|$)/.test(attributes)) errors.push(`${name} is open. A decision is closed by default.`)
	if (!/^\s*<summary>\s*<span class="decision-label">Decision<\/span>/.test(body)) {
		errors.push(`${name} needs <span class="decision-label">Decision</span> first in its summary.`)
	}
	if (!title) errors.push(`${name} needs its choice in <span class="decision-title">.`)
	for (const [, label] of body.matchAll(/<span class="decision-origin"[^>]*>([^<]*)<\/span>/g)) {
		if (label.trim() !== "Implicit") {
			errors.push(`${name} has the label "${label.trim()}". Only an implicit decision has a label, "Implicit".`)
		}
	}
	// The Slack discussion of a decision is only the Slack icon, last in the title row.
	const head = body.match(/<span class="decision-head">([\s\S]*?)<\/summary>/)?.[1] ?? ""
	const links = [...body.matchAll(/<a\b([^>]*)>/g)].map(([, link]) => link)
	const icons = links.filter(link => attribute(link, "class") === "decision-slack")
	if (icons.length > 1) errors.push(`${name} has ${icons.length} Slack icons. Link only the message where the discussion starts.`)
	for (const link of icons) {
		if (!/^https:\/\/[\w-]+\.slack\.com\/archives\/\w+\/p\d+/.test(attribute(link, "href") ?? "")) {
			errors.push(`${name} has a Slack icon with href="${attribute(link, "href")}", not the URL of a Slack message.`)
		}
	}
	if (icons.length > 0 && !/<a class="decision-slack"[\s\S]*<\/a>\s*<\/span>\s*$/.test(head)) {
		errors.push(`${name} needs its Slack icon last in <span class="decision-head">.`)
	}
	if (links.some(link => /slack\.com\//.test(attribute(link, "href") ?? "") && attribute(link, "class") !== "decision-slack")) {
		errors.push(`${name} links Slack in its text. Link Slack only with the Slack icon (<a class="decision-slack">).`)
	}
	const reason = body.indexOf('<p class="decision-why">')
	const tradeOff = body.indexOf('<p class="decision-cost"><span class="decision-label">Trade-off</span>')
	if (reason === -1) errors.push(`${name} needs its reason in <p class="decision-why">.`)
	if (tradeOff === -1) {
		errors.push(`${name} needs <p class="decision-cost"><span class="decision-label">Trade-off</span><span>…</span></p>.`)
	}
	if (reason !== -1 && tradeOff !== -1 && tradeOff < reason) {
		errors.push(`${name} shows the trade-off before the reason. Show the reason first.`)
	}
}

const stats = html.match(/<div class="stats"([^>]*)>/)?.[1] ?? ""
const prAdditions = Number(attribute(stats, "data-pr-additions"))
const prDeletions = Number(attribute(stats, "data-pr-deletions"))
if (!Number.isInteger(prAdditions) || !Number.isInteger(prDeletions)) {
	errors.push("<div class=stats> needs data-pr-additions and data-pr-deletions from GitHub.")
}

// Run the same diff as the page, so the budget matches the counts in the page header.
const diffLinesSource = moduleScript?.match(/\/\/ diff-lines:start[^\n]*\n([\s\S]*?)\/\/ diff-lines:end/)?.[1]
const diffLines = diffLinesSource ? new Function(`${diffLinesSource}\nreturn diffLines`)() : undefined
// The page shows each hidden block (between `//{` and `//}`) as one row first, so the counts use that row.
const hiddenBlocksSource = moduleScript?.match(/\/\/ hidden-blocks:start[^\n]*\n([\s\S]*?)\/\/ hidden-blocks:end/)?.[1]
const { splitHiddenBlocks, EXPANDER } = hiddenBlocksSource
	? new Function(`${hiddenBlocksSource}\nreturn { splitHiddenBlocks, EXPANDER }`)()
	: { splitHiddenBlocks: lines => ({ collapsed: lines, expanded: lines }), EXPANDER: /^$/ }
const toLines = text => {
	const trimmed = text.replace(/^\n/, "").replace(/\s+$/, "")
	return trimmed === "" ? [] : trimmed.split("\n")
}

let shownAdditions = 0
let shownDeletions = 0
let shownContext = 0
let hiddenContext = 0

// Code at the base: the lines that the PR removes, and the figure's file at the merge base. When 3 added lines in a
// row are also 3 lines in a row at the base, that code moved or was extracted. full.diff alone is not enough: git
// shows most of an extract within one file as unchanged lines, which the diff leaves out.
const MOVED_RUN = 3
const isMeaningful = line => line.length >= 8 && /[A-Za-z0-9]/.test(line) && !line.startsWith("//")
const addRuns = (keys, lines) => {
	const meaningful = lines.map(line => line.trim()).filter(isMeaningful)
	for (let index = 0; index + MOVED_RUN <= meaningful.length; index++) {
		keys.add(meaningful.slice(index, index + MOVED_RUN).join("\n"))
	}
	return keys
}
const removedRuns = new Set()
const fullDiffPath = join(dirname(pagePath), "full.diff")
if (existsSync(fullDiffPath)) {
	for (const file of readFileSync(fullDiffPath, "utf8").split(/^diff --git /m)) {
		const removed = file.split("\n").filter(line => line.startsWith("-") && !line.startsWith("---"))
		addRuns(removedRuns, removed.map(line => line.slice(1)))
	}
}
const prJsonPath = join(dirname(pagePath), "pr.json")
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
let mergeBase
if (existsSync(prJsonPath)) {
	const { baseRefName, headRefOid } = JSON.parse(readFileSync(prJsonPath, "utf8"))
	try {
		mergeBase = git("merge-base", `origin/${baseRefName}`, headRefOid).trim()
	} catch {
		warnings.push("Cannot find the merge base, so moved or extracted code is not checked. Run the check from the repo of the PR.")
	}
}
const baseRunsByPath = new Map()
const baseRunsOf = path => {
	if (!baseRunsByPath.has(path)) {
		let lines = []
		try {
			if (mergeBase) lines = git("show", `${mergeBase}:${path}`).split("\n")
		} catch {
			// The file is new in the PR.
		}
		baseRunsByPath.set(path, addRuns(new Set(), lines))
	}
	return baseRunsByPath.get(path)
}

// A code example is not in the PR, so it has no path or line, and it does not count toward the budget.
for (const [, attributes, body] of html.matchAll(/<figure class="example"([^>]*)>([\s\S]*?)<\/figure>/g)) {
	if (!attribute(attributes, "data-lang")) errors.push("A code example has no data-lang.")
	const code = body.match(/<script type="text\/plain">([\s\S]*?)<\/script>/)?.[1] ?? ""
	if (!code.trim()) errors.push('A code example has no code in a <script type="text/plain">.')

	for (const line of toLines(code)) {
		const columns = line.replaceAll("\t", " ".repeat(TAB_WIDTH)).length
		if (columns > MAX_COLUMNS) {
			errors.push(`Code example: line has ${columns} columns, limit ${MAX_COLUMNS}: ${line.trim().slice(0, 60)}`)
		}
	}
}

if (/<pre[^>]*>\s*<code/.test(html)) {
	errors.push('A code block is a <pre><code>. Write it as <figure class="example">, so that the page highlights it.')
}

for (const [, attributes, body] of html.matchAll(/<figure class="diff"([^>]*)>([\s\S]*?)<\/figure>/g)) {
	const path = attribute(attributes, "data-path")
	const name = path ?? "(figure without data-path)"
	if (!path) errors.push("A diff figure has no data-path.")
	if (!attribute(attributes, "data-lang")) errors.push(`${name}: no data-lang.`)

	const sides = { old: "", new: "" }
	for (const [, side, code] of body.matchAll(DIFF_SCRIPT)) sides[side] = code
	if (!sides.old.trim() && !sides.new.trim()) errors.push(`${name}: no old or new code.`)

	// The header link opens this line in the "Files changed" tab, so that it does not land at the top of the file.
	const line = attribute(attributes, "data-line")
	if (!/^\d+$/.test(line ?? "")) {
		errors.push(`${name}: data-line="${line ?? ""}" must be the line of the first changed line of the diff.`)
	}

	for (const [side, code] of Object.entries(sides)) {
		for (const line of toLines(code)) {
			const columns = line.replaceAll("\t", " ".repeat(TAB_WIDTH)).length
			if (columns > MAX_COLUMNS) {
				errors.push(`${name} (${side}): line has ${columns} columns, limit ${MAX_COLUMNS}: ${line.trim().slice(0, 60)}`)
			}
			if (/^\s*import\s|^\s*export\s+(\*|\{[^}]*\})\s+from\s/.test(line)) {
				errors.push(`${name} (${side}): imports and re-exports are never shown: ${line.trim()}`)
			}
			if (/^\s*\/\/!.*\b(above|below|moved|(old|new) side)\b/i.test(line)) {
				errors.push(`${name} (${side}): a page comment points to other code. Show that code in a diff: ${line.trim()}`)
			}
		}
	}

	// Hidden blocks: unchanged code that the reader opens with a click. It must be the same on both sides, so that it is
	// only unchanged rows.
	const blocks = { old: [], new: [] }
	for (const [side, code] of Object.entries(sides)) {
		let block = null
		for (const line of toLines(code)) {
			if (EXPANDER.test(line.trim())) {
				errors.push(`${name} (${side}): "${line.trim()}" is the row that the page writes for a hidden block. Write the block between //{ and //}.`)
			}
			if (/^\s*\/\/\{\s*$/.test(line)) {
				if (block) errors.push(`${name} (${side}): a //{ line is inside a hidden block. Hidden blocks do not nest.`)
				block = []
				continue
			}
			if (/^\s*\/\/\}\s*$/.test(line)) {
				if (!block) errors.push(`${name} (${side}): a //} line has no //{ line before it.`)
				else blocks[side].push(block)
				block = null
				continue
			}
			block?.push(line.trim())
		}
		if (block) errors.push(`${name} (${side}): a //{ line has no //} line after it.`)
	}
	const blockCount = Math.max(blocks.old.length, blocks.new.length)
	if (blockCount > 0) {
		if (!sides.old.trim() || !sides.new.trim()) {
			errors.push(`${name}: a hidden block is only for unchanged code, so it needs both an old and a new side.`)
		} else if (blocks.old.length !== blocks.new.length) {
			errors.push(`${name}: the old side has ${blocks.old.length} hidden blocks and the new side ${blocks.new.length}. They must match.`)
		} else {
			blocks.new.forEach((lines, index) => {
				if (lines.join("\n") !== blocks.old[index].join("\n")) {
					errors.push(`${name}: hidden block ${index + 1} is not the same on both sides. Hide only unchanged code.`)
				}
				if (lines.filter(line => line !== "").length === 0) errors.push(`${name}: hidden block ${index + 1} is empty.`)
				hiddenContext += lines.filter(line => line !== "").length
			})
		}
	}
	const shown = Object.fromEntries(
		Object.entries(sides).map(([side, code]) => [side, splitHiddenBlocks(toLines(code)).collapsed]),
	)

	if (diffLines) {
		// Each run of added lines, split at the other rows. Comments and short lines do not split a run.
		const addedRuns = [[]]
		for (const row of diffLines(shown.old, shown.new)) {
			// Blank lines are only there to make the code easy to read, as in the page header count.
			if (row.text.trim() === "") continue
			if (row.kind === "add") shownAdditions++
			if (row.kind === "del") shownDeletions++
			if (row.kind === "same") shownContext++
			if (row.kind === "add") addedRuns.at(-1).push(row.text)
			else addedRuns.push([])
		}
		const baseRuns = path === undefined ? new Set() : baseRunsOf(path)
		const moved = addedRuns
			.flatMap(lines => [...addRuns(new Set(), lines)])
			.find(run => removedRuns.has(run) || baseRuns.has(run))
		if (moved) {
			warnings.push(
				`${name}: added lines that are also in a row at the base, so the code moved or was extracted. Show the base code on the old side, so that they are unchanged rows: ${moved.split("\n")[0]}`,
			)
		}
	}

	// A thread's data-line counts lines of the shown code on its side, from 1.
	for (const thread of body.split('<div class="thread"').slice(1)) {
		const threadAttributes = thread.slice(0, thread.indexOf(">"))
		const side = attribute(threadAttributes, "data-side")
		const line = Number(attribute(threadAttributes, "data-line"))
		if (side !== "old" && side !== "new") {
			errors.push(`${name}: a thread has no data-side="old" or data-side="new".`)
			continue
		}
		if (!Number.isInteger(line) || line < 1 || line > shown[side].length) {
			errors.push(`${name}: a thread has data-line="${attribute(threadAttributes, "data-line")}", not a line of the ${side} code.`)
		} else if (EXPANDER.test(shown[side][line - 1].trim())) {
			errors.push(`${name}: a thread is on a hidden block. Show the line of the thread outside the //{ … //} block.`)
		}
		if (!thread.includes('<div class="comment"')) errors.push(`${name}: a thread has no comments.`)
	}
}

// The template renders the Markdown of each comment. Markdown reads an indented line as code.
for (const [, attributes, markdown] of html.matchAll(
	/<div class="comment"([^>]*)>(<script type="text\/markdown">\n(?![ \t\n]))?/g,
)) {
	if (!attribute(attributes, "data-author")) errors.push("A comment has no data-author.")
	if (!/^https:\/\/github\.com\/\S+#discussion_r\d+$/.test(attribute(attributes, "data-href") ?? "")) {
		errors.push(`A comment has data-href="${attribute(attributes, "data-href")}", not the URL of a GitHub review comment.`)
	}
	if (!markdown) {
		errors.push(
			`The comment ${attribute(attributes, "data-href")} does not start with <script type="text/markdown">, a line break and its Markdown at column 0.`,
		)
	}
}
const avatarsJson = html.match(/<script type="application\/json" id="avatars">([\s\S]*?)<\/script>/)?.[1]
const avatars = avatarsJson ? JSON.parse(avatarsJson) : {}
for (const [, author] of html.matchAll(/<div class="comment"[^>]*\sdata-author="([^"]*)"/g)) {
	if (!avatars[author]) warnings.push(`The comment author ${author} has no avatar. Run scripts/avatars.mjs on the page.`)
}
const figureThreads =[...html.matchAll(/<figure class="diff"[^>]*>[\s\S]*?<\/figure>/g)].flatMap(
	([figure]) => figure.match(/<div class="thread"/g) ?? [],
)
if ((html.match(/<div class="thread"/g) ?? []).length !== figureThreads.length) {
	errors.push("A thread is outside a diff figure.")
}

// gather.sh writes threads.json next to the page.
const threadsPath = join(dirname(pagePath), "threads.json")
if (existsSync(threadsPath)) {
	const shownComments = new Set(
		[...html.matchAll(/<div class="comment"([^>]*)>/g)].map(([, attributes]) => attribute(attributes, "data-href")),
	)
	for (const thread of JSON.parse(readFileSync(threadsPath, "utf8"))) {
		const isShown = thread.comments.some(comment => shownComments.has(comment.url))
		const mustShow = thread.startedByHuman && !thread.isOutdated && !thread.isResolved
		const where = `${thread.path}:${thread.line} ${thread.comments[0].url}`
		if (mustShow && !isShown) errors.push(`A human started this open review thread, so the page must show it: ${where}`)
		if (!mustShow && isShown) {
			errors.push(
				`An AI reviewer started this review thread, or it is resolved or outdated, so the page must not show it: ${where}`,
			)
		}
	}
}

// A test name is a list item, or a table cell in a freeform test table.
const testNames = [...html.matchAll(/<(li|td) data-line="([^"]*)"([^>]*)>([\s\S]*?)<\/\1>/g)]
for (const [, , line, attributes, name] of testNames) {
	if (!/^\d+$/.test(line)) errors.push(`A test name has data-line="${line}". It must be a line number.`)
	const change = attribute(attributes, "data-change")
	if (!["added", "modified", "removed"].includes(change)) {
		errors.push(`The test name "${name.trim()}" needs data-change="added", "modified" or "removed".`)
	}
	if (attribute(attributes, "data-renamed-from") && change !== "modified") {
		errors.push(`The test name "${name.trim()}" has data-renamed-from, so it needs data-change="modified".`)
	}
	// A code name such as "TestUpsertAlias" or "TestOrchestration/build once" has no space or starts with "Test".
	if (!/\s/.test(name.trim()) || /\bTest[A-Z]/.test(name)) {
		errors.push(`The test name "${name.trim()}" is a code name. Write it as a plain sentence.`)
	}
}
// A removed test name counts as a shown deletion, and the other test names as shown additions.
const removedTestCount = testNames.filter(([, , , attributes]) => attribute(attributes, "data-change") === "removed").length
shownAdditions += testNames.length - removedTestCount
shownDeletions += removedTestCount

// The cases of one parameterized test have the same line at the head commit. The page shows them as one group, so
// that the reader does not take them for different tests.
const TEST_LIST = /<div data-path="([^"]*)">\s*<(ul|table)\b[^>]*>([\s\S]*?)<\/\2>\s*<\/div>/g
for (const [, path, , list] of html.matchAll(TEST_LIST)) {
	const ungrouped = list.replace(/<li class="cases"[^>]*>\s*<ul>[\s\S]*?<\/ul>\s*<\/li>/g, "")
	const lines = [...ungrouped.matchAll(/<li data-line="([^"]*)"([^>]*)>/g)]
		.filter(([, , attributes]) => attribute(attributes, "data-change") !== "removed")
		.map(([, line]) => line)
	for (const line of new Set(lines.filter((line, index) => lines.indexOf(line) !== index))) {
		errors.push(
			`${path}:${line}: more than one test name has this line, so they are cases of one test. ` +
				'Put them in one <li class="cases" title="Cases of one test"><ul>…</ul></li>.',
		)
	}

	// A name such as "the parser: keeps the order" repeats the name of its describe block in each test.
	const prefixes = [...list.matchAll(/<li data-line="[^"]*"[^>]*>\s*([^<:{"]+): /g)].map(([, prefix]) => prefix.trim())
	for (const prefix of new Set(prefixes.filter((prefix, index) => prefixes.indexOf(prefix) !== index))) {
		warnings.push(
			`${path}: more than one test name starts with "${prefix}: ". If it is a describe block, ` +
				'put its tests in one <li class="describe"> with the name in <span class="describe-name">.',
		)
	}
}

// gather.sh writes removed-tests.txt next to the page. The page shows each removed test as removed, or the test that
// replaces it under a new name with data-renamed-from. A test that replaces several tests lists them all, with spaces
// between them.
const removedTestsPath = join(dirname(pagePath), "removed-tests.txt")
if (existsSync(removedTestsPath)) {
	const shownAsRemoved = new Set()
	const shownAsRenamed = new Set()
	for (const [, path, , list] of html.matchAll(TEST_LIST)) {
		for (const [, line, attributes] of list.matchAll(/<(?:li|td) data-line="([^"]*)"([^>]*)>/g)) {
			if (attribute(attributes, "data-change") === "removed") shownAsRemoved.add(`${path}:${line}`)
			for (const where of attribute(attributes, "data-renamed-from")?.split(/\s+/).filter(Boolean) ?? []) {
				shownAsRenamed.add(where)
			}
		}
	}
	const removedTests = new Set()
	for (const entry of readFileSync(removedTestsPath, "utf8").split("\n").filter(Boolean)) {
		const [path, line, name] = entry.split("\t")
		const where = `${path}:${line}`
		removedTests.add(where)
		if (!shownAsRemoved.has(where) && !shownAsRenamed.has(where)) {
			errors.push(
				`The PR removes the test "${name}" (${where} at the merge base). Show it with data-change="removed", ` +
					`or show the test that replaces it with data-renamed-from="${where}".`,
			)
		}
	}
	for (const where of [...shownAsRemoved, ...shownAsRenamed]) {
		if (!removedTests.has(where)) {
			errors.push(`The page shows a removed or renamed test from ${where}, but removed-tests.txt does not list it.`)
		}
	}
}

if (/<pre class="mermaid"/.test(html)) errors.push('A chart uses Mermaid. Write it as <script type="text/plain" class="dot">.')
const CHART = /<div class="chart"([^>]*)>\s*<script type="text\/plain" class="dot">([\s\S]*?)<\/script>/g
for (const [index, match] of [...html.matchAll(CHART)].entries()) {
	const [, attributes, source] = match
	const name = `Chart ${index + 1}`
	if (!/^\s*digraph\s*\{/.test(source)) errors.push(`${name}: start it with "digraph {".`)
	// Labels can hold any word, so the checks below read only the code around them.
	const code = source.replace(/"(\\.|[^"\\])*"/g, '""')
	if (/\bconstraint\s*=\s*"?false/.test(code)) {
		errors.push(`${name}: remove constraint=false. Graphviz then places the arrow labels after the layout, so they overlap.`)
	}
	for (const [, attribute] of code.matchAll(/\b(shape|color|fillcolor|fontcolor|fontname|fontsize|penwidth|bgcolor)\s*=/g)) {
		errors.push(`${name}: remove ${attribute}. The template sets how boxes and arrows look.`)
	}
	const classNames = new Set(
		[...source.matchAll(/\bclass\s*=\s*"([^"]*)"/g)].flatMap(([, classes]) => classes.split(/\s+/).filter(Boolean)),
	)
	for (const className of classNames) {
		if (!["muted", "added", "removed"].includes(className)) {
			errors.push(`${name}: the class "${className}" is unknown. Use "muted", "added" or "removed".`)
		}
		if (className !== "muted" && !html.includes('<div class="chart-pair">')) {
			errors.push(`${name}: use the class "${className}" only in a before/after pair (<div class="chart-pair">).`)
		}
	}

	// In a pair, a box with only hidden arrows aligns the two layouts, but the reader sees it as a part of the flow.
	const side = html.slice(0, match.index).match(/<b>(Before|Now)<\/b><\/p>\s*$/)?.[1]
	if (side) {
		const boxes = new Map()
		const boxesWithArrows = new Set()
		for (const line of source.split("\n")) {
			const arrow = line.match(/^\s*(\w+)\s*->\s*(\w+)\s*(\[.*\])?/)
			if (arrow) {
				if (!/\bstyle\s*=\s*"?invis/.test(arrow[3] ?? "")) boxesWithArrows.add(arrow[1]).add(arrow[2])
				continue
			}
			const box = line.match(/^\s*(\w+)\s*(\[.*\])/)
			if (box && !["graph", "node", "edge"].includes(box[1])) boxes.set(box[1], box[2])
		}
		for (const [id, boxAttributes] of boxes) {
			if (boxesWithArrows.has(id)) continue
			if (side === "Now" && /\bclass\s*=\s*"[^"]*\bremoved\b/.test(boxAttributes)) continue
			errors.push(
				side === "Before"
					? `${name}: the box ${id} has only hidden arrows. The Before chart has only the boxes of the old flow, so leave it out.`
					: `${name}: the box ${id} has only hidden arrows. Give it class="removed" when the PR removes it from the flow, else leave it out.`,
			)
		}
	}

	const linksJson = attributes.match(/data-links='([^']*)'/)?.[1]
	if (!linksJson) {
		warnings.push(`${name}: no data-links, so its boxes do not open the code.`)
		continue
	}
	let links
	try {
		links = JSON.parse(linksJson)
	} catch {
		errors.push(`${name}: data-links is not valid JSON.`)
		continue
	}
	for (const [id, target] of Object.entries(links)) {
		if (!new RegExp(`(^|[\\s{;>])${id}(?=[\\s\\[;:-]|$)`, "m").test(code)) {
			errors.push(`${name}: data-links has "${id}", but the chart has no box with that id.`)
		}
		if (!/^[^#\s]+(#L\d+(-L\d+)?)?$/.test(target)) {
			errors.push(`${name}: link "${target}" must be "<repo path>#L<line>".`)
		}
	}
}

const sectionIds = [...html.matchAll(/<section id="([^"]+)">/g)].map(match => match[1])
const navIds = [...(html.match(/<nav aria-label="Sections">([\s\S]*?)<\/nav>/)?.[1] ?? "").matchAll(/href="#([^"]+)"/g)].map(
	match => match[1],
)
if (sectionIds.join() !== navIds.join()) {
	errors.push(`The sidebar links (${navIds.join(", ")}) must be the sections in page order (${sectionIds.join(", ")}).`)
}

// gather.sh writes preview-url.txt next to the page. It is empty when the PR has no production preview.
const previewPath = join(dirname(pagePath), "preview-url.txt")
if (existsSync(previewPath)) {
	const previewUrl = readFileSync(previewPath, "utf8").trim()
	const previewLinks = [...html.matchAll(/<a class="preview-link"([^>]*)>/g)].map(([, attributes]) =>
		attribute(attributes, "href")?.replaceAll("&amp;", "&"),
	)
	if (previewUrl && previewLinks.join() !== previewUrl) {
		errors.push(`The sidebar needs one preview link to ${previewUrl} (from preview-url.txt).`)
	}
	if (!previewUrl && previewLinks.length > 0) {
		errors.push("The PR has no production preview (preview-url.txt is empty), so remove the sidebar preview link.")
	}
}

// The budget counts only the + and − lines, as the page header does. Unchanged lines only place the change (for example
// the enclosing config object), so they do not count.
const prLines = prAdditions + prDeletions
const shownLines = shownAdditions + shownDeletions
if (prLines > 0) {
	const share = shownLines / prLines
	console.log(
		`Shown: ${shownLines} lines (+${shownAdditions} with ${testNames.length} test names, −${shownDeletions}; ` +
			`${shownContext} unchanged and ${hiddenContext} hidden lines do not count) of ${prLines} PR lines = ${(share * 100).toFixed(1)}% ` +
			`(limit ${BUDGET_RATIO * 100}%)`,
	)
	if (share > BUDGET_RATIO) errors.push(`The page shows more than ${BUDGET_RATIO * 100}% of the PR lines.`)
}

for (const warning of warnings) console.log(`warning: ${warning}`)
for (const error of errors) console.log(`error: ${error}`)
if (errors.length > 0) process.exit(1)
console.log("All checks passed.")
