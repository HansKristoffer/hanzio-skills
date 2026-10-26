# Answer reviews

Review bots are useful and often wrong. Learn which ones the repository uses from the reviews on its recent PRs and from their config files (`greptile.json`, `.greptile/`, `.macroscope/`, `.coderabbit.yaml`). Greptile and Macroscope gate: wait for their review of the current head. CodeRabbit is advisory: handle its findings like any other, and never wait for it or hold a merge for it.

## Read them

```bash
gh pr view "$PR" --repo "$REPO" --json reviews,comments
gh api graphql -F owner="${REPO%/*}" -F name="${REPO#*/}" -F pr="$PR" -f query='
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
      reviewThreads(first: 100) { nodes { id isResolved isOutdated path line
        comments(first: 20) { nodes { author { login } body url createdAt } } } } } } }' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)'
```

Act on every unresolved thread, and on review bodies and top-level comments newer than your latest push; older ones were handled in an earlier round. If the repository has `.macroscope/check-run-agents/*.md`, read those rules before answering a Macroscope finding, since its findings cite them.

A gating bot's review usually also reports as a check run, which **Watch the current head** already waits for. When it arrives only as a review, re-read the reviews once the checks finish; if it is still missing for the current head, wait with the harness's PR watcher, which wakes on reviews, or with one background command that sleeps ten minutes.

## Judge each finding

Check every finding against the source before changing code, and reproduce it when you can. The bot's severity label is a claim; judge the severity yourself.

Keep the PR at the size its goal needs. Review loops grow a PR one cheap-looking fix at a time. Fix real bugs in the intended case with the smallest change, verified and pushed like a CI fix (it counts toward the same budget). Prefer the fix that deletes or narrows code. Decline the rest with a written reason: extra tests, guards for cases that do not matter here, extra compatibility or integration, small performance costs. List the declined items worth doing later as follow-ups in the finish message.

Make clear changes a human reviewer requests as fixes. Replying to a human, and resolving their thread, needs authorization; otherwise leave their thread for them and mention it in the finish message.

## Reply and resolve

Reply to each bot thread once it is fixed or declined: what changed and in which commit, or why it was declined. Resolve the thread only after the reply posted and GitHub returned its URL.

```bash
gh api graphql -F thread="$THREAD_ID" -F body=@<reply-file> -f query='
  mutation($thread: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { url } } }'
gh api graphql -F thread="$THREAD_ID" -f query='
  mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }'
```

Start every comment posted on the user's behalf with this note, with the model name the harness reports (the harness name when it reports none) and the user's GitHub login:

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <login>**

<reply>
```

Lead the reply with the conclusion and cite the code, check or reproduction behind it, in a few sentences. Before posting, check the whole comment, quotes included, for secrets and private details. The note goes on replies, review comments and top-level comments; PR bodies and commit messages carry none.
