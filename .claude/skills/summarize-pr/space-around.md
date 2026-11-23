# Space around

Where to put blank lines between lines of TypeScript and JavaScript code, and which lines to keep together.

Write a function body as paragraphs: one paragraph per step of the logic, one blank line between steps, no blank line
inside a step. Lines are together by default. A blank line needs one of the reasons below.

The reader reads a blank line as "a new step starts here". AI code gets this wrong in two opposite ways: too dense in
long functions (no blank line after guards, multi-line statements glued to their neighbors) and too airy in short
blocks (blank lines inside 2–3 statement blocks, between a value and its check). The [examples](#examples)
show each case in code.

## How to apply

- When you write code, decide the paragraphs of each block while you write it, not in a later pass.
- When you fix the spacing of existing code, change only blank lines. Do not re-space code that the task does not
  touch: a minimal diff is more important than spacing.
- The formatter keeps one blank line, collapses several into one and removes blank lines at the start and end of a
  block. It never adds a blank line, so every blank line is your decision.
- When two rules conflict, the earlier rule wins.

## Rules

1. **Never** put a blank line inside object literals, type literals, interfaces, enums, JSX children or argument
   lists; between `case` clauses; between a comment and the code it describes; or between `break`/`continue` and the
   line above.
2. **A check stays with what it checks.** `const x = …` followed by a one-line guard on `x` (`if (!x) return`),
   `assert(x…)` or `expect(x…)` is one step, also when the declaration is multi-line. A run of one-line guards, or of
   `assert`/`expect` calls, stays together. The check ends the step: start a new paragraph after it.
3. **Small blocks are one paragraph.** Put no blank line in:
   - a block of 2–3 one-line statements;
   - a nested block (`if`, loop, `case` or callback body) of 2 statements, also when one of them is multi-line;
   - a function body of 2 statements, unless one of them has 6+ lines: then set that statement apart.
4. **After a guard, start a new step.** Put a blank line after `if (…) return/throw/continue/break` (one-line or
   braced), unless the next line is another one-line guard or completes the guard
   (`if (seen.has(id)) return` + `seen.add(id)`).
5. **Set multi-line blocks apart.** Put a blank line before and after a braced `if`, a loop, a `switch`, a `try`, and a
   multi-line statement with a function or block body (`useEffect(() => {…})`, `items.map(item => {…})`). Exceptions:
   - **Lead-in:** a one-line declaration used only by the next statement stays attached to it when that statement has
     up to about 5 lines. Before a statement of 10+ lines, put a blank line.
   - **Check of the value above:** a braced `if` that checks the value just declared stays attached when the value is
     not used after the `if`. When the value is used again after the `if`, put a blank line if the declaration is
     multi-line or the `if` tests a property of the value (`if (result.type === "resolved") {`).
6. **One-line statements:** keep a chain together (each line uses the one above, or they use the same input).
   One-line declarations usually stay together also when they do not use each other; put a blank line only when the
   second one clearly starts a different step. After an action (a call or an assignment), put a blank line before a new
   declaration.
7. **The final `return`:** when the body already has paragraphs, the `return` is its own paragraph, unless it is a
   one-line `return` that only passes on or wraps the result of the one-line statement above. A `return` of 6+ lines
   is always its own paragraph. In a short or dense block, the `return` stays with the line above.
8. **Comments:** put a blank line before a comment that starts a step, never after it. A one-line comment about only
   the next line of a group stays inside the group.

## Module level and classes

- Imports are one block, followed by one blank line.
- One blank line around each function, class, interface and multi-line declaration, also when they are related.
- Group one-line constants or types of the same kind, and separate the groups by topic.
- In a class, put blank lines around methods and group one-line fields.

## Examples

Read these when a case is unclear.

### A value and its check are one step; the next value starts a new one

The last pair is "compute → return": a one-line `return` that only wraps the line above stays with it (rule 7).

```ts
const order = orderStore.get(orderId)
if (!isPaid(order)) return undefined

const invoiceId = getInvoiceId(order.payment)
if (!invoiceId) return undefined

const invoice = invoiceStore.get(invoiceId)
return isInvoice(invoice) ? invoice : undefined
```

Here the `return` builds a new value, so it is its own paragraph:

```ts
function getStoredUrl(value: unknown): string | undefined {
	const url = parseUrl(value)
	if (isUndefined(url)) return

	const normalizedUrl = normalizeUrl(url)
	if (isUndefined(normalizedUrl)) return

	return JSON.stringify(normalizedUrl)
}
```

### A dense AI function, and the same function in paragraphs

Before (AI, no blank lines):

```ts
const parts: string[] = []
for (const sort of sortOptions) {
	const column = columnsByName.get(sort.field)
	if (!column || !column.isSortable) continue
	const direction = sort.direction === "desc" ? "DESC" : "ASC"
	parts.push(`${quoteIdentifier(column.name)} ${direction}`)
}
if (parts.length === 0) {
	return `ORDER BY ${quoteIdentifier(defaultSortColumn)}`
}
return `ORDER BY ${parts.join(", ")}`
```

After: the accumulator is set apart from the long loop, the guard ends a step inside the loop, the braced `if` and the
final `return` are their own paragraphs.

```ts
const parts: string[] = []

for (const sort of sortOptions) {
	const column = columnsByName.get(sort.field)
	if (!column || !column.isSortable) continue

	const direction = sort.direction === "desc" ? "DESC" : "ASC"
	parts.push(`${quoteIdentifier(column.name)} ${direction}`)
}

if (parts.length === 0) {
	return `ORDER BY ${quoteIdentifier(defaultSortColumn)}`
}

return `ORDER BY ${parts.join(", ")}`
```

Compare: a short loop stays with its accumulator (both forms are common).

```ts
const emails: string[] = []
for (const user of users) {
	const email = normalizeEmail(user.email)
	if (email) emails.push(email)
}

return { recipients: emails.join(", ") }
```

### Each "value + guard" unit is a paragraph, also with a multi-line value

```ts
if (request.method !== "POST") return

const session = sessionStore.getSessionFor(request)
if (!isActive(session)) return

const isAdmin = session.user.roles.some(
	role => isRoleDefinition(role) && grantsAdminAccess(role),
)
if (!isAdmin) return
```

The multi-line value keeps its one-line guard; the multi-line `assert` and the multi-line `return` are set apart.

```ts
const plan =
	getPlanById(account, subscription.planId) ??
	getPlanByName(availablePlans, subscription.planName)
if (!plan) return undefined

assert(
	plan.billing === "monthly" || plan.billing === "yearly",
	`Plan "${plan.name}" must bill monthly or yearly, but it bills "${plan.billing}".`,
)

return {
	planId: plan.id,
	billing: plan.billing,
	seats: plan.billing === "yearly" ? plan.seats : undefined,
}
```

### A dispatch on a value that is used again

The braced `if` blocks test a property of the result, so each one is its own paragraph (rule 5).

```ts
const amountInput = form.fields.amount
if (!isString(amountInput)) return

const parseResult = amountParser.parse(amountInput, {
	allowedCurrencies: [Currency.EUR, Currency.USD],
})

if (parseResult.type === "invalid") {
	throw new Error(parseResult.errorMessages.join("\n"))
}

if (parseResult.type === "parsed") {
	…
}
```

### A lead-in before a long statement

The lead-in `const tableName` is used only by the query, but the query has 10+ lines, so it gets a blank line
(rule 5). There is also a blank line after the multi-line query (the guard is braced and `article` is used again)
and before the `return` (after a guard).

```ts
export async function fetchArticleMetadata(slug, locale, databaseClient) {
	const tableName = "articles"

	const [article] = await databaseClient.query(
		{
			tableName,
			columns: [
				{ alias: "title", column: "title" },
				{ alias: "noIndex", column: "no_index" },
			],
			filters: getSlugFilters(slug),
			orderBy: [],
			offset: 0,
			limit: 1,
		},
		locale,
	)

	if (!article) {
		throw new Error("No article matches the slug")
	}

	return toMetadata(article, locale)
}
```
