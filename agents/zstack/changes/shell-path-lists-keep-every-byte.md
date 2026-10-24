# Pass shell path lists NUL-terminated, keeping every byte

- **Symptom.** A checkout whose Git directory was named `.git\nmetadata`
  had that directory saved into its checkpoint. In a new checkout using the
  same name, the guard passed, and a saved file then replaced the Git
  directory. A CRLF `.git` file and a Git directory whose name ended in a
  newline were also misread.
- **Cause.**
  - The helper printed paths one per line, so one name split into two.
  - `$(...)` drops trailing newlines.
  - `sed | head -n 1` stopped at the first line of the `.git` file, whereas
    Git reads all of it and strips only the trailing CR and LF characters.
  - The callers read the helper through `< <(...)`, which ignores its exit
    status, so a lookup that failed simply left a path out.
- **Rule.**
  - Print paths with a NUL after each one, and read them with
    `read -r -d ''`.
  - Capture a path as `$(cmd && printf x)`, then strip the `x` and the one
    newline the command added.
  - Parse a pointer file exactly the way its owner does.
  - Write the list to a file and check the helper's status before anything
    changes.
  - Keep `$'...'` patterns out of double quotes. Inside them they only work
    because of bash's `extquote` default.
- **Encoded in.** The tests in `apps/control-plane/src/cloud/checkpoint.test.ts`:
  - the named own-Git-directory cases;
  - "reads the old checkout's .git file as Git does";
  - "fails instead of guessing when it cannot list the checkout's own Git
    directories".
