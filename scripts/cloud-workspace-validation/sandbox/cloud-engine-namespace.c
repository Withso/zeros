/* Fixed transition from the host broker's already-restricted mount view.
 * The engine is namespace root, mapped to VM UID/GID 10003. VM root is NEVER
 * mapped. Worker 10001 and capture 10002 are mapped; v3 also maps the
 * private provider coordinator 10004.
 * Not setuid. Namespace entry accepts no selected command, identity or map.
 * The host-only --await-scope entry blocks BEFORE bubblewrap can fork, then
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
static char runtime_root[128] = "/opt/zeros-runtime";
static char worker_root[144] = "/opt/zeros";
static char runtime_node[160] = "/opt/zeros-runtime/bin/node";
static int runtime_version = 2;

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

static void validate_view(int qualification) {
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
    require_worker_path(qualification == 2 ?
      "scripts/cloud-workspace-validation/sandbox/qualify-cloud-agent.ts" :
      "scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs", 0);
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

static void write_map(pid_t child, const char *kind, int version) {
  char file[96];
  int length = snprintf(file, sizeof(file), "/proc/%ld/%s_map", (long)child, kind);
  if (length <= 0 || (size_t)length >= sizeof(file)) fail();
  int descriptor = open(file, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  const char *mapping = (version == 3 || version == 4) ? "0 10003 1\n10001 10001 2\n10004 10004 1\n" : "0 10003 1\n10001 10001 2\n";
  size_t length_bytes = strlen(mapping);
  if (descriptor < 0 || write(descriptor, mapping, length_bytes) !=
      (ssize_t)length_bytes || close(descriptor)) fail();
}

#define DENY(number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static void restrict_syscalls(void) {
  /* Namespace construction remains available for the existing agent sandbox.
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

static void restrict_capabilities(void) {
  const unsigned long long allowed =
    (1ULL << CAP_CHOWN) | (1ULL << CAP_DAC_OVERRIDE) | (1ULL << CAP_FOWNER) |
    (1ULL << CAP_KILL) | (1ULL << CAP_SETGID) | (1ULL << CAP_SETUID) |
    (1ULL << CAP_SETPCAP) | (1ULL << CAP_SYS_CHROOT) | (1ULL << CAP_SYS_ADMIN);
  for (int capability = 0; capability < 64; capability++) {
    int present = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (present < 0) { if (errno == EINVAL) continue; fail(); }
    if (!(allowed & (1ULL << (unsigned int)capability)) &&
        prctl(PR_CAPBSET_DROP, capability, 0, 0, 0)) fail();
  }
  struct __user_cap_header_struct header = {
    .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0,
  };
  struct __user_cap_data_struct data[2] = {
    { .effective = (unsigned int)allowed, .permitted = (unsigned int)allowed },
    { .effective = (unsigned int)(allowed >> 32), .permitted = (unsigned int)(allowed >> 32) },
  };
  if (syscall(SYS_capset, &header, data) ||
      prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) fail();
}

int main(int argc, char **argv) {
  if (argc > 2 && strcmp(argv[1], "--await-scope") == 0) {
    const pid_t parent = getppid();
    if (getuid() != 0 || geteuid() != 0 || getgid() != 0 ||
        prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) fail();
    byte_io(3, 0);
    if (close(3)) fail();
    argv[1] = "/usr/bin/bwrap";
    execv(argv[1], argv + 1);
    fail();
  }
  const int selected = argc >= 3 && strcmp(argv[1], "--runtime-id") == 0;
  if (selected) select_runtime(argv[2]);
  const int version = selected ? 4 : (argc >= 2 && strcmp(argv[1], "--v3") == 0 ? 3 : 2);
  runtime_version = version;
  const int option = version == 4 ? 3 : version == 3 ? 2 : 1;
  const int qualification = argc == option + 1 ?
    (strcmp(argv[option], "--qualify") == 0 ? 1 :
      (version >= 3 && strcmp(argv[option], "--qualify-agent") == 0 ? 2 : 0)) : 0;
  if ((argc != option && !qualification) || getuid() != 0 || geteuid() != 0 || getgid() != 0 ||
      setgroups(0, NULL)) fail();
  validate_view(qualification);
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
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent ||
        unshare(CLONE_NEWNS) || unshare(CLONE_NEWUSER)) fail();
    byte_io(ready[1], 1);
    byte_io(go[0], 0);
    (void)close(ready[1]); (void)close(go[0]);
    if (setresgid(0, 0, 0) || setresuid(0, 0, 0) ||
        prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent ||
        unshare(CLONE_NEWNS) || getuid() != 0 || getgid() != 0 ||
        getgroups(0, NULL) != 0) fail();
    restrict_capabilities();
    restrict_syscalls();
    char engine[PATH_MAX], qualify[PATH_MAX], agent[PATH_MAX];
    worker_path(engine, sizeof(engine), "dist-engine/cli.js");
    worker_path(qualify, sizeof(qualify), "scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs");
    worker_path(agent, sizeof(agent), "scripts/cloud-workspace-validation/sandbox/qualify-cloud-agent.ts");
    char *arguments[] = {
      runtime_node, engine,
      "serve", "--root", "/srv/zeros/workspace", NULL,
    };
    char *qualification_arguments[] = {
      runtime_node, qualify, NULL,
    };
    char *agent_qualification_arguments[] = {
      runtime_node, "--import", "tsx", agent, NULL,
    };
    execv(arguments[0], qualification == 2 ? agent_qualification_arguments :
      (qualification ? qualification_arguments : arguments));
    fail();
  }
  child_pid = (sig_atomic_t)child;
  (void)close(ready[1]); (void)close(go[0]);
  struct sigaction action = { .sa_handler = forward_signal, .sa_flags = SA_RESTART };
  if (sigemptyset(&action.sa_mask) || sigaction(SIGTERM, &action, NULL) ||
      sigaction(SIGINT, &action, NULL) || sigaction(SIGHUP, &action, NULL)) fail();
  byte_io(ready[0], 0);
  write_map(child, "uid", version); write_map(child, "gid", version);
  byte_io(go[1], 1);
  (void)close(ready[0]); (void)close(go[1]);
  int status;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != child) fail();
  child_pid = 0;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}
