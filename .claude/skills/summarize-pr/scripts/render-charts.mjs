// Renders the charts of a summarize-pr page in headless Chrome, with the same template script as the artifact host.
// Usage: node render-charts.mjs <page.html> [<out dir>]
// Saves chart-<n>.png for each chart and prints every label or line that overlaps, and every text wider than its box.
// Exits with 1 if it finds any. Needs puppeteer-core: npm install --prefix <the folder of this script>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const [pagePath, outDirArgument] = process.argv.slice(2)
if (!pagePath) {
	console.error("Usage: node render-charts.mjs <page.html> [<out dir>]")
	process.exit(2)
}
const outDir = resolve(outDirArgument ?? join(dirname(pagePath), "charts"))
mkdirSync(outDir, { recursive: true })

let puppeteer
try {
	puppeteer = (await import("puppeteer-core")).default
} catch {
	console.error(`puppeteer-core is missing. Run: npm install --prefix ${dirname(fileURLToPath(import.meta.url))}`)
	process.exit(2)
}

// The artifact host wraps the page in a document like this one.
const renderPath = join(outDir, "render.html")
writeFileSync(
	renderPath,
	`<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"></head><body>\n${readFileSync(pagePath, "utf8")}\n</body></html>`,
)

// CHROME_PATH wins. Else the first Chrome found: the macOS app, a Linux install, or a Chromium that Playwright (which
// agent-browser uses) downloaded, newest first.
function findChrome() {
	const playwright = join(homedir(), ".cache", "ms-playwright")
	const downloaded = existsSync(playwright)
		? readdirSync(playwright)
				.filter(name => /^chromium-\d+$/.test(name))
				.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
				.flatMap(name => ["chrome-linux64/chrome", "chrome-linux/chrome"].map(path => join(playwright, name, path)))
		: []
	const candidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		...downloaded,
	]
	return process.env.CHROME_PATH ?? candidates.find(path => existsSync(path))
}

const executablePath = findChrome()
if (!executablePath) {
	console.error("No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.")
	process.exit(2)
}
// Ubuntu 23.10+ blocks Chrome's own sandbox with AppArmor, as agent-browser's setup notes. Only then, launch without it.
async function launch() {
	try {
		return await puppeteer.launch({ executablePath, headless: true })
	} catch (error) {
		if (!String(error.message).includes("No usable sandbox")) throw error
		return puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] })
	}
}
const browser = await launch()
const problems = []
try {
	const tab = await browser.newPage()
	tab.on("console", message => {
		if (message.type() === "warn" || message.type() === "error") problems.push(`console: ${message.text()}`)
	})
	await tab.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
	await tab.goto(`file://${renderPath}`, { waitUntil: "networkidle0" })
	// The template appends an <svg>, or a <pre> with the chart source when Graphviz fails.
	await tab.waitForFunction(
		() => [...document.querySelectorAll(".chart")].every(chart => chart.querySelector(":scope > :is(svg, pre)")),
		{ timeout: 30000 },
	)
	await tab.evaluate(() => document.fonts.ready)

	for (const [index, chart] of (await tab.$$(".chart")).entries()) {
		const name = `chart ${index + 1}`
		const path = join(outDir, `chart-${index + 1}.png`)
		await chart.screenshot({ path })
		console.log(`${name}: ${path}`)
		const chartProblems = await chart.evaluate(element => {
			if (!element.querySelector(":scope > svg")) return ["it did not render (see the console problems)"]
			const result = []
			const rectOf = elements => {
				const rects = elements.map(item => item.getBoundingClientRect())
				return {
					left: Math.min(...rects.map(rect => rect.left)),
					top: Math.min(...rects.map(rect => rect.top)),
					right: Math.max(...rects.map(rect => rect.right)),
					bottom: Math.max(...rects.map(rect => rect.bottom)),
				}
			}
			// 1px of tolerance, so that edges that only touch do not count.
			const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
				Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
			const textOf = group => [...group.querySelectorAll("text")].map(line => line.textContent).join(" ")

			const boxes = [...element.querySelectorAll("g.node")].map(node => ({
				node,
				text: textOf(node),
				shape: rectOf([node.querySelector(":scope > :is(path, polygon)")]),
			}))
			const labels = [...element.querySelectorAll("g.edge")]
				.filter(edge => edge.querySelector("text"))
				.map(edge => ({ edge, text: textOf(edge), rect: rectOf([...edge.querySelectorAll("text")]) }))

			for (const box of boxes) {
				const text = rectOf([...box.node.querySelectorAll("text")])
				if (text.left < box.shape.left + 2 || text.right > box.shape.right - 2) {
					result.push(`the text of box “${box.text}” is wider than the box`)
				}
			}
			for (const [i, label] of labels.entries()) {
				for (const other of labels.slice(i + 1)) {
					if (overlaps(label.rect, other.rect)) result.push(`label “${label.text}” overlaps label “${other.text}”`)
				}
				for (const box of boxes) {
					if (overlaps(label.rect, box.shape)) result.push(`label “${label.text}” overlaps box “${box.text}”`)
				}
			}
			for (const edge of element.querySelectorAll("g.edge")) {
				const line = edge.querySelector("path")
				const matrix = line.getScreenCTM()
				const length = line.getTotalLength()
				for (const label of labels) {
					if (label.edge === edge) continue
					for (let at = 0; at <= length; at += 3) {
						const point = new DOMPoint(line.getPointAtLength(at).x, line.getPointAtLength(at).y).matrixTransform(matrix)
						const { left, top, right, bottom } = label.rect
						if (point.x > left + 1 && point.x < right - 1 && point.y > top + 1 && point.y < bottom - 1) {
							result.push(`a line goes through label “${label.text}”`)
							break
						}
					}
				}
			}
			return result
		})
		for (const problem of chartProblems) problems.push(`${name}: ${problem}`)
	}
} finally {
	await browser.close()
}

for (const problem of problems) console.log(`error: ${problem}`)
if (problems.length > 0) process.exit(1)
console.log("No overlaps.")
