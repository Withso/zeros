/* Fixed transition from the host broker's already-restricted mount view.
 * Engine, agents, tools and capture are non-root UID/GID10003 with an exact
 * identity map. VM root and archived worker roles are NEVER mapped. The
 * locked mount namespace is completed before dropping all capabilities/IDs.
 * Not setuid. Namespace entry accepts no selected command, identity or map.
 * The host-only --await-launch entry blocks BEFORE bubblewrap can fork, then
 * invokes only /usr/bin/bwrap with the root launcher's fixed view arguments.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t child_pid;
static char runtime_root[128];
static char worker_root[144];
static char runtime_node[160];
static int runtime_version;
static char engine_scope[PATH_MAX];
static unsigned long long scope_dev, scope_ino;

static void fail(void) {
  fputs("cloud engine namespace admission failed\n", stderr);
  _exit(125);
}

static void forward_signal(int signal_number) {
  if (child_pid > 0) (void)kill((pid_t)child_pid, signal_number);
}

static void require_path(const char *name, int directory, int read_only) {
  struct stat metadata;
  struct statfs filesystem;
  char physical[PATH_MAX];
  if (!realpath(name, physical) || strcmp(physical, name) ||
      lstat(name, &metadata) || metadata.st_uid != 0 ||
      (metadata.st_mode & 0022) ||
      (directory ? !S_ISDIR(metadata.st_mode) :
       (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1)) ||
      statfs(name, &filesystem) ||
      (read_only && !(filesystem.f_flags & MS_RDONLY))) fail();
}

/* Only the root launcher supplies this ID. No caller-selected path, command,
 * environment root, or facade is accepted at the native transition. */
static void select_runtime(const char *id) {
  if (strlen(id) != 67 || strncmp(id, "r1-", 3)) fail();
  for (size_t i = 3; i < 67; i++)
    if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) fail();
  int length = snprintf(runtime_root, sizeof(runtime_root), "/opt/zeros-infra/%s", id);
  if (length <= 0 || (size_t)length >= sizeof(runtime_root)) fail();
  length = snprintf(worker_root, sizeof(worker_root), "%s/worker", runtime_root);
  if (length <= 0 || (size_t)length >= sizeof(worker_root)) fail();
  length = snprintf(runtime_node, sizeof(runtime_node), "%s/bin/node", runtime_root);
  if (length <= 0 || (size_t)length >= sizeof(runtime_node)) fail();
  runtime_version = 4;
}

static void select_engine_scope(const char *encoded) {
  const char *last = strrchr(encoded, ':');
  const char *separator = strrchr(encoded, '@');
  if (!last || !separator || separator > last || separator == encoded || (size_t)(separator - encoded) >= sizeof(engine_scope)) fail();
  memcpy(engine_scope, encoded, (size_t)(separator - encoded)); engine_scope[separator - encoded] = 0;
  const char *tree = strstr(engine_scope, "/engine-runtime/");
  const char *leaf = tree ? tree + strlen("/engine-runtime/") : NULL;
  const char *root_suffix = "/zeros-host.service";
  if (!tree || (size_t)(tree - engine_scope) < strlen(root_suffix) ||
      memcmp(tree - strlen(root_suffix), root_suffix, strlen(root_suffix)) || strncmp(engine_scope, "/sys/fs/cgroup/", 15)) fail();
  for (const char *cursor = engine_scope; cursor < tree; cursor++)
    if (!((*cursor >= 'a' && *cursor <= 'z') || (*cursor >= 'A' && *cursor <= 'Z') || (*cursor >= '0' && *cursor <= '9') || strchr("/_-.@", *cursor))) fail();
  if (strstr(engine_scope, "//") || strstr(engine_scope, "/../") || strstr(engine_scope, "/./")) fail();
  const char *id = !strncmp(leaf, "engine-workload-", 16) ? leaf + 16 : !strncmp(leaf, "engine-", 7) ? leaf + 7 : NULL;
  if (!id || strlen(id) != 36) fail();
  for (size_t index = 0; index < 36; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) { if (id[index] != '-') fail(); }
    else if (!((id[index] >= '0' && id[index] <= '9') || (id[index] >= 'a' && id[index] <= 'f'))) fail();
  }
  if (id[14] < '1' || id[14] > '8' || !strchr("89ab", id[19])) fail();
  char *end;
  errno = 0; scope_dev = strtoull(separator + 1, &end, 10);
  if (errno || end != last || separator + 1 == last || separator[1] == '+' || separator[1] == '-' ||
      (separator[1] == '0' && separator + 2 != last)) fail();
  errno = 0; scope_ino = strtoull(last + 1, &end, 10);
  if (errno || *end || !scope_ino || last[1] == '0' || last[1] == '+' || last[1] == '-') fail();
}

static void worker_path(char *output, size_t size, const char *relative) {
  int length = snprintf(output, size, "%s/%s", worker_root, relative);
  if (length <= 0 || (size_t)length >= size) fail();
}

static void require_worker_path(const char *relative, int directory) {
  char file[PATH_MAX];
  worker_path(file, sizeof(file), relative);
  require_path(file, directory, 1);
}

static void require_link(const char *file, const char *target) {
  struct stat metadata;
  char buffer[PATH_MAX];
  ssize_t size = readlink(file, buffer, sizeof(buffer));
  if (lstat(file, &metadata) || !S_ISLNK(metadata.st_mode) || metadata.st_uid != 0 ||
      size < 0 || (size_t)size != strlen(target) || memcmp(buffer, target, (size_t)size)) fail();
}

static void require_kernel_control(const char *name) {
  struct stat metadata;
  struct statfs filesystem;
  /* Outer-kernel ownership may be unmapped in a provider user namespace.
   * Neither VM root nor overflow UID 65534 is in our engine's fixed map.
   * Provider FUSE sysctls remain subject to the same full write-denial probes;
   * no regular filesystem, workload-owned inode or writable group is admitted. */
  if (lstat(name, &metadata) ||
      (metadata.st_uid != 0 && metadata.st_uid != 65534) ||
      !S_ISREG(metadata.st_mode) || metadata.st_nlink != 1 ||
      (metadata.st_mode & 0022) || statfs(name, &filesystem) ||
      (filesystem.f_type != 0x9fa0 && filesystem.f_type != 0x65735546)) fail();
}

static void validate_view(int qualification, int resident, int cursor_probe) {
  struct statfs root;
  if (statfs("/", &root) || root.f_type != 0x01021994 ||
      !(root.f_flags & MS_RDONLY)) fail();
  const char *directories[] = {
    "/", "/usr", "/opt", "/etc", "/etc/zeros", runtime_root, worker_root,
  };
  for (size_t i = 0; i < sizeof(directories) / sizeof(directories[0]); i++)
    require_path(directories[i], 1, 1);
  char bin[160];
  int length = snprintf(bin, sizeof(bin), "%s/bin", runtime_root);
  if (length <= 0 || (size_t)length >= sizeof(bin)) fail();
  require_path(bin, 1, 1);
  require_path(runtime_node, 0, 1);
  require_worker_path("dist-engine", 1);
  require_worker_path("dist-engine/cli.js", 0);
  if (resident) require_worker_path("dist-engine/resident-pty.js", 0);
  require_path("/etc/zeros/cloud-worker.json", 0, 1);
  if (runtime_version == 4) {
    require_path("/opt/zeros-infra", 1, 1);
    require_path("/opt/zeros", 1, 1);
    require_path("/run/zeros/active-runtime.json", 0, 1);
    char target[160];
    length = snprintf(target, sizeof(target), "../zeros-infra/%s", strrchr(runtime_root, '/') + 1);
    if (length <= 0 || (size_t)length >= sizeof(target)) fail();
    require_link("/opt/zeros/current", target);
    require_link("/zeros", "/opt/zeros");
    require_link("/opt/zeros/bin", "current/bin");
    require_link("/opt/zeros/worker", "current/worker");
    require_link("/opt/zeros/manifest.json", "current/manifest.json");
    require_link("/opt/zeros/logs", "/srv/zeros/log");
    require_link("/opt/zeros/state", "/srv/zeros/state");
  }
  /* Procfs must retain VM-root ownership, which becomes unmapped. Do not
   * overmount individual entries: that prevents fresh proc mounts in nested
   * PID namespaces. Global sysctl writes still require unmapped host authority. */
  struct statfs proc;
  if (statfs("/proc", &proc) || proc.f_type != 0x9fa0) fail();
  const char *controls[] = {
    "/proc/sys/kernel/modprobe", "/proc/sys/kernel/core_pattern",
    "/proc/sysrq-trigger", "/proc/sys/fs/file-max",
    "/proc/sys/net/ipv4/ip_forward",
  };
  for (size_t i = 0; i < sizeof(controls) / sizeof(controls[0]); i++)
    require_kernel_control(controls[i]);
  if (qualification) {
    require_worker_path("scripts", 1);
    require_worker_path("scripts/cloud-workspace-validation", 1);
    require_worker_path("scripts/cloud-workspace-validation/sandbox", 1);
    require_worker_path("scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs", 0);
  }
  if (cursor_probe) {
    char probe[PATH_MAX];
    if (snprintf(probe, sizeof(probe), "%s/lib/zeros/runtime-self-test.mjs", runtime_root) >= (int)sizeof(probe)) fail();
    require_path(probe, 0, 1);
  }
  const char *absent[] = {
    "/root", "/home/user", "/srv/zeros/broker", "/etc/shadow", "/etc/ssh",
    "/run/zeros/cloud-worker-supervisor.sock", "/run/zeros-privilege", "/srv/zeros/setup",
    "/opt/zeros-bootstrap", "/srv/zeros/runtime-installs",
  };
  for (size_t i = 0; i < sizeof(absent) / sizeof(absent[0]); i++) {
    struct stat metadata;
    if (!lstat(absent[i], &metadata) || errno != ENOENT) fail();
  }
}

static void byte_io(int descriptor, int writing) {
  struct pollfd event = { .fd = descriptor, .events = writing ? POLLOUT : POLLIN };
  int result;
  do { result = poll(&event, 1, 5000); } while (result < 0 && errno == EINTR);
  if (result != 1 || !(event.revents & event.events)) fail();
  char value = '1';
  ssize_t count;
  do {
    count = writing ? write(descriptor, &value, 1) : read(descriptor, &value, 1);
  } while (count < 0 && errno == EINTR);
  if (count != 1 || value != '1') fail();
}

static void write_map(pid_t child, const char *kind) {
  char file[96];
  int length = snprintf(file, sizeof(file), "/proc/%ld/%s_map", (long)child, kind);
  if (length <= 0 || (size_t)length >= sizeof(file)) fail();
  int descriptor = open(file, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  const char *mapping = "10003 10003 1\n";
  size_t length_bytes = strlen(mapping);
  if (descriptor < 0 || write(descriptor, mapping, length_bytes) !=
      (ssize_t)length_bytes || close(descriptor)) fail();
}

static void engine_status_line(const char *source, const char *key, char *value, size_t capacity) {
  if (strlen(source) > 65536) fail();
  const size_t length = strlen(key);
  int found = 0;
  for (const char *cursor = source; *cursor;) {
    const char *end = strchr(cursor, '\n');
    if (!end) end = cursor + strlen(cursor);
    if ((size_t)(end - cursor) > length && !memcmp(cursor, key, length) && cursor[length] == ':') {
      if (found++) fail();
      const char *start = cursor + length + 1;
      while (start < end && (*start == ' ' || *start == '\t')) start++;
      while (end > start && (end[-1] == ' ' || end[-1] == '\t')) end--;
      const size_t size = (size_t)(end - start);
      if (size >= capacity) fail();
      memcpy(value, start, size); value[size] = 0;
    }
    const char *next = strchr(cursor, '\n');
    if (!next) break;
    cursor = next + 1;
  }
  if (found != 1) fail();
}

/* The direct fork child remains blocked and unreaped throughout this check
 * and placement. No root PID or partially dropped child enters delegation. */
static void require_engine_child_status(const char *source) {
  char value[128];
  for (size_t index = 0; index < 2; index++) {
    unsigned long real, effective, saved, filesystem; char extra;
    engine_status_line(source, index ? "Gid" : "Uid", value, sizeof(value));
    if (sscanf(value, "%lu %lu %lu %lu %c", &real, &effective, &saved, &filesystem, &extra) != 4 ||
        real != 10003 || effective != 10003 || saved != 10003 || filesystem != 10003) fail();
  }
  const char *caps[] = {"CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"};
  for (size_t index = 0; index < sizeof(caps) / sizeof(caps[0]); index++) {
    engine_status_line(source, caps[index], value, sizeof(value));
    if (strcmp(value, "0000000000000000")) fail();
  }
  engine_status_line(source, "NoNewPrivs", value, sizeof(value));
  if (strcmp(value, "1")) fail();
  engine_status_line(source, "Seccomp", value, sizeof(value));
  if (strcmp(value, "2")) fail();
  engine_status_line(source, "State", value, sizeof(value));
  if (value[0] == 'Z' || value[0] == 'X' || !value[0]) fail();
}

static void verify_engine_child(pid_t child) {
  char file[96], source[65537];
  if (snprintf(file, sizeof(file), "/proc/%ld/status", (long)child) >= (int)sizeof(file)) fail();
  int descriptor = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct statfs filesystem;
  if (descriptor < 0 || fstatfs(descriptor, &filesystem) || filesystem.f_type != 0x9fa0) fail();
  size_t size = 0;
  while (size < sizeof(source) - 1) {
    ssize_t count = read(descriptor, source + size, sizeof(source) - 1 - size);
    if (count < 0) { if (errno == EINTR) continue; fail(); }
    if (!count) break;
    size += (size_t)count;
  }
  if (close(descriptor) || size == sizeof(source) - 1) fail();
  source[size] = 0;
  require_engine_child_status(source);
}

static void place_engine_child(pid_t child) {
  verify_engine_child(child);
  const int directory = open(engine_scope, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat metadata; struct statfs filesystem;
  if (directory < 0 || fstat(directory, &metadata) || fstatfs(directory, &filesystem) || filesystem.f_type != 0x63677270 ||
      metadata.st_uid != 10003 || metadata.st_gid != 10003 || (metadata.st_mode & 0022) ||
      (unsigned long long)metadata.st_dev != scope_dev || (unsigned long long)metadata.st_ino != scope_ino) fail();
  const int descriptor = openat(directory, "cgroup.procs", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0 || fstat(descriptor, &metadata) || fstatfs(descriptor, &filesystem) || filesystem.f_type != 0x63677270 ||
      !S_ISREG(metadata.st_mode) || metadata.st_uid != 10003 || (metadata.st_mode & 0022)) fail();
  char pid[32]; const int length = snprintf(pid, sizeof(pid), "%ld", (long)child);
  if (length <= 0 || length >= (int)sizeof(pid) || write(descriptor, pid, (size_t)length) != length || close(descriptor) || close(directory)) fail();
  char file[96], membership[PATH_MAX + 8];
  if (snprintf(file, sizeof(file), "/proc/%ld/cgroup", (long)child) >= (int)sizeof(file)) fail();
  int control = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (control < 0) fail();
  ssize_t size = read(control, membership, sizeof(membership) - 1);
  if (size <= 0 || size >= (ssize_t)sizeof(membership) - 1 || close(control)) fail();
  membership[size] = 0;
  char expected[PATH_MAX + 8];
  if (snprintf(expected, sizeof(expected), "0::%s\n", engine_scope + strlen("/sys/fs/cgroup")) >= (int)sizeof(expected) || strcmp(membership, expected)) fail();
}

static void publish_child_custody(pid_t child) {
  char helper[PATH_MAX], pid[32];
  if (snprintf(helper, sizeof(helper), "%s/lib/zeros/publish-cloud-workload-custody.mjs", runtime_root) >= (int)sizeof(helper) ||
      snprintf(pid, sizeof(pid), "%ld", (long)child) >= (int)sizeof(pid)) fail();
  require_path(helper, 0, 1);
  const pid_t publisher = fork();
  if (publisher < 0) fail();
  if (!publisher) { char *args[] = {runtime_node, helper, engine_scope, pid, NULL}; execv(runtime_node, args); fail(); }
  int status; pid_t waited;
  do { waited = waitpid(publisher, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != publisher || !WIFEXITED(status) || WEXITSTATUS(status)) fail();
  // Only the root publisher could modify this temporary root-owned bind.
  // Lock it before the non-root child's mount namespace and target exec.
  if (mount(NULL, "/etc/zeros/cloud-workload-custody.json", NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL)) fail();
  // Remove the root-only publisher alias in the shared mount view BEFORE the
  // blocked child clones and locks that view. No control FD was inherited.
  if (umount2("/run/zeros/workload-custody", 0)) fail();
}

static void require_root_control_membership(const char *source) {
  const char *suffix = "/zeros-host.service/host\n";
  const size_t length = strlen(source), ending = strlen(suffix);
  if (length < ending + 4 || length > 8192 || strncmp(source, "0::/", 4) ||
      memcmp(source + length - ending, suffix, ending) || strstr(source, "//") ||
      strstr(source, "/../") || strstr(source, "/./") || memchr(source, '\n', length - 1)) fail();
}

static void require_root_outside(void) {
  char source[8193];
  const int descriptor = open("/proc/self/cgroup", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct statfs filesystem;
  if (descriptor < 0 || fstatfs(descriptor, &filesystem) || filesystem.f_type != 0x9fa0) fail();
  const ssize_t size = read(descriptor, source, sizeof(source) - 1);
  if (size <= 0 || size >= (ssize_t)sizeof(source) - 1 || close(descriptor)) fail();
  source[size] = 0;
  require_root_control_membership(source);
}

#define DENY(number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static void restrict_syscalls(void) {
  /* This common deployment filter protects VM-root authority.
   * The kernel prevents entering an ancestor user namespace. Global kernel
   * interfaces and inherited keyring authority are not needed by the engine. */
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
#elif defined(__aarch64__)
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
#else
#error Unsupported cloud engine architecture
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
    DENY(__NR_bpf), DENY(__NR_perf_event_open), DENY(__NR_keyctl),
    DENY(__NR_add_key), DENY(__NR_request_key), DENY(__NR_open_by_handle_at),
    DENY(__NR_init_module), DENY(__NR_finit_module), DENY(__NR_delete_module),
    DENY(__NR_kexec_load), DENY(__NR_reboot), DENY(__NR_swapon), DENY(__NR_swapoff),
    DENY(__NR_userfaultfd), DENY(__NR_io_uring_setup),
#ifdef __NR_pidfd_getfd
    DENY(__NR_pidfd_getfd),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof(rules) / sizeof(rules[0])), .filter = rules,
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}

/* Drop every bounding/ambient capability while the fixed transition still
 * has mapping authority. The post-UID capset clears effective/permitted/
 * inheritable too; the executed engine receives all five sets empty. */
static void restrict_capabilities(void) {
  for (int capability = 0; capability < 64; capability++) {
    int present = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (present < 0) { if (errno == EINVAL) continue; fail(); }
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0)) fail();
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) fail();
}

int main(int argc, char **argv) {
  if (argc > 2 && strcmp(argv[1], "--await-launch") == 0) {
    const pid_t parent = getppid();
    if (getuid() != 0 || geteuid() != 0 || getgid() != 0 ||
        prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) fail();
    require_root_outside();
    byte_io(3, 0);
    if (close(3)) fail();
    argv[1] = "/usr/bin/bwrap";
    execv(argv[1], argv + 1);
    fail();
  }
  const int selected = argc >= 3 && strcmp(argv[1], "--runtime-id") == 0;
  if (!selected) fail();
  select_runtime(argv[2]);
  if (argc < 5 || strcmp(argv[3], "--engine-scope")) fail();
  select_engine_scope(argv[4]);
  const int option = 5;
  const int qualification = argc == option + 1 ?
    strcmp(argv[option], "--qualify") == 0 : 0;
  const int resident = argc == option + 1 && strcmp(argv[option], "--resident") == 0;
  const int cursor_probe = argc == option + 1 && strcmp(argv[option], "--probe-cursor") == 0;
  if ((argc != option && !qualification && !resident && !cursor_probe) || getuid() != 0 || geteuid() != 0 || getgid() != 0 ||
      setgroups(0, NULL)) fail();
  require_root_outside();
  validate_view(qualification, resident, cursor_probe);
  struct rlimit core = { .rlim_cur = 0, .rlim_max = 0 };
  if (setrlimit(RLIMIT_CORE, &core)) fail();
  /* No inherited file capability, directory, socket or engine-lock descriptor
   * may cross into the general engine. The outer broker retains its own lock. */
  if (syscall(SYS_close_range, 3U, ~0U, 0U)) fail();
  int ready[2], go[2];
  if (pipe2(ready, O_CLOEXEC) || pipe2(go, O_CLOEXEC)) fail();
  const pid_t parent = getpid();
  pid_t child = fork();
  if (child < 0) fail();
  if (child == 0) {
    (void)close(ready[0]); (void)close(go[1]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent || unshare(CLONE_NEWUSER)) fail();
    byte_io(ready[1], 1);
    byte_io(go[0], 0);
    /* A second mount namespace locks inherited RO mounts under the new
     * user namespace. Complete it before losing mount/identity authority. */
    if (unshare(CLONE_NEWNS)) fail();
    restrict_capabilities();
    if (setresgid(10003, 10003, 10003) || setresuid(10003, 10003, 10003) ||
        prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent ||
        getuid() != 10003 || getgid() != 10003 || getgroups(0, NULL) != 0) fail();
    struct __user_cap_header_struct cap_header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct cap_data[2] = {{0}, {0}};
    if (syscall(SYS_capset, &cap_header, cap_data)) fail();
    restrict_syscalls();
    byte_io(ready[1], 1);
    byte_io(go[0], 0);
    (void)close(ready[1]); (void)close(go[0]);
    char engine[PATH_MAX], qualify[PATH_MAX], host[PATH_MAX], cursor[PATH_MAX];
    if (snprintf(cursor, sizeof(cursor), "%s/lib/zeros/runtime-self-test.mjs", runtime_root) >= (int)sizeof(cursor)) fail();
    worker_path(engine, sizeof(engine), "dist-engine/cli.js");
    worker_path(qualify, sizeof(qualify), "scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs");
    worker_path(host, sizeof(host), "dist-engine/resident-pty.js");
    char *arguments[] = {
      runtime_node, engine,
      "serve", "--root", "/srv/zeros/workspace", NULL,
    };
    char *qualification_arguments[] = {
      runtime_node, qualify, NULL,
    };
    char *resident_arguments[] = { runtime_node, host, NULL };
    char *cursor_arguments[] = { runtime_node, cursor, "--engine-cursor-probe", NULL };
    execv(arguments[0], cursor_probe ? cursor_arguments : (resident ? resident_arguments : (qualification ? qualification_arguments : arguments)));
    fail();
  }
  child_pid = (sig_atomic_t)child;
  (void)close(ready[1]); (void)close(go[0]);
  struct sigaction action = { .sa_handler = forward_signal, .sa_flags = SA_RESTART };
  if (sigemptyset(&action.sa_mask) || sigaction(SIGTERM, &action, NULL) ||
      sigaction(SIGINT, &action, NULL) || sigaction(SIGHUP, &action, NULL)) fail();
  byte_io(ready[0], 0);
  write_map(child, "uid"); write_map(child, "gid");
  publish_child_custody(child);
  byte_io(go[1], 1);
  byte_io(ready[0], 0);
  place_engine_child(child);
  byte_io(go[1], 1);
  (void)close(ready[0]); (void)close(go[1]);
  int status;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != child) fail();
  child_pid = 0;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}
