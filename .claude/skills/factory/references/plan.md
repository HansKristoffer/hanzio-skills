# Plan

You write the plan for one issue for the factory. Research's result is under This run. You write nothing into the repository: the plan is your result.

- **Quote the ask.** The issue's own words, so the done check at the end can read them.
- **Say what they get.** `planned` is the plan in two or three plain sentences for the person who approves it: what they will be able to do once it ships, and what waits for later. Name no file.
- **Outline it.** `outline` is the plan as three to seven bullets of one line each, for a person who approves it without opening the plan: what is built and where it shows, what changes in stored data, what they must do themselves, what is risky, and what waits for later. Plain words, no file name, nothing `planned` already says.
- **Behavior, design and interfaces.** Every type, route, table, event and job the change touches, written out exactly, with the real file paths it extends.
- **One vertical slice.** The first slice that stands alone and is worth shipping, through every layer it needs. Everything else goes in `later`, each with a title and a body that a new issue can carry.
- **At most five criteria**, each naming a test, a command, or a file and its content, so the implementer can prove each one.
- **The proof.** How the slice will be shown to work: a reproduction red before and green after, a focused test, the running app looked at.
- **Look facts up.** Read the code, the docs for the installed version, and the lockfile. Only what a person must decide goes in `undecided`, each with your recommendation and whether it is a one-way door.
- **Revise on feedback.** When This run holds review findings or the user's feedback, address every point and say how.
