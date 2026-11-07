# Readable layout

Read this when touched code is compressed: several statements on a line, a `try`/`catch` folded onto one line, an empty `catch`, a condition with three or more clauses, a template literal inside another, a line past about 100 characters.

People and agents both read this code, and both read it faster when each line holds one idea. AI-written code drifts the other way, packing in as many statements per line as the formatter allows. Fewer lines is not the goal; fewer things to hold in your head at once is. Spacing out compressed code is part of the cleanup, even though it adds lines.

- **One statement per line**, and one declaration per `const` / `let`.
- **Blocks get their own lines.** No `try { … } catch { }`, `} finally { … }` or multi-statement `if` body on one line. A short guard such as `if (!entry.isDirectory()) continue` stays on one line.
- **Blank lines between phases**: setup, guards, the work, the result. Lines that belong together stay together.
- **Name a hard condition.** Three or more clauses, or one a reader has to decode, becomes a named boolean (`const isSkillFolder = …`) or separate guards, each with its own reason.
- **Pull nested expressions out.** A ternary inside a template literal, a template literal inside another, or an error message built inline in a `throw` gets a named variable on the line before.
- **An empty `catch` says why.** A one-line comment names the failure it expects and why ignoring it is safe.
- **Long lines are a symptom.** A line the formatter leaves past about 100 characters is usually doing two things; split the expression, not just the line.

**Stop at one idea per line.** No blank line after every statement, no variable for a sub-expression that is already clear, no short call wrapped over several lines. Match the repo's formatter and its quote and semicolon style. When the surrounding file is compressed itself, space out the code you touch, not the whole file.

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
