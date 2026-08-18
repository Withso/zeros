// Zeros Sandbox Runtime shadow-Git dispatcher, compiled.
//
// Every Git invocation inside the fence is redirected here — by PATH, because
// this binary is installed as `<toolsRoot>/git`, and by the macOS interposer,
// which rewrites absolute invocations of the admitted Git binary to this path.
// The dispatcher picks the private repository that owns the caller's working
// directory and hands the command to that repository's client.
//
// It exists because the same decision used to be made by a Node program. That
// cost a full runtime start per Git command: measured inside a live boundary,
// an in-fence `git --version` with the redirect bypassed is 5-31 ms, and the
// identical command through the redirect chain is 835-947 ms cold and 107-152 ms
// warm — two runtime starts, one for that dispatch and one for the private
// client. This binary removes the first of them, and the `/bin/sh` exec that
// used to precede it, without changing what is dispatched or what enforces it.
//
// Deliberately narrow. It answers only the unambiguous case: one repository,
// no argument that redirects Git at a repository other than the one the working
// directory implies, and nothing nearer to the caller that looks like a
// repository of its own. Anything else — anything at all — is handed to the
// original Node dispatcher, unchanged, which remains the reference
// implementation. A dispatcher that guessed would be worse than a slow one:
// selecting the wrong private repository would hand a session another session's
// Git view, so every uncertain case is spent rather than resolved.
//
// Nothing here is a security boundary. Seatbelt still denies canonical Git paths
// whatever this chooses, the client this execs is still the only route to a
// remote, and the admission canary independently proves that Git inside the
// fence resolves to the expected private directory — so a mis-selection fails an
// admission rather than escaping one.

#define _DARWIN_C_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define ZSR_MAX_CONFIG_BYTES (256 * 1024)
#define ZSR_MAX_ENTRY_ENV 64
#define ZSR_MAX_ARGS 4096

extern char **environ;

struct zsr_pair {
  const char *name;
  const char *value;
};

struct zsr_config {
  const char *runtime;
  const char *dispatcher;
  const char *workspace_root;
  const char *tools_root;
  const char *client;
  const char *git;
  struct zsr_pair env[ZSR_MAX_ENTRY_ENV];
  size_t env_count;
  size_t entry_count;
  bool overflowed;
  bool valid;
};

/** Every name the Node dispatcher removes before applying the entry's own
 *  environment. Kept in the same order as `mappedEnvironment` so the two can be
 *  read side by side. */
static const char *const ZSR_DROP_EXACT[] = {
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EXEC_PATH",
    "GIT_PROXY_COMMAND",
    "SSH_ASKPASS",
    "ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS",
};

static const char *const ZSR_DROP_PREFIX[] = {
    "GIT_CONFIG",
    "ZEROS_GIT_AUTH_",
    "ZEROS_REAL_GIT",
    "ZEROS_REAL_GH",
};

static bool zsr_absolute(const char *value) {
  return value != NULL && value[0] == '/';
}

/** `candidate` is `root` or lies beneath it. Compared on whole path segments so
 *  `/a/bc` is never treated as living inside `/a/b`. */
static bool zsr_inside(const char *candidate, const char *root) {
  size_t root_length = strlen(root);
  while (root_length > 1 && root[root_length - 1] == '/') root_length--;
  if (strncmp(candidate, root, root_length) != 0) return false;
  return candidate[root_length] == '\0' || candidate[root_length] == '/';
}

static void zsr_strip_trailing_slashes(char *value) {
  size_t length = strlen(value);
  while (length > 1 && value[length - 1] == '/') value[--length] = '\0';
}

/** Resolve `target` against `base` and canonicalize it, falling back to the
 *  lexical result when the path does not exist — the same tolerance the Node
 *  dispatcher's `lexicalOrPhysical` applies. */
static bool zsr_resolve(const char *base, const char *target, char *output,
                        size_t output_size) {
  char joined[PATH_MAX];
  if (target == NULL || target[0] == '\0') {
    if (strlen(base) >= sizeof(joined)) return false;
    snprintf(joined, sizeof(joined), "%s", base);
  } else if (target[0] == '/') {
    if (strlen(target) >= sizeof(joined)) return false;
    snprintf(joined, sizeof(joined), "%s", target);
  } else {
    if (strlen(base) + 1 + strlen(target) >= sizeof(joined)) return false;
    snprintf(joined, sizeof(joined), "%s/%s", base, target);
  }
  char resolved[PATH_MAX];
  const char *chosen = realpath(joined, resolved) != NULL ? resolved : joined;
  if (strlen(chosen) >= output_size) return false;
  snprintf(output, output_size, "%s", chosen);
  zsr_strip_trailing_slashes(output);
  return true;
}

static char *zsr_read_file(const char *path, size_t *length_out) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) return NULL;
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
      metadata.st_size <= 0 ||
      (unsigned long long)metadata.st_size > ZSR_MAX_CONFIG_BYTES) {
    close(descriptor);
    return NULL;
  }
  size_t size = (size_t)metadata.st_size;
  char *buffer = malloc(size + 1);
  if (buffer == NULL) {
    close(descriptor);
    return NULL;
  }
  size_t filled = 0;
  while (filled < size) {
    ssize_t chunk = read(descriptor, buffer + filled, size - filled);
    if (chunk <= 0) {
      free(buffer);
      close(descriptor);
      return NULL;
    }
    filled += (size_t)chunk;
  }
  close(descriptor);
  buffer[size] = '\0';
  *length_out = size;
  return buffer;
}

/** The engine writes one `key value` per line and guarantees no value contains a
 *  newline, so the format needs no escaping and no parser. A second `entry`
 *  line makes the configuration ineligible rather than ambiguous. */
static void zsr_parse_config(char *text, struct zsr_config *config) {
  char *cursor = text;
  bool version_seen = false;
  while (cursor != NULL && *cursor != '\0') {
    char *line = cursor;
    char *newline = strchr(cursor, '\n');
    if (newline != NULL) {
      *newline = '\0';
      cursor = newline + 1;
    } else {
      cursor = NULL;
    }
    if (*line == '\0') continue;
    char *space = strchr(line, ' ');
    const char *value = "";
    if (space != NULL) {
      *space = '\0';
      value = space + 1;
    }
    if (strcmp(line, "v1") == 0) {
      version_seen = true;
    } else if (strcmp(line, "runtime") == 0) {
      config->runtime = value;
    } else if (strcmp(line, "dispatcher") == 0) {
      config->dispatcher = value;
    } else if (strcmp(line, "entry") == 0) {
      config->entry_count++;
    } else if (strcmp(line, "workspaceRoot") == 0) {
      config->workspace_root = value;
    } else if (strcmp(line, "toolsRoot") == 0) {
      config->tools_root = value;
    } else if (strcmp(line, "client") == 0) {
      config->client = value;
    } else if (strcmp(line, "git") == 0) {
      config->git = value;
    } else if (strcmp(line, "env") == 0) {
      char *equals = strchr((char *)value, '=');
      if (equals == NULL || config->env_count >= ZSR_MAX_ENTRY_ENV) {
        // A pair this cannot hold would mean running the entry's Git with a
        // partial environment, which is worse than running it slowly.
        config->overflowed = true;
        continue;
      }
      *equals = '\0';
      config->env[config->env_count].name = value;
      config->env[config->env_count].value = equals + 1;
      config->env_count++;
    }
  }
  config->valid = version_seen && !config->overflowed &&
                  config->entry_count == 1 &&
                  zsr_absolute(config->runtime) &&
                  zsr_absolute(config->dispatcher) &&
                  zsr_absolute(config->workspace_root) &&
                  zsr_absolute(config->tools_root) &&
                  zsr_absolute(config->client) && zsr_absolute(config->git);
}

/** True when the argument list contains nothing that could point Git at a
 *  repository other than the one the working directory implies. `-C` is
 *  understood rather than refused, because it is how tools address a workspace
 *  and refusing it would leave the common case on the slow path.
 *
 *  `cwd` is advanced by each `-C`, and the consumed arguments are dropped from
 *  `output` — the dispatcher this replaces did exactly that, then ran the client
 *  in the resulting directory. */
static bool zsr_simple_arguments(char *const argv[], char *cwd, size_t cwd_size,
                                 const char **output, size_t *output_count) {
  bool command_seen = false;
  size_t count = 0;
  output[count++] = argv[0];
  for (size_t index = 1; argv[index] != NULL; index++) {
    const char *value = argv[index];
    if (count + 2 >= ZSR_MAX_ARGS) return false;
    if (command_seen) {
      output[count++] = value;
      continue;
    }
    if (strcmp(value, "--") == 0) return false;
    if (strcmp(value, "-C") == 0) {
      const char *target = argv[index + 1];
      if (target == NULL) return false;
      if (!zsr_resolve(cwd, target, cwd, cwd_size)) return false;
      index++;
      continue;
    }
    if (strncmp(value, "-C", 2) == 0 && value[2] != '\0') {
      if (!zsr_resolve(cwd, value + 2, cwd, cwd_size)) return false;
      continue;
    }
    if (strcmp(value, "--git-dir") == 0 || strcmp(value, "--work-tree") == 0 ||
        strncmp(value, "--git-dir=", 10) == 0 ||
        strncmp(value, "--work-tree=", 12) == 0) {
      return false;
    }
    if (strcmp(value, "-c") == 0 || strcmp(value, "--config-env") == 0 ||
        strcmp(value, "--namespace") == 0 ||
        strcmp(value, "--super-prefix") == 0 ||
        strcmp(value, "--exec-path") == 0) {
      const char *argument = argv[index + 1];
      if (argument == NULL) return false;
      output[count++] = value;
      output[count++] = argument;
      index++;
      continue;
    }
    output[count++] = value;
    if (value[0] != '-') command_seen = true;
  }
  output[count] = NULL;
  *output_count = count;
  return true;
}

static bool zsr_dropped(const char *entry) {
  size_t name_length = (size_t)(strchr(entry, '=') - entry);
  for (size_t index = 0;
       index < sizeof(ZSR_DROP_EXACT) / sizeof(ZSR_DROP_EXACT[0]); index++) {
    const char *name = ZSR_DROP_EXACT[index];
    if (strlen(name) == name_length && strncmp(entry, name, name_length) == 0) {
      return true;
    }
  }
  for (size_t index = 0;
       index < sizeof(ZSR_DROP_PREFIX) / sizeof(ZSR_DROP_PREFIX[0]); index++) {
    const char *prefix = ZSR_DROP_PREFIX[index];
    size_t prefix_length = strlen(prefix);
    if (name_length >= prefix_length &&
        strncmp(entry, prefix, prefix_length) == 0) {
      return true;
    }
  }
  return false;
}

/** The caller's environment with the repository-selecting names removed, the
 *  entry's own environment applied, and `PATH` prefixed with the entry's tools
 *  directory — the three steps `mappedEnvironment` performs, in that order. */
static char **zsr_mapped_environment(const struct zsr_config *config) {
  size_t inherited = 0;
  while (environ[inherited] != NULL) inherited++;
  size_t capacity = inherited + config->env_count + 4;
  char **result = calloc(capacity, sizeof(char *));
  if (result == NULL) return NULL;
  size_t count = 0;
  const char *inherited_path = NULL;
  for (size_t index = 0; index < inherited; index++) {
    char *entry = environ[index];
    if (strchr(entry, '=') == NULL || zsr_dropped(entry)) continue;
    if (strncmp(entry, "PATH=", 5) == 0) {
      inherited_path = entry + 5;
      continue;
    }
    bool overridden = false;
    for (size_t pair = 0; pair < config->env_count; pair++) {
      size_t name_length = strlen(config->env[pair].name);
      if (strncmp(entry, config->env[pair].name, name_length) == 0 &&
          entry[name_length] == '=') {
        overridden = true;
        break;
      }
    }
    if (!overridden) result[count++] = entry;
  }
  for (size_t pair = 0; pair < config->env_count; pair++) {
    const char *name = config->env[pair].name;
    const char *value = config->env[pair].value;
    size_t size = strlen(name) + strlen(value) + 2;
    char *rendered = malloc(size);
    if (rendered == NULL) return NULL;
    snprintf(rendered, size, "%s=%s", name, value);
    result[count++] = rendered;
  }
  const char *tail = inherited_path != NULL ? inherited_path
                                            : "/usr/local/bin:/usr/bin:/bin";
  size_t path_size = strlen("PATH=") + strlen(config->tools_root) + 1 +
                     strlen(tail) + 1;
  char *path_entry = malloc(path_size);
  if (path_entry == NULL) return NULL;
  snprintf(path_entry, path_size, "PATH=%s:%s", config->tools_root, tail);
  result[count++] = path_entry;
  result[count] = NULL;
  return result;
}

/** The operations `git-client.mjs` sends to the broker rather than running
 *  natively. Only `push`, `fetch` and `pull` are network operations — the other
 *  twelve are here because they can destroy or rewrite protected Design
 *  directories, so this list is the Design fence's enforcement path and not a
 *  credential one. It is copied from the client verbatim and must stay that way:
 *  a shorter list here would run one of those unbrokered. */
static const char *const ZSR_BROKERED[] = {
    "push",   "fetch",  "pull",       "checkout", "switch",
    "reset",  "restore", "clean",     "merge",    "rebase",
    "cherry-pick", "revert", "stash", "rm",       "mv",
};

/** `git-client.mjs`'s `subcommand()`, argument for argument. Returns NULL where
 *  it returns null, which the caller reads as "not brokered". */
static const char *zsr_subcommand(char *const argv[]) {
  static const char *const takes_value[] = {
      "-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
      "--config-env",
  };
  static const char *const prefixes[] = {
      "--git-dir=", "--work-tree=", "--namespace=", "--super-prefix=",
      "--config-env=",
  };
  for (size_t index = 1; argv[index] != NULL; index++) {
    const char *value = argv[index];
    if (strcmp(value, "--help") == 0 || strcmp(value, "-h") == 0 ||
        strcmp(value, "--version") == 0) {
      return NULL;
    }
    if (strcmp(value, "--") == 0) return argv[index + 1];
    bool consumed = false;
    for (size_t option = 0;
         option < sizeof(takes_value) / sizeof(takes_value[0]); option++) {
      if (strcmp(value, takes_value[option]) == 0) {
        index++;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;
    bool prefixed = false;
    for (size_t option = 0; option < sizeof(prefixes) / sizeof(prefixes[0]);
         option++) {
      if (strncmp(value, prefixes[option], strlen(prefixes[option])) == 0) {
        prefixed = true;
        break;
      }
    }
    if (prefixed) continue;
    if (strncmp(value, "-c", 2) == 0 && strcmp(value, "-c") != 0) continue;
    if (strncmp(value, "-C", 2) == 0 && strcmp(value, "-C") != 0) continue;
    if (value[0] == '-') continue;
    return value;
  }
  return NULL;
}

static bool zsr_brokered(const char *operation) {
  if (operation == NULL) return false;
  for (size_t index = 0;
       index < sizeof(ZSR_BROKERED) / sizeof(ZSR_BROKERED[0]); index++) {
    if (strcmp(operation, ZSR_BROKERED[index]) == 0) return true;
  }
  return false;
}

static bool zsr_help_requested(char *const argv[]) {
  for (size_t index = 1; argv[index] != NULL; index++) {
    if (strcmp(argv[index], "--help") == 0 || strcmp(argv[index], "-h") == 0) {
      return true;
    }
  }
  return false;
}

/** Whether `<cwd>/.git` is a regular file.
 *
 *  The client treats a regular `.git` whose target lies inside the private root
 *  as a linked worktree and drops the process-wide `GIT_DIR`/`GIT_INDEX_FILE`
 *  overrides for it. This does not reproduce that — it refuses to answer at all
 *  when the question could arise, and lets the client decide.
 *
 *  Measured, so the refusal is nearly free: a shadow projection leaves the
 *  primary workspace's `.git` a DIRECTORY on both platforms and redirects Git
 *  through `GIT_DIR` in the child environment instead, and a worktree the
 *  session creates lands outside the workspace root — so the fast path's own
 *  preconditions already exclude every linked worktree. This makes that an
 *  enforced condition rather than an argued one. */
static bool zsr_possible_linked_worktree(const char *cwd) {
  char candidate[PATH_MAX];
  if (strlen(cwd) + 6 >= sizeof(candidate)) return true;
  snprintf(candidate, sizeof(candidate), "%s/.git", cwd);
  struct stat metadata;
  if (lstat(candidate, &metadata) != 0) return false;
  return S_ISREG(metadata.st_mode);
}

/** Hand the command to the Node dispatcher exactly as it would have arrived
 *  there before this binary existed. Every path that is not provably simple ends
 *  here, so this is the common case's fallback and the whole correctness story
 *  for everything else. */
static int zsr_delegate(const struct zsr_config *config, char *const argv[]) {
  size_t count = 0;
  while (argv[count] != NULL) count++;
  if (count + 3 >= ZSR_MAX_ARGS) return 127;
  const char *forwarded[ZSR_MAX_ARGS];
  forwarded[0] = config->runtime;
  forwarded[1] = config->dispatcher;
  for (size_t index = 1; index < count; index++) forwarded[index + 1] = argv[index];
  forwarded[count + 1] = NULL;
  execv(config->runtime, (char *const *)forwarded);
  fprintf(stderr, "git: shadow dispatcher is unavailable: %s\n",
          strerror(errno));
  return 127;
}

/** Append or replace one `NAME=VALUE` entry. The array is grown by one, which is
 *  always available: `zsr_mapped_environment` reserves the slack. */
static bool zsr_environment_set(char ***environment, const char *entry) {
  const char *equals = strchr(entry, '=');
  if (equals == NULL) return false;
  size_t name_length = (size_t)(equals - entry);
  char **list = *environment;
  size_t count = 0;
  while (list[count] != NULL) {
    if (strncmp(list[count], entry, name_length) == 0 &&
        list[count][name_length] == '=') {
      list[count] = (char *)entry;
      return true;
    }
    count++;
  }
  list[count] = (char *)entry;
  list[count + 1] = NULL;
  return true;
}

static void zsr_environment_unset(char **environment, const char *name) {
  size_t name_length = strlen(name);
  size_t write = 0;
  for (size_t read = 0; environment[read] != NULL; read++) {
    if (strncmp(environment[read], name, name_length) == 0 &&
        environment[read][name_length] == '=') {
      continue;
    }
    environment[write++] = environment[read];
  }
  environment[write] = NULL;
}

/** Run the private client, which is what happens whenever this refuses to
 *  answer but the entry itself was unambiguous. */
static int zsr_exec_client(const struct zsr_config *config,
                           const char **forwarded, const char *cwd,
                           char *const argv[]) {
  char **mapped = zsr_mapped_environment(config);
  if (mapped == NULL || chdir(cwd) != 0) return zsr_delegate(config, argv);
  forwarded[0] = config->client;
  execve(config->client, (char *const *)forwarded, mapped);
  fprintf(stderr, "git: shadow client is unavailable: %s\n", strerror(errno));
  return 127;
}

/** Nothing between the caller and the workspace root may look like a repository
 *  of its own. The Node dispatcher stops at the first `.git` it meets walking
 *  upwards, so an ordinary nested repository owns its own directory; this
 *  refuses to answer at all when one is present rather than reproducing that
 *  rule. */
static bool zsr_no_nearer_repository(const char *cwd, const char *workspace) {
  char cursor[PATH_MAX];
  if (strlen(cwd) >= sizeof(cursor)) return false;
  snprintf(cursor, sizeof(cursor), "%s", cwd);
  while (strcmp(cursor, workspace) != 0) {
    char candidate[PATH_MAX];
    if (strlen(cursor) + 6 >= sizeof(candidate)) return false;
    snprintf(candidate, sizeof(candidate), "%s/.git", cursor);
    struct stat metadata;
    if (lstat(candidate, &metadata) == 0) return false;
    char *slash = strrchr(cursor, '/');
    if (slash == NULL || slash == cursor) return false;
    *slash = '\0';
  }
  return true;
}

int main(int argc, char *argv[]) {
  (void)argc;
  const char *config_path = getenv("ZEROS_ZSR_GIT_DISPATCH_CONFIG");
  struct zsr_config config;
  memset(&config, 0, sizeof(config));
  size_t length = 0;
  char *text = zsr_absolute(config_path) ? zsr_read_file(config_path, &length)
                                         : NULL;
  if (text == NULL) {
    fprintf(stderr, "git: shadow dispatcher configuration is unavailable\n");
    return 127;
  }
  zsr_parse_config(text, &config);
  if (!zsr_absolute(config.runtime) || !zsr_absolute(config.dispatcher)) {
    fprintf(stderr, "git: shadow dispatcher configuration is unusable\n");
    return 127;
  }
  if (!config.valid) return zsr_delegate(&config, argv);

  char cwd[PATH_MAX];
  if (getcwd(cwd, sizeof(cwd)) == NULL) return zsr_delegate(&config, argv);
  zsr_strip_trailing_slashes(cwd);
  if (!zsr_resolve(cwd, NULL, cwd, sizeof(cwd))) {
    return zsr_delegate(&config, argv);
  }
  // An ambient GIT_DIR the entry did not set is a deliberate redirection by the
  // caller, and resolving it is the Node dispatcher's job.
  const char *ambient = getenv("GIT_DIR");
  if (ambient != NULL) {
    bool from_entry = false;
    for (size_t pair = 0; pair < config.env_count; pair++) {
      if (strcmp(config.env[pair].name, "GIT_DIR") == 0 &&
          strcmp(config.env[pair].value, ambient) == 0) {
        from_entry = true;
        break;
      }
    }
    if (!from_entry) return zsr_delegate(&config, argv);
  }

  const char *forwarded[ZSR_MAX_ARGS];
  size_t forwarded_count = 0;
  if (!zsr_simple_arguments(argv, cwd, sizeof(cwd), forwarded,
                            &forwarded_count)) {
    return zsr_delegate(&config, argv);
  }
  if (!zsr_inside(cwd, config.workspace_root) ||
      !zsr_no_nearer_repository(cwd, config.workspace_root)) {
    return zsr_delegate(&config, argv);
  }
  // `git-client.mjs`'s own decision, reproduced rather than reinvented: it runs
  // the real Git natively for everything outside the brokered set, and the only
  // thing its runtime start buys for those is the decision itself. Deriving this
  // from whether an operation touches the network would be a different — and
  // wrong — split, because twelve of the fifteen brokered operations are there
  // to protect Design directories, not credentials.
  const char *operation = zsr_subcommand(argv);
  const bool native = !zsr_brokered(operation) || zsr_help_requested(argv);
  if (native && zsr_possible_linked_worktree(cwd)) {
    // The client would have to decide whether to drop the private overrides.
    return zsr_exec_client(&config, forwarded, cwd, argv);
  }
  char **mapped = zsr_mapped_environment(&config);
  if (mapped == NULL) return zsr_delegate(&config, argv);
  if (chdir(cwd) != 0) return zsr_delegate(&config, argv);
  if (!native) {
    forwarded[0] = config.client;
    execve(config.client, (char *const *)forwarded, mapped);
    fprintf(stderr, "git: shadow client is unavailable: %s\n", strerror(errno));
    return 127;
  }
  // What `runNative()` does: the admitted Git, the entry's environment, and the
  // one-hop bypass that stops the interposer sending this straight back here.
  if (!zsr_environment_set(&mapped, "ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS=1")) {
    return zsr_delegate(&config, argv);
  }
  if (operation != NULL && strcmp(operation, "worktree") == 0) {
    // `git worktree add` must build the new worktree's own index; leaving the
    // primary override in place produces a branch whose first commit can
    // silently omit paths that were never materialized in that index.
    zsr_environment_unset(mapped, "GIT_INDEX_FILE");
  }
  forwarded[0] = config.git;
  execve(config.git, (char *const *)forwarded, mapped);
  fprintf(stderr, "git: %s\n", strerror(errno));
  return 127;
}
