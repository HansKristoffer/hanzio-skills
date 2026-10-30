"""Check the skills' structure: frontmatter, links, em dashes and README rows.

Usage:
    python3 -I scripts/check-skills.py

Prints one line per problem and exits 1 when there is any.
"""

from __future__ import annotations

import pathlib
import re
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKILLS = ROOT / ".claude" / "skills"
README = ROOT / "README.md"
MAX_DESCRIPTION = 1024  # Agent Skills spec and Codex; Claude Code truncates at 1536
TEXT_SUFFIXES = {".md", ".sh", ".py", ".sql", ".ts", ".js", ".mjs", ".html", ".yaml", ".yml", ".json"}
EM_DASH = "—"
QUOTED_EM_DASH = f"`{EM_DASH}`"  # a rule that names the character it bans
LINK = re.compile(r"\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")

problems: list[str] = []


def problem(path: pathlib.Path, line: int | None, message: str) -> None:
    where = path.relative_to(ROOT).as_posix()
    if line is not None:
        where += f":{line}"
    problems.append(f"{where}: {message}")


def frontmatter(path: pathlib.Path) -> dict[str, str] | None:
    """Read the top-level scalar keys, folding `>` / `|` blocks and continuation lines."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        problem(path, 1, "must start with a --- frontmatter line")
        return None
    try:
        end = lines.index("---", 1)
    except ValueError:
        problem(path, 1, "frontmatter has no closing ---")
        return None

    fields: dict[str, str] = {}
    key = None
    style = ""
    parts: list[str] = []

    def flush() -> None:
        if key is None:
            return
        if style.startswith("|"):
            value = "\n".join(parts)
        else:
            value = " ".join(p for p in parts if p)
        fields[key] = value.strip()

    for raw in lines[1:end]:
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", raw)
        if match and not raw.startswith((" ", "\t")):
            flush()
            key, value = match.group(1), match.group(2).strip()
            style = value if value[:1] in (">", "|") else ""
            if style:
                parts = []
            elif len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                parts = [value[1:-1]]
            else:
                parts = [value]
        elif key is not None:
            parts.append(raw.strip())
    flush()
    return fields


def check_skill(skill: pathlib.Path) -> None:
    entry = skill / "SKILL.md"
    if not entry.is_file():
        problem(skill, None, "skill folder has no SKILL.md")
        return
    fields = frontmatter(entry)
    if fields is None:
        return
    if fields.get("name") != skill.name:
        problem(entry, None, f"name: must be {skill.name!r}, found {fields.get('name')!r}")
    description = fields.get("description", "")
    if not description:
        problem(entry, None, "description: is missing or empty")
    elif len(description) > MAX_DESCRIPTION:
        problem(entry, None, f"description: is {len(description)} characters, the limit is {MAX_DESCRIPTION}")


def check_links(path: pathlib.Path, inside: pathlib.Path) -> None:
    in_fence = False
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for target in LINK.findall(re.sub(r"`[^`]*`", "", line)):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
                continue
            relative = urllib.parse.unquote(target.split("#", 1)[0])
            if not relative:
                continue
            resolved = (path.parent / relative).resolve()
            if not resolved.is_relative_to(inside):
                problem(path, number, f"link {target} leaves {inside.relative_to(ROOT).as_posix() or 'the repository'}")
            elif not resolved.exists():
                problem(path, number, f"link {target} does not resolve")


def check_em_dashes(path: pathlib.Path) -> None:
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if EM_DASH in line and QUOTED_EM_DASH not in line:
            problem(path, number, "em dash; end the sentence or use a comma")


def main() -> int:
    skills = sorted(p for p in SKILLS.iterdir() if p.is_dir())
    readme = README.read_text(encoding="utf-8")

    for skill in skills:
        check_skill(skill)
        if f"(.claude/skills/{skill.name}/SKILL.md)" not in readme:
            problem(README, None, f"no table row links .claude/skills/{skill.name}/SKILL.md")
        for path in sorted(skill.rglob("*")):
            if not path.is_file() or path.suffix not in TEXT_SUFFIXES or "node_modules" in path.parts:
                continue
            check_em_dashes(path)
            if path.suffix == ".md":
                check_links(path, skill.resolve())

    for path in sorted(ROOT.glob("*.md")):
        check_em_dashes(path)
        check_links(path, ROOT)

    for line in problems:
        print(line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
