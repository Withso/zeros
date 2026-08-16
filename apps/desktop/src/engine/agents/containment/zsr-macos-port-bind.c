// Zeros Sandbox Runtime macOS compatibility interposer.
//
// A Seatbelt profile is immutable once sandbox-exec starts. Development tools,
// however, commonly ask bind(2) for port zero or for an arbitrary configured
// port that was unknowable at admission. The trusted engine admits a random,
// generation-private high-port pool in the kernel profile and injects this
// library only after Seatbelt is active. TCP binds are translated into that
// exact pool; loopback connects to explicit virtual ports use a small shared
// map under the session scratch directory. Removing or bypassing the library
// cannot widen authority: the kernel then rejects every unadmitted bind.
//
// The same post-Seatbelt image redirects absolute invocations of the admitted
// Git binary through Zeros' cwd-aware shadow-Git dispatcher. This preserves
// multi-repository behavior for tools that bypass PATH. The private Git client
// sets a one-hop bypass when it deliberately invokes the real binary with the
// already-selected repository environment. Bypassing interposition never
// grants canonical Git access because Seatbelt still denies those paths.

#define _DARWIN_C_SOURCE 1

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <pthread.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#define ZSR_MAX_PORTS 256
#define ZSR_MAP_BYTES (32 * 1024)

typedef int (*zsr_bind_fn)(int, const struct sockaddr *, socklen_t);
typedef int (*zsr_connect_fn)(int, const struct sockaddr *, socklen_t);
typedef int (*zsr_exec_fn)(const char *, char *const[]);
typedef int (*zsr_execve_fn)(const char *, char *const[], char *const[]);
typedef int (*zsr_posix_spawn_fn)(pid_t *, const char *,
                                  const posix_spawn_file_actions_t *,
                                  const posix_spawnattr_t *, char *const[],
                                  char *const[]);

extern char **environ;

static pthread_once_t zsr_once = PTHREAD_ONCE_INIT;
static zsr_bind_fn zsr_real_bind = NULL;
static zsr_connect_fn zsr_real_connect = NULL;
static zsr_exec_fn zsr_real_execv = NULL;
static zsr_exec_fn zsr_real_execvp = NULL;
static zsr_execve_fn zsr_real_execve = NULL;
static zsr_posix_spawn_fn zsr_real_posix_spawn = NULL;
static zsr_posix_spawn_fn zsr_real_posix_spawnp = NULL;
static uint16_t zsr_pool[ZSR_MAX_PORTS];
static size_t zsr_pool_count = 0;
static uint16_t zsr_passthrough[ZSR_MAX_PORTS];
static size_t zsr_passthrough_count = 0;
static uint16_t zsr_denied[ZSR_MAX_PORTS];
static size_t zsr_denied_count = 0;
static char zsr_map_path[PATH_MAX];
static char zsr_git_dispatcher[PATH_MAX];
static char zsr_git_binary[PATH_MAX];
static bool zsr_port_configuration_valid = false;
static bool zsr_git_configuration_valid = false;
static _Atomic uint32_t zsr_ephemeral_cursor = 0;

static bool zsr_parse_ports(const char *text, uint16_t *output,
                            size_t *output_count, bool require_nonempty) {
  if (text == NULL || *text == '\0') {
    *output_count = 0;
    return !require_nonempty;
  }
  size_t count = 0;
  const char *cursor = text;
  unsigned long previous = 0;
  while (*cursor != '\0') {
    if (count >= ZSR_MAX_PORTS || *cursor < '0' || *cursor > '9') return false;
    char *end = NULL;
    errno = 0;
    unsigned long value = strtoul(cursor, &end, 10);
    if (errno != 0 || end == cursor || value < 1 || value > 65535 ||
        (count > 0 && value <= previous)) {
      return false;
    }
    output[count++] = (uint16_t)value;
    previous = value;
    if (*end == '\0') break;
    if (*end != ',') return false;
    cursor = end + 1;
    if (*cursor == '\0') return false;
  }
  *output_count = count;
  return !require_nonempty || count > 0;
}

static void zsr_initialize(void) {
  // References originating in the interposing image remain bound to the
  // original libSystem definitions; dyld rewrites dependent images only.
  zsr_real_bind = bind;
  zsr_real_connect = connect;
  zsr_real_execv = execv;
  zsr_real_execvp = execvp;
  zsr_real_execve = execve;
  zsr_real_posix_spawn = posix_spawn;
  zsr_real_posix_spawnp = posix_spawnp;

  const char *git_dispatcher = getenv("ZEROS_ZSR_MACOS_GIT_DISPATCHER");
  const char *git_binary = getenv("ZEROS_ZSR_MACOS_GIT_BINARY");
  if (git_dispatcher != NULL && git_binary != NULL &&
      git_dispatcher[0] == '/' && git_binary[0] == '/' &&
      strchr(git_dispatcher, '\n') == NULL &&
      strchr(git_binary, '\n') == NULL &&
      strlen(git_dispatcher) < sizeof(zsr_git_dispatcher) &&
      strlen(git_binary) < sizeof(zsr_git_binary)) {
    memcpy(zsr_git_dispatcher, git_dispatcher, strlen(git_dispatcher) + 1);
    memcpy(zsr_git_binary, git_binary, strlen(git_binary) + 1);
    zsr_git_configuration_valid = true;
  }

  const char *map_path = getenv("ZEROS_ZSR_MACOS_PORT_MAP");
  if (zsr_real_bind == NULL || zsr_real_connect == NULL || map_path == NULL ||
      map_path[0] != '/' || strchr(map_path, '\n') != NULL ||
      strlen(map_path) >= sizeof(zsr_map_path) ||
      !zsr_parse_ports(getenv("ZEROS_ZSR_MACOS_BIND_PORTS"), zsr_pool,
                       &zsr_pool_count, true) ||
      !zsr_parse_ports(getenv("ZEROS_ZSR_MACOS_PASSTHROUGH_PORTS"),
                       zsr_passthrough, &zsr_passthrough_count, false) ||
      !zsr_parse_ports(getenv("ZEROS_ZSR_MACOS_DENIED_PORTS"), zsr_denied,
                       &zsr_denied_count, false)) {
    return;
  }
  memcpy(zsr_map_path, map_path, strlen(map_path) + 1);
  zsr_port_configuration_valid = true;
}

__attribute__((constructor)) static void zsr_initialize_at_load(void) {
  pthread_once(&zsr_once, zsr_initialize);
}

static bool zsr_git_bypass(char *const environment[]) {
  if (environment == NULL) return false;
  const char bypass[] = "ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS=1";
  for (size_t index = 0; environment[index] != NULL; index++) {
    if (strcmp(environment[index], bypass) == 0) return true;
  }
  return false;
}

static const char *zsr_git_program(const char *program,
                                   char *const environment[]) {
  if (!zsr_git_configuration_valid || program == NULL ||
      zsr_git_bypass(environment)) {
    return program;
  }
  if (strcmp(program, "git") == 0 || strcmp(program, zsr_git_binary) == 0) {
    return zsr_git_dispatcher;
  }
  if (strchr(program, '/') != NULL) {
    char resolved[PATH_MAX];
    if (realpath(program, resolved) != NULL &&
        strcmp(resolved, zsr_git_binary) == 0) {
      return zsr_git_dispatcher;
    }
  }
  return program;
}

static bool zsr_contains(const uint16_t *ports, size_t count, uint16_t port) {
  size_t low = 0;
  size_t high = count;
  while (low < high) {
    size_t middle = low + (high - low) / 2;
    if (ports[middle] == port) return true;
    if (ports[middle] < port)
      low = middle + 1;
    else
      high = middle;
  }
  return false;
}

static bool zsr_stream_socket(int descriptor) {
  int type = 0;
  socklen_t length = sizeof(type);
  return getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &length) == 0 &&
         type == SOCK_STREAM;
}

static bool zsr_port(const struct sockaddr *address, socklen_t length,
                     uint16_t *port) {
  if (address == NULL) return false;
  if (address->sa_family == AF_INET && length >= sizeof(struct sockaddr_in)) {
    *port = ntohs(((const struct sockaddr_in *)address)->sin_port);
    return true;
  }
  if (address->sa_family == AF_INET6 &&
      length >= sizeof(struct sockaddr_in6)) {
    *port = ntohs(((const struct sockaddr_in6 *)address)->sin6_port);
    return true;
  }
  return false;
}

static bool zsr_loopback(const struct sockaddr *address, socklen_t length) {
  if (address == NULL) return false;
  if (address->sa_family == AF_INET && length >= sizeof(struct sockaddr_in)) {
    uint32_t host = ntohl(((const struct sockaddr_in *)address)->sin_addr.s_addr);
    return (host & 0xff000000U) == 0x7f000000U;
  }
  if (address->sa_family == AF_INET6 &&
      length >= sizeof(struct sockaddr_in6)) {
    const struct in6_addr *host =
        &((const struct sockaddr_in6 *)address)->sin6_addr;
    if (IN6_IS_ADDR_LOOPBACK(host)) return true;
    const unsigned char *bytes = host->s6_addr;
    return IN6_IS_ADDR_V4MAPPED(host) && bytes[12] == 127;
  }
  return false;
}

static void zsr_with_port(const struct sockaddr *source, socklen_t length,
                          uint16_t port, struct sockaddr_storage *storage) {
  memset(storage, 0, sizeof(*storage));
  memcpy(storage, source, length);
  if (source->sa_family == AF_INET)
    ((struct sockaddr_in *)storage)->sin_port = htons(port);
  else
    ((struct sockaddr_in6 *)storage)->sin6_port = htons(port);
}

static int zsr_open_map(void) {
  int descriptor =
      open(zsr_map_path,
           O_RDWR | O_APPEND | O_CREAT | O_CLOEXEC,
           S_IRUSR | S_IWUSR);
  if (descriptor < 0) return -1;
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
      metadata.st_uid != getuid() || metadata.st_nlink != 1 ||
      (metadata.st_mode & (S_IRWXG | S_IRWXO)) != 0) {
    close(descriptor);
    errno = EACCES;
    return -1;
  }
  return descriptor;
}

static ssize_t zsr_read_map(int descriptor, char *buffer, size_t capacity) {
  if (lseek(descriptor, 0, SEEK_SET) < 0) return -1;
  ssize_t total = 0;
  while ((size_t)total < capacity - 1) {
    ssize_t count = read(descriptor, buffer + total, capacity - 1 - total);
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    total += count;
  }
  if ((size_t)total == capacity - 1) {
    errno = EFBIG;
    return -1;
  }
  buffer[total] = '\0';
  return total;
}

// -1 means malformed, 0 means valid with no mapping, 1 means found.
static int zsr_parse_map(const char *buffer, uint16_t requested,
                         uint16_t *actual, bool used[ZSR_MAX_PORTS]) {
  const char *cursor = buffer;
  bool found = false;
  while (*cursor != '\0') {
    char *request_end = NULL;
    char *actual_end = NULL;
    errno = 0;
    unsigned long request_value = strtoul(cursor, &request_end, 10);
    if (errno != 0 || request_end == cursor || *request_end != ' ') return -1;
    unsigned long actual_value = strtoul(request_end + 1, &actual_end, 10);
    if (errno != 0 || actual_end == request_end + 1 || *actual_end != '\n' ||
        request_value < 1 || request_value > 65535 || actual_value < 1 ||
        actual_value > 65535 ||
        !zsr_contains(zsr_pool, zsr_pool_count, (uint16_t)actual_value)) {
      return -1;
    }
    for (size_t index = 0; index < zsr_pool_count; index++) {
      if (zsr_pool[index] == (uint16_t)actual_value) used[index] = true;
    }
    if ((uint16_t)request_value == requested) {
      if (found && *actual != (uint16_t)actual_value) return -1;
      *actual = (uint16_t)actual_value;
      found = true;
    }
    cursor = actual_end + 1;
  }
  return found ? 1 : 0;
}

static int zsr_bind_ephemeral(int descriptor, const struct sockaddr *address,
                              socklen_t length) {
  uint32_t start = atomic_fetch_add_explicit(&zsr_ephemeral_cursor, 1,
                                              memory_order_relaxed);
  int last_error = EADDRINUSE;
  for (size_t offset = 0; offset < zsr_pool_count; offset++) {
    uint16_t candidate = zsr_pool[(start + offset) % zsr_pool_count];
    struct sockaddr_storage translated;
    zsr_with_port(address, length, candidate, &translated);
    if (zsr_real_bind(descriptor, (const struct sockaddr *)&translated, length) ==
        0) {
      return 0;
    }
    last_error = errno;
    if (errno != EADDRINUSE) break;
  }
  errno = last_error;
  return -1;
}

static int zsr_bind_virtual(int descriptor, const struct sockaddr *address,
                            socklen_t length, uint16_t requested) {
  int map = zsr_open_map();
  if (map < 0) return -1;
  char buffer[ZSR_MAP_BYTES];
  bool used[ZSR_MAX_PORTS] = {false};
  uint16_t actual = 0;
  ssize_t map_bytes = zsr_read_map(map, buffer, sizeof(buffer));
  if (map_bytes < 0) {
    int saved = errno;
    close(map);
    errno = saved;
    return -1;
  }
  int mapping_state = zsr_parse_map(buffer, requested, &actual, used);
  if (mapping_state < 0) {
    close(map);
    errno = EACCES;
    return -1;
  }
  if (mapping_state > 0) {
    struct sockaddr_storage translated;
    zsr_with_port(address, length, actual, &translated);
    int result =
        zsr_real_bind(descriptor, (const struct sockaddr *)&translated, length);
    int saved = errno;
    close(map);
    errno = saved;
    return result;
  }
  size_t start = ((uint32_t)requested * 2654435761U) % zsr_pool_count;
  int result = -1;
  int saved = EADDRINUSE;
  for (size_t offset = 0; offset < zsr_pool_count; offset++) {
    size_t index = (start + offset) % zsr_pool_count;
    if (used[index]) continue;
    actual = zsr_pool[index];
    struct sockaddr_storage translated;
    zsr_with_port(address, length, actual, &translated);
    result =
        zsr_real_bind(descriptor, (const struct sockaddr *)&translated, length);
    saved = errno;
    if (result == 0) {
      char line[32];
      int line_bytes = snprintf(line, sizeof(line), "%u %u\n", requested, actual);
      if (line_bytes > 0 && (size_t)line_bytes < sizeof(line) &&
          lseek(map, 0, SEEK_END) >= 0) {
        // One short append keeps each mapping record indivisible across
        // cooperating descendants. Kernel bind collision handling remains the
        // authority even if an untrusted process races or corrupts this map.
        (void)write(map, line, (size_t)line_bytes);
      }
      break;
    }
    if (saved != EADDRINUSE) break;
  }
  close(map);
  errno = saved;
  return result;
}

static int zsr_interposed_bind(int descriptor, const struct sockaddr *address,
                               socklen_t length) {
  pthread_once(&zsr_once, zsr_initialize);
  if (zsr_real_bind == NULL || !zsr_port_configuration_valid ||
      !zsr_stream_socket(descriptor)) {
    if (zsr_real_bind != NULL) return zsr_real_bind(descriptor, address, length);
    errno = ENOSYS;
    return -1;
  }
  uint16_t requested = 0;
  if (!zsr_port(address, length, &requested))
    return zsr_real_bind(descriptor, address, length);
  if (requested == 0) return zsr_bind_ephemeral(descriptor, address, length);
  if (zsr_contains(zsr_denied, zsr_denied_count, requested) || requested < 1024 ||
      zsr_contains(zsr_passthrough, zsr_passthrough_count, requested)) {
    errno = EACCES;
    return -1;
  }
  if (zsr_contains(zsr_pool, zsr_pool_count, requested))
    return zsr_real_bind(descriptor, address, length);
  return zsr_bind_virtual(descriptor, address, length, requested);
}

static int zsr_interposed_connect(int descriptor,
                                  const struct sockaddr *address,
                                  socklen_t length) {
  pthread_once(&zsr_once, zsr_initialize);
  if (zsr_real_connect == NULL || !zsr_port_configuration_valid ||
      !zsr_stream_socket(descriptor)) {
    if (zsr_real_connect != NULL)
      return zsr_real_connect(descriptor, address, length);
    errno = ENOSYS;
    return -1;
  }
  uint16_t requested = 0;
  if (!zsr_port(address, length, &requested) || requested == 0 ||
      !zsr_loopback(address, length)) {
    return zsr_real_connect(descriptor, address, length);
  }
  if (zsr_contains(zsr_denied, zsr_denied_count, requested)) {
    errno = EACCES;
    return -1;
  }
  if (zsr_contains(zsr_passthrough, zsr_passthrough_count, requested) ||
      zsr_contains(zsr_pool, zsr_pool_count, requested)) {
    return zsr_real_connect(descriptor, address, length);
  }
  int map = zsr_open_map();
  if (map < 0) return zsr_real_connect(descriptor, address, length);
  char buffer[ZSR_MAP_BYTES];
  bool used[ZSR_MAX_PORTS] = {false};
  uint16_t actual = 0;
  ssize_t map_bytes = zsr_read_map(map, buffer, sizeof(buffer));
  int mapping_state =
      map_bytes >= 0 ? zsr_parse_map(buffer, requested, &actual, used) : -1;
  close(map);
  if (mapping_state <= 0)
    return zsr_real_connect(descriptor, address, length);
  struct sockaddr_storage translated;
  zsr_with_port(address, length, actual, &translated);
  return zsr_real_connect(descriptor, (const struct sockaddr *)&translated,
                          length);
}

static int zsr_interposed_execv(const char *program, char *const arguments[]) {
  pthread_once(&zsr_once, zsr_initialize);
  if (zsr_real_execv == NULL) {
    errno = ENOSYS;
    return -1;
  }
  return zsr_real_execv(zsr_git_program(program, environ), arguments);
}

static int zsr_interposed_execvp(const char *program, char *const arguments[]) {
  pthread_once(&zsr_once, zsr_initialize);
  if (zsr_real_execvp == NULL) {
    errno = ENOSYS;
    return -1;
  }
  return zsr_real_execvp(zsr_git_program(program, environ), arguments);
}

static int zsr_interposed_execve(const char *program, char *const arguments[],
                                 char *const environment[]) {
  pthread_once(&zsr_once, zsr_initialize);
  if (zsr_real_execve == NULL) {
    errno = ENOSYS;
    return -1;
  }
  return zsr_real_execve(zsr_git_program(program, environment), arguments,
                         environment);
}

static int zsr_interposed_posix_spawn(
    pid_t *pid, const char *program,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attributes, char *const arguments[],
    char *const environment[]) {
  pthread_once(&zsr_once, zsr_initialize);
  if (zsr_real_posix_spawn == NULL) return ENOSYS;
  return zsr_real_posix_spawn(pid, zsr_git_program(program, environment),
                              file_actions, attributes, arguments, environment);
}

static int zsr_interposed_posix_spawnp(
    pid_t *pid, const char *program,
    const posix_spawn_file_actions_t *file_actions,
    const posix_spawnattr_t *attributes, char *const arguments[],
    char *const environment[]) {
  pthread_once(&zsr_once, zsr_initialize);
  if (zsr_real_posix_spawnp == NULL) return ENOSYS;
  return zsr_real_posix_spawnp(pid, zsr_git_program(program, environment),
                               file_actions, attributes, arguments,
                               environment);
}

// Exported symbol replacement is insufficient with modern dyld chained
// fixups/two-level namespaces. The __interpose section asks dyld to rewrite
// every image's bind/connect fixup to these replacements while retaining the
// original libSystem symbols for calls originating in this image.
#define ZSR_DYLD_INTERPOSE(replacement, replacee)                           \
  __attribute__((used)) static struct {                                    \
    const void *replacement_address;                                       \
    const void *replacee_address;                                           \
  } zsr_interpose_##replacee __attribute__((section("__DATA,__interpose"))) = { \
      (const void *)(uintptr_t)&replacement,                               \
      (const void *)(uintptr_t)&replacee,                                  \
  }

ZSR_DYLD_INTERPOSE(zsr_interposed_bind, bind);
ZSR_DYLD_INTERPOSE(zsr_interposed_connect, connect);
ZSR_DYLD_INTERPOSE(zsr_interposed_execv, execv);
ZSR_DYLD_INTERPOSE(zsr_interposed_execvp, execvp);
ZSR_DYLD_INTERPOSE(zsr_interposed_execve, execve);
ZSR_DYLD_INTERPOSE(zsr_interposed_posix_spawn, posix_spawn);
ZSR_DYLD_INTERPOSE(zsr_interposed_posix_spawnp, posix_spawnp);
