// Embeds the GitHub avatars of the comment authors in a summarize-pr page. The artifact host blocks external images,
// so the page carries them as data URIs in one JSON block, which the template reads.
// Usage: node avatars.mjs <page.html>. It reads avatars.json, which gather.sh writes next to the page.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const pagePath = process.argv[2]
if (!pagePath) {
	console.error("Usage: node avatars.mjs <page.html>")
	process.exit(2)
}

const html = readFileSync(pagePath, "utf8")
const avatars = JSON.parse(readFileSync(join(dirname(pagePath), "avatars.json"), "utf8"))
const authors = new Set([...html.matchAll(/<div class="comment"[^>]*\sdata-author="([^"]*)"/g)].map(match => match[1]))
const shown = Object.fromEntries([...authors].filter(author => avatars[author]).map(author => [author, avatars[author]]))

const block = `<script type="application/json" id="avatars">${JSON.stringify(shown)}</script>\n`
const AVATARS = /<script type="application\/json" id="avatars">[\s\S]*?<\/script>\n?/
const page = AVATARS.test(html)
	? html.replace(AVATARS, () => block)
	: html.replace('<script type="module">', () => `${block}<script type="module">`)
writeFileSync(pagePath, page)

console.log(`Embedded the avatars of ${Object.keys(shown).length} of ${authors.size} comment authors.`)
for (const author of authors) {
	if (!avatars[author]) console.log(`warning: avatars.json has no avatar for ${author}. The page shows only the name.`)
}
