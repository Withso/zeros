# Playbook: prototype

For a throwaway sketch that settles a design or behavior question by
observation: try a layout, compare two approaches, check how an API behaves.

1. **Name the question** and the result that would decide it. A product or
   preference call that no experiment can settle goes to the user instead.
2. **Build the smallest sketch** that produces the deciding observation, in a
   scratch branch or worktree. For UI, mock it as a frame in `Zeros - Design/`
   and capture it (`ui-design.md`). Skip polish, tests and compatibility, and
   never touch persisted data, credentials or live Alpha resources.
3. **Observe and record** the measurement, screenshot or output, with the
   commands that produced it.
4. **Decide and discard.** Report the result and the decision it supports,
   then delete the sketch. Anything worth keeping is rebuilt through the
   feature or refactor playbook, with tests.
