# Local CLI filesystem fixtures

- Symptom: CodeQL reported an insecure temporary file in the admission suite
  and three filesystem races in the launcher suite, despite passing Vitest.
- Cause: the admission fixture wrote beneath a fixed shared temporary path;
  the launcher assertions checked permissions by pathname, replaced the file,
  and reopened that pathname for each content assertion.
- Rule: create real filesystem fixtures under an owned `mkdtemp` directory and
  clean them up after every test. Open each launcher version with `O_NOFOLLOW`,
  validate its descriptor, and read its content through that same descriptor.
- Encoded in the Local orchestration admission and launcher suites, following
  the existing `zstack-review` file-check rule. CodeQL is the regression gate
  for these fixture patterns; passing behavioral tests alone does not establish
  that the scan is clean.
