# Guard the route to a resource, not only where it resolves

- **Symptom.** In a new checkout, the `.git` file reached its Git directory
  through `metadata-link/repository`, where `metadata-link` was a link inside
  the checkout. That checkout passed the restore guard. A saved file then
  replaced the link, and the repository was lost to every later retry.
- **Cause.** The guard resolved the parent of the target with `cd` and
  `pwd -P`. Physical normalization reports only where a path ends up, so it
  drops every link it went through. The Git and common directories were both
  outside the checkout, so nothing on the list was inside it.
- **Rule.**
  - When writes must not break a path, follow that path one name at a time,
    as the kernel does: `.` and `..` by their physical meaning, and links
    through their own targets, with a hop limit.
  - Record every name looked up inside the protected tree. Refuse writes if
    anything is on the route, or leave the links out of anything you copy.
  - Cover every pointer the owner follows. For Git these are the `.git` file
    and the Git directory's `commondir` file.
- **Encoded in.** The cases in `apps/control-plane/src/cloud/checkpoint.test.ts`:
  - "never saves a link inside the old checkout that its .git file reaches
    its Git directory through";
  - "restores a new checkout whose .git file reaches its Git directory by …
    only if nothing on the way is inside it";
  - "refuses a linked worktree whose common Git directory is reached through
    a link inside it".
