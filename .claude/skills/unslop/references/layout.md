# Readable code: space and comments

Read this before the **Space and comment** step, and apply it to every function the diff added or changed.

People and agents both read this code, and both read it faster when each line holds one idea and each reason is written down. AI-written code drifts the other way: no blank line from the first statement to the `return`, three operations in one expression, and no word about why. A formatter fixes none of that. It breaks long lines, and it never adds a blank line, a name or a comment. Fewer lines is not the goal; fewer things to hold in your head at once is. Blank lines, named steps and comments that say why all add lines, and all are part of the cleanup.

## Space

- **Paragraphs.** A function body reads in phases: read the input, guard, do the work, build the result. One blank line goes between phases and none inside one. Lines that belong together stay together, such as a value and the guard on it. A body of more than about six statements with no blank line has not been split yet.
- **Blocks stand apart.** A multi-line `if`, `for`, `try` or call gets a blank line before and after it, unless it opens or closes the block it sits in. So does the final `return` after several lines of work.
- **One statement per line**, and one declaration per `const` / `let`.
- **Blocks get their own lines.** No `try { … } catch { }`, `} finally { … }` or multi-statement `if` body on one line, and a `for` or `if` whose body wraps gets braces. A short guard such as `if (!entry.isDirectory()) continue` stays on one line.
- **Name the steps.** A chain that filters, maps and reduces in one expression, a call inside a call inside a call, an argument that is itself a computation: each step that means something gets its own `const`, named in the domain's words (`const reservedUnitIds = …`). A ternary inside a template literal, a template literal inside another, or an error message built inline in a `throw` gets a named variable on the line before. A nested ternary becomes an `if` chain, a `typedSwitch` or a lookup map.
- **Name a hard condition.** Three or more clauses, or one a reader has to decode, becomes a named boolean (`const isSkillFolder = …`) or separate guards, each with its own reason.
- **Long lines are a symptom.** A line the formatter leaves past about 100 characters, or one it had to wrap over four lines, is usually doing two things; split the expression, not just the line.

**Stop at one idea per line.** No blank line after every statement, no short call wrapped over several lines, and no variable that only renames a value (`const result = total` before `return result`). A name earns its line when it says something the expression does not. Match the repo's formatter and its quote and semicolon style. When the surrounding file is dense itself, space out the code you touch, not the whole file.

## Comments

The code says what happens. A comment says what the code cannot: why, under which constraint, and what breaks otherwise. At the end of a feature those reasons live only in your session: the limit you looked up, the order that turned out to matter, the approach that failed. Write each one down where the next reader will be standing, because the session ends and the code stays.

**A comment is owed** at each of these, unless a name already says it:

1. **A value whose origin is not on the page**: a limit, timeout, batch size, threshold or regular expression. Say where it comes from or what it protects, and for a regular expression, what it matches.
2. **An order that matters**: why this runs before that, or why two steps cannot be merged.
3. **A workaround**: what it works around, with the issue or version, and when it can go.
4. **A guard or branch for a case the types do not show**: when that case happens.
5. **Something left out on purpose**: no `await`, no retry, no transaction, an ignored error. Say why it is safe.
6. **A business rule**: the rule in the domain's words, not the code's.
7. **An exported function whose signature cannot carry its contract**: units, time zone, inclusive or exclusive bounds, what it throws, what it sends or writes. One short doc comment.
8. **A block whose purpose takes reading all of it**: one line above it saying what the block achieves. A block that needs more than a line is asking to be a function with that name.

**Write it** as one or two plain sentences on the lines above the code, in the present tense, about what is true now. The story of the change belongs in the commit message.

**A comment goes** when it narrates the next line (`// Fetch the user`), restates a name or a type (`@param id The id`), justifies the change or says where code came from ("moved from X", "now uses the shared helper", "safe because validated above"), or is a banner (`// ---- Helpers ----`).

**Only what you know.** A comment states a reason you can point to: this session, the issue, the commit history (`git log -S`), the code it sits in. Never guess a reason to fill one of the eight places. When the reason for older code is unknown, write no comment.

**An empty `catch` says why.** A one-line comment names the failure it expects and why ignoring it is safe. With no such reason to give, it is a swallowed failure: let the error through.

## Before and after: a dense function the formatter already passed

Before, formatted and typed, with nothing wrong on any single line:

```ts
export async function cancelOrder(orderId: Id<'Order'>) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true, shipments: true },
  })
  if (order.status === 'CANCELLED') return order
  if (order.shipments.some((shipment) => shipment.status !== 'PENDING'))
    throw new ORPCError('CONFLICT', { message: 'Order has shipped' })
  for (const batch of chunk(
    order.lines.flatMap((line) => line.reservedUnitIds),
    25,
  ))
    await releaseUnits(batch)
  await carrier.cancelShipments(order.shipments.map((shipment) => shipment.carrierId))
  return prisma.order.update({
    where: { id: orderId },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  })
}
```

After:

```ts
export async function cancelOrder(orderId: Id<'Order'>) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true, shipments: true },
  })

  // A retried request finds the order cancelled already and changes nothing.
  if (order.status === 'CANCELLED') return order

  const hasShipped = order.shipments.some((shipment) => shipment.status !== 'PENDING')
  if (hasShipped) {
    throw new ORPCError('CONFLICT', { message: 'Order has shipped' })
  }

  // Units go back to stock before the carrier hears of it: the carrier call cannot
  // be undone, so a release that fails has to leave the shipments as they were.
  // The warehouse API takes at most 25 units per call.
  const reservedUnitIds = order.lines.flatMap((line) => line.reservedUnitIds)
  for (const batch of chunk(reservedUnitIds, 25)) {
    await releaseUnits(batch)
  }

  const carrierShipmentIds = order.shipments.map((shipment) => shipment.carrierId)
  await carrier.cancelShipments(carrierShipmentIds)

  return prisma.order.update({
    where: { id: orderId },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  })
}
```

The logic is unchanged. The five phases are visible at a glance, the two chains have names, and the three comments hold what the session knew and the code could not say: why a second cancel is harmless, why the order of the two calls matters, and where 25 comes from.

## Before and after: compressed code

Before:

```ts
export function readRepoSkills(root: string): { skills: FetchedSkill[]; skipped: string[] } {
  const skills: FetchedSkill[] = [], skipped: string[] = [], inside = realpathSync(root) + sep;
  for (const dir of [join(root, ".claude", "skills"), join(root, ".agents", "skills")]) {
    let entries: Dirent[] = [];
    // `.claude/skills` is often a link to `.agents/skills`; one leaving the repository is ignored.
    try { if (realpathSync(dir).startsWith(inside)) entries = readdirSync(dir, { withFileTypes: true }); } catch { }
    for (const entry of entries) {
      const id = skillId(entry.name);
      if (!entry.isDirectory() || !existsSync(join(dir, entry.name, "SKILL.md")) || skills.some(k => k.id === id)) continue;
      try { skills.push({ id, ...readSkill(join(dir, entry.name)) }); }
      catch (error) { skipped.push(`${entry.name}: ${error instanceof Error ? error.message : error}`); }
    }
  }
  if (!skills.length) throw new Error(skipped.length ? `no usable skills: ${skipped.join("; ")}` : "no skills in .claude/skills or .agents/skills");
  return { skills: validateFetched(skills), skipped };
}
```

After:

```ts
export function readRepoSkills(root: string) {
  const skills: FetchedSkill[] = [];
  const skipped: string[] = [];
  const insideRepo = realpathSync(root) + sep;

  for (const dir of [join(root, ".claude", "skills"), join(root, ".agents", "skills")]) {
    let entries: Dirent[] = [];

    // `.claude/skills` is often a link to `.agents/skills`; a link that leaves the repository is ignored.
    try {
      if (realpathSync(dir).startsWith(insideRepo)) {
        entries = readdirSync(dir, { withFileTypes: true });
      }
    } catch {
      // A missing folder or a broken link: there is nothing to read.
    }

    for (const entry of entries) {
      const id = skillId(entry.name);
      const path = join(dir, entry.name);

      const isSkillFolder = entry.isDirectory() && existsSync(join(path, "SKILL.md"));
      const alreadyRead = skills.some((skill) => skill.id === id);
      if (!isSkillFolder || alreadyRead) continue;

      try {
        skills.push({ id, ...readSkill(path) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push(`${entry.name}: ${reason}`);
      }
    }
  }

  if (skills.length === 0) {
    const message = skipped.length > 0
      ? `no usable skills: ${skipped.join("; ")}`
      : "no skills in .claude/skills or .agents/skills";
    throw new Error(message);
  }

  return { skills: validateFetched(skills), skipped };
}
```

The logic is unchanged. Each line now says one thing, the phases are visible at a glance, and the two comments explain what the code cannot.
