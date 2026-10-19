/* Private, fixed-policy systemd client. No default/session bus, shell, caller
 * unit properties or provider material. The VM remains the trust boundary. */
#define _GNU_SOURCE
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <time.h>
#include <systemd/sd-bus.h>

#define ROOT "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload"
#define MANAGER "/org/freedesktop/systemd1"
#define MI "org.freedesktop.systemd1.Manager"
#define UI "org.freedesktop.systemd1.Unit"
#define SI "org.freedesktop.systemd1.Service"
#define UID 10003
#define CGROUP2 0x63677270
typedef struct {
  uint32_t version, phase;
  char boot[37], execution[37], attempt[37], runtime[68], invocation[33];
  uint64_t manager_pid, manager_start, manager_dev, manager_ino, owner_pid, owner_start, workload_dev, workload_ino;
  uint64_t pid, start, dev, ino;
  char directory[PATH_MAX];
} Claim;
static sd_bus *bus;
static Claim requested;
static char unit[96], manager_root[PATH_MAX];
static int claim_fd = -1;
static void fail(void) { fputs("cloud_runner_native_unavailable\n", stderr); _exit(70); }
static void checked(int value) { if (value < 0) fail(); }
static uint64_t number(const char *value) {
  if (!value || !*value || *value == '0') fail();
  for (const char *p = value; *p; p++) if (*p < '0' || *p > '9') fail();
  errno = 0; char *end; unsigned long long result = strtoull(value, &end, 10);
  if (errno || *end || !result) fail();
  return result;
}
static int hex(const char *value, size_t size) {
  if (!value || strlen(value) != size) return 0;
  for (size_t i = 0; i < size; i++) if (!strchr("0123456789abcdef", value[i])) return 0;
  return 1;
}
static void uuid(char *target, const char *value) {
  if (strlen(value) != 36) fail();
  for (int i = 0; i < 36; i++) if ((i == 8 || i == 13 || i == 18 || i == 23) ? value[i] != '-' : !strchr("0123456789abcdef", value[i])) fail();
  if (!strchr("12345678", value[14]) || !strchr("89ab", value[19])) fail();
  memcpy(target, value, 37);
}
static int read_small(const char *file, char *value, size_t capacity) {
  int fd = open(file, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return -1;
  ssize_t count = read(fd, value, capacity - 1); char extra;
  int error = count < 0 ? errno : 0;
  if (!error) {
    ssize_t tail = read(fd, &extra, 1);
    if (tail != 0) error = tail < 0 ? errno : EOVERFLOW;
  }
  close(fd);
  if (error) { errno = error; return -1; }
  value[count] = 0; return (int)count;
}
static uint64_t birth(uint64_t pid) {
  char file[96], value[8192]; snprintf(file, sizeof(file), "/proc/%llu/stat", (unsigned long long)pid);
  if (read_small(file, value, sizeof(value)) < 0) { if (errno == ENOENT || errno == ESRCH) return 0; fail(); }
  char *last = strrchr(value, ')'), *save;
  if (!last) fail();
  char *field = strtok_r(last + 1, " \n", &save);
  for (int i = 0; i < 19 && field; i++) field = strtok_r(NULL, " \n", &save);
  if (!field) fail();
  return number(field);
}
static void process_group(uint64_t pid, char *directory, size_t capacity) {
  char file[96], value[8192]; struct stat st;
  snprintf(file, sizeof(file), "/proc/%llu", (unsigned long long)pid);
  if (lstat(file, &st) || st.st_uid != UID) fail();
  snprintf(file, sizeof(file), "/proc/%llu/cgroup", (unsigned long long)pid);
  int length = read_small(file, value, sizeof(value));
  if (length < 5 || strncmp(value, "0::/", 4) || value[length - 1] != '\n') fail();
  value[length - 1] = 0;
  if (strchr(value, '\n') || strstr(value, "/../") || strchr(value, '"') || strchr(value, '\\')) fail();
  if (snprintf(directory, capacity, "/sys/fs/cgroup%s", value + 3) >= (int)capacity) fail();
}
static int group_fd(const char *directory, uint64_t dev, uint64_t ino) {
  char canonical[PATH_MAX]; struct stat st; struct statfs filesystem;
  if (!realpath(directory, canonical) || strcmp(canonical, directory)) fail();
  int fd = open(directory, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY);
  if (fd < 0 || fstat(fd, &st) || fstatfs(fd, &filesystem) || filesystem.f_type != CGROUP2 ||
      (dev && dev != (uint64_t)st.st_dev) || (ino && ino != (uint64_t)st.st_ino)) fail();
  return fd;
}
static void assert_owner(void) {
  char directory[PATH_MAX];
  if (birth(requested.owner_pid) != requested.owner_start) fail();
  process_group(requested.owner_pid, directory, sizeof(directory));
  const char *prefix = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-";
  char id[37];
  if (strncmp(directory, prefix, strlen(prefix))) fail();
  uuid(id, directory + strlen(prefix));
  int fd = group_fd(ROOT, requested.workload_dev, requested.workload_ino); close(fd);
}
static void assert_manager(void) {
  char directory[PATH_MAX], expected[PATH_MAX];
  if (birth(requested.manager_pid) != requested.manager_start) fail();
  process_group(requested.manager_pid, directory, sizeof(directory));
  if (snprintf(expected, sizeof(expected), "%s/init.scope", manager_root) >= (int)sizeof(expected) || strcmp(directory, expected)) fail();
  int fd = group_fd(manager_root, requested.manager_dev, requested.manager_ino); close(fd);
}
static void connect_bus(const char *directory) {
  char canonical[PATH_MAX], socket_path[PATH_MAX]; struct stat st;
  if (strlen(directory) != 25 || strncmp(directory, "/tmp/zeros-runners-", 19) ||
      strspn(directory + 19, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") != 6 ||
      !realpath(directory, canonical) || strcmp(canonical, directory) ||
      lstat(directory, &st) || !S_ISDIR(st.st_mode) || st.st_uid != UID || (st.st_mode & 07777) != 0700) fail();
  if (snprintf(socket_path, sizeof(socket_path), "%s/systemd/private", directory) >= (int)sizeof(socket_path) ||
      lstat(socket_path, &st) || !S_ISSOCK(st.st_mode) || st.st_uid != UID || (st.st_mode & 0077)) fail();
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (strlen(socket_path) >= sizeof(address.sun_path)) fail();
  strcpy(address.sun_path, socket_path);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) fail();
  struct ucred peer; socklen_t size = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof(peer) || peer.uid != UID || peer.gid != UID ||
      (uint64_t)peer.pid != requested.manager_pid) fail();
  assert_owner(); assert_manager();
  checked(sd_bus_new(&bus)); checked(sd_bus_set_fd(bus, fd, fd));
  checked(sd_bus_negotiate_fds(bus, 1)); checked(sd_bus_set_method_call_timeout(bus, 5000000)); checked(sd_bus_start(bus));
}
static int claim_open(const char *directory, int reserve) {
  char file[PATH_MAX]; struct stat st;
  if (snprintf(file, sizeof(file), "%s/claims/%s", directory, requested.execution) >= (int)sizeof(file)) fail();
  int fd = open(file, O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_RDWR | (reserve ? O_CREAT | O_EXCL : 0), 0600);
  if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_uid != UID || (st.st_mode & 07777) != 0600) fail();
  if (flock(fd, LOCK_EX)) fail();
  return fd;
}
static void persist(const Claim *claim) {
  if (pwrite(claim_fd, claim, sizeof(*claim), 0) != sizeof(*claim) || ftruncate(claim_fd, sizeof(*claim)) || fsync(claim_fd)) fail();
}
static Claim read_claim(void) {
  Claim claim; struct stat st;
  if (fstat(claim_fd, &st) || st.st_size != sizeof(claim) || pread(claim_fd, &claim, sizeof(claim), 0) != sizeof(claim) ||
      claim.version != 1 || claim.phase < 1 || claim.phase > 3 ||
      memcmp(claim.boot, requested.boot, 37) || memcmp(claim.execution, requested.execution, 37) ||
      memcmp(claim.attempt, requested.attempt, 37) || memcmp(claim.runtime, requested.runtime, 68) ||
      claim.manager_pid != requested.manager_pid || claim.manager_start != requested.manager_start ||
      claim.manager_dev != requested.manager_dev || claim.manager_ino != requested.manager_ino ||
      claim.owner_pid != requested.owner_pid || claim.owner_start != requested.owner_start ||
      claim.workload_dev != requested.workload_dev || claim.workload_ino != requested.workload_ino) fail();
  if (claim.phase >= 2) {
    char expected[PATH_MAX];
    if (snprintf(expected, sizeof(expected), "%s/%s", manager_root, unit) >= (int)sizeof(expected) ||
        !memchr(claim.directory, 0, sizeof(claim.directory)) || strcmp(claim.directory, expected) ||
        claim.invocation[32] || !hex(claim.invocation, 32) || !strcmp(claim.invocation, "00000000000000000000000000000000") ||
        !claim.pid || claim.pid > INT_MAX || !claim.start || claim.dev != claim.workload_dev ||
        !claim.ino || claim.ino == claim.workload_ino || claim.ino == claim.manager_ino) fail();
  }
  return claim;
}
static char *unit_path(void) {
  sd_bus_message *reply = NULL; const char *value;
  if (sd_bus_call_method(bus, NULL, MANAGER, MI, "GetUnit", NULL, &reply, "s", unit) < 0) return NULL;
  if (sd_bus_message_read(reply, "o", &value) <= 0) fail();
  char *result = strdup(value); sd_bus_message_unref(reply); if (!result) fail(); return result;
}
static void invocation(const char *object, char *id) {
  sd_bus_message *reply = NULL; const void *value; size_t size;
  checked(sd_bus_get_property(bus, NULL, object, UI, "InvocationID", NULL, &reply, "ay"));
  if (sd_bus_message_read_array(reply, 'y', &value, &size) < 0 || size != 16) fail();
  for (int i = 0; i < 16; i++) snprintf(id + i * 2, 3, "%02x", ((const unsigned char *)value)[i]);
  sd_bus_message_unref(reply);
}
static void property(sd_bus_message *m, const char *key, const char *type) {
  checked(sd_bus_message_open_container(m, 'r', "sv")); checked(sd_bus_message_append(m, "s", key));
  checked(sd_bus_message_open_container(m, 'v', type));
}
static void property_end(sd_bus_message *m) { checked(sd_bus_message_close_container(m)); checked(sd_bus_message_close_container(m)); }
static void text_property(sd_bus_message *m, const char *key, const char *value) {
  property(m, key, "s"); checked(sd_bus_message_append(m, "s", value)); property_end(m);
}
static void transient(void) {
  sd_bus_message *m = NULL, *reply = NULL;
  checked(sd_bus_message_new_method_call(bus, &m, NULL, MANAGER, MI, "StartTransientUnit"));
  checked(sd_bus_message_append(m, "ss", unit, "fail")); checked(sd_bus_message_open_container(m, 'a', "(sv)"));
  text_property(m, "Description", "Zeros agent runner"); text_property(m, "Type", "exec");
  text_property(m, "Slice", "-.slice"); text_property(m, "Restart", "no"); text_property(m, "KillMode", "control-group");
  /* The private manager has no ambient basic.target or shutdown.target. */
  property(m, "DefaultDependencies", "b"); checked(sd_bus_message_append(m, "b", 0)); property_end(m);
  text_property(m, "User", "10003"); text_property(m, "Group", "10003");
  /* Hold metadata on this bus connection, not an active service retaining
   * provider descriptors. Normal service teardown must release stdout/EOF. */
  const char *booleans[] = { "SendSIGKILL", "NoNewPrivileges", "AddRef" };
  for (size_t i = 0; i < sizeof(booleans) / sizeof(*booleans); i++) { property(m, booleans[i], "b"); checked(sd_bus_message_append(m, "b", 1)); property_end(m); }
  property(m, "UMask", "u"); checked(sd_bus_message_append(m, "u", (uint32_t)0077)); property_end(m);
  const char *limits[] = { "TimeoutStartUSec", "TimeoutStopUSec" };
  for (int i = 0; i < 2; i++) { property(m, limits[i], "t"); checked(sd_bus_message_append(m, "t", (uint64_t)10000000)); property_end(m); }
  const char *stdio[] = { "StandardInputFileDescriptor", "StandardOutputFileDescriptor", "StandardErrorFileDescriptor" };
  for (int i = 0; i < 3; i++) { property(m, stdio[i], "h"); checked(sd_bus_message_append(m, "h", i)); property_end(m); }
  property(m, "Environment", "as"); checked(sd_bus_message_append(m, "as", 2, "PATH=/usr/bin:/bin", "LANG=C.UTF-8")); property_end(m);
  char node[PATH_MAX], entry[PATH_MAX];
  snprintf(node, sizeof(node), "/opt/zeros-infra/%s/bin/node", requested.runtime);
  snprintf(entry, sizeof(entry), "/opt/zeros-infra/%s/worker/apps/desktop/src/engine/agents/containment/cloud-agent-runner.mjs", requested.runtime);
  property(m, "ExecStart", "a(sasb)"); checked(sd_bus_message_open_container(m, 'a', "(sasb)"));
  checked(sd_bus_message_open_container(m, 'r', "sasb")); checked(sd_bus_message_append(m, "s", node));
  checked(sd_bus_message_append(m, "as", 8, node, entry, "--attempt", requested.attempt, "--boot", requested.boot, "--execution", requested.execution));
  checked(sd_bus_message_append(m, "b", 0)); checked(sd_bus_message_close_container(m)); checked(sd_bus_message_close_container(m)); property_end(m);
  checked(sd_bus_message_close_container(m)); checked(sd_bus_message_open_container(m, 'a', "(sa(sv))")); checked(sd_bus_message_close_container(m));
  checked(sd_bus_call(bus, m, 5000000, NULL, &reply)); sd_bus_message_unref(reply); sd_bus_message_unref(m);
}
static int observe(Claim *claim, const char *object, int initial) {
  uint32_t pid = 0; char id[33]; char *relative = NULL;
  checked(sd_bus_get_property_trivial(bus, NULL, object, SI, "MainPID", NULL, 'u', &pid)); invocation(object, id);
  if (!initial && strcmp(id, claim->invocation)) fail();
  if (!pid) return 0;
  checked(sd_bus_get_property_string(bus, NULL, object, UI, "ControlGroup", NULL, &relative));
  char directory[PATH_MAX], actual[PATH_MAX];
  if (snprintf(directory, sizeof(directory), "/sys/fs/cgroup%s", relative) >= (int)sizeof(directory)) fail();
  free(relative);
  char expected[PATH_MAX];
  if (snprintf(expected, sizeof(expected), "%s/%s", manager_root, unit) >= (int)sizeof(expected) || strcmp(directory, expected)) fail();
  uint64_t start = birth(pid); if (!start) return 0;
  process_group(pid, actual, sizeof(actual)); if (strcmp(actual, directory)) fail();
  int fd = group_fd(directory, initial ? 0 : claim->dev, initial ? 0 : claim->ino); struct stat st;
  if (fstat(fd, &st)) fail();
  close(fd);
  if (initial) { claim->pid = pid; claim->start = start; claim->dev = st.st_dev; claim->ino = st.st_ino;
    strcpy(claim->directory, directory); strcpy(claim->invocation, id);
  } else if (claim->pid != pid || claim->start != start || strcmp(claim->directory, directory)) fail();
  return 1;
}
static void proof(const Claim *claim) {
  printf("{\"version\":1,\"attemptId\":\"%s\",\"bootId\":\"%s\",\"unit\":\"%s\",\"invocationId\":\"%s\",\"pid\":%llu,\"startToken\":\"%llu\",\"cgroup\":{\"directory\":\"%s\",\"dev\":\"%llu\",\"ino\":\"%llu\"}}",
    claim->attempt, claim->boot, unit, claim->invocation, (unsigned long long)claim->pid, (unsigned long long)claim->start,
    claim->directory, (unsigned long long)claim->dev, (unsigned long long)claim->ino);
}
static int empty(int fd) {
  struct stat st; if (fstat(fd, &st)) fail();
  if (!st.st_nlink) return 1; /* cgroupfs only removes an empty original group. */
  int events = openat(fd, "cgroup.events", O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (events < 0) fail();
  char value[1024] = {0}; ssize_t size = read(events, value, sizeof(value) - 1); close(events);
  if (size < 0 || size == sizeof(value) - 1) fail();
  return !strncmp(value, "populated 0\n", 12) || strstr(value, "\npopulated 0\n") != NULL;
}
static void retirement(const Claim *claim) {
  printf("{\"version\":1,\"attemptId\":\"%s\",\"bootId\":\"%s\",\"unit\":\"%s\",\"invocationId\":\"%s\",\"originalStartSettled\":true,\"originalProcessGone\":true,\"cgroup\":{\"directory\":\"%s\",\"dev\":\"%llu\",\"ino\":\"%llu\"},\"complete\":true,\"populated\":false}\n",
    claim->attempt, claim->boot, unit, claim->invocation, claim->directory, (unsigned long long)claim->dev, (unsigned long long)claim->ino);
}
static void stop_original(int group) {
  /* A separate StopUnit(name) could hit a replacement between inspection and
   * dispatch. The opened original inode is the only signalling authority. */
  struct stat st; if (fstat(group, &st)) fail();
  if (!st.st_nlink) return;
  int fd = openat(group, "cgroup.kill", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 || write(fd, "1", 1) != 1) fail();
  close(fd);
}
int main(int argc, char **argv) {
  /* Offline artifact closure only: loading this executable proves its shared
   * libraries resolve. It creates no manager, unit, claim, or authority. */
  if (argc == 2 && !strcmp(argv[1], "--self-test")) {
    puts("{\"schema\":\"zeros.cloud-runner-native/v1\",\"linked\":true}"); return 0;
  }
  if (argc != 15 || (strcmp(argv[1], "start") && strcmp(argv[1], "inspect") && strcmp(argv[1], "stop") && strcmp(argv[1], "ping")) ||
      getuid() != UID || geteuid() != UID || getgid() != UID || getegid() != UID) fail();
  alarm(15); umask(0077); requested.version = 1; requested.phase = 1;
  requested.manager_pid = number(argv[3]); requested.manager_start = number(argv[4]); requested.manager_dev = number(argv[5]); requested.manager_ino = number(argv[6]);
  requested.owner_pid = number(argv[7]); requested.owner_start = number(argv[8]); uuid(requested.boot, argv[9]);
  if (strlen(argv[10]) != 67 || strncmp(argv[10], "r1-", 3) || !hex(argv[10] + 3, 64)) fail();
  strcpy(requested.runtime, argv[10]);
  uuid(requested.execution, argv[11]); uuid(requested.attempt, argv[12]); requested.workload_dev = number(argv[13]); requested.workload_ino = number(argv[14]);
  snprintf(unit, sizeof(unit), "zeros-agent-runner@%s.service", requested.execution);
  snprintf(manager_root, sizeof(manager_root), "%s/runner-%s", ROOT, requested.boot);
  connect_bus(argv[2]);
  if (!strcmp(argv[1], "ping")) { puts("{\"ready\":true}"); return 0; }
  int starting = !strcmp(argv[1], "start"); claim_fd = claim_open(argv[2], starting);
  Claim claim = requested;
  if (starting) {
    persist(&claim);
    char directory[PATH_MAX]; snprintf(directory, sizeof(directory), "%s/claims", argv[2]);
    int parent = open(directory, O_DIRECTORY | O_NOFOLLOW | O_RDONLY | O_CLOEXEC); if (parent < 0 || fsync(parent)) fail(); close(parent);
    transient();
    char *object = NULL; int running = 0;
    for (int count = 0; count < 200 && !running; count++) {
      free(object); object = unit_path(); if (object) running = observe(&claim, object, 1);
      if (!running) usleep(25000);
    }
    if (!running) fail();
    assert_owner(); assert_manager(); claim.phase = 2; persist(&claim);
    int group = group_fd(claim.directory, claim.dev, claim.ino);
    int pidfd = syscall(SYS_pidfd_open, (pid_t)claim.pid, 0); if (pidfd < 0 || birth(claim.pid) != claim.start) fail();
    if (flock(claim_fd, LOCK_UN)) fail();
    fputs("{\"type\":\"native\",\"proof\":", stdout); proof(&claim); fputs("}\n", stdout); if (fflush(stdout)) fail();
    alarm(0); struct pollfd watch = { .fd = pidfd, .events = POLLIN };
    while (poll(&watch, 1, -1) < 0) if (errno != EINTR) fail();
    close(pidfd); alarm(15);
    if (flock(claim_fd, LOCK_EX)) fail();
    claim = read_claim();
    int gone = claim.phase == 3;
    for (int count = 0; count < 480 && !gone; count++) {
      gone = birth(claim.pid) != claim.start && empty(group);
      if (!gone) usleep(25000);
    }
    if (!gone) fail();
    claim.phase = 3; persist(&claim);
    close(group);
    int32_t status = 1, code = 0;
    sd_bus_get_property_trivial(bus, NULL, object, SI, "ExecMainCode", NULL, 'i', &code);
    sd_bus_get_property_trivial(bus, NULL, object, SI, "ExecMainStatus", NULL, 'i', &status);
    free(object); return code == CLD_EXITED && status >= 0 && status <= 255 ? (int)status : 1;
  }
  claim = read_claim(); if (claim.phase < 2) fail();
  if (claim.phase == 3) {
    /* The original inode was positively empty and its PID gone. A later unit
     * with the same name cannot extend that retired custody or be signalled. */
    if (!strcmp(argv[1], "inspect")) { fputs("{\"state\":\"exited\",\"proof\":", stdout); proof(&claim); puts("}"); }
    else retirement(&claim);
    return 0;
  }
  char *object = unit_path();
  int running = object ? observe(&claim, object, 0) : 0;
  if (!strcmp(argv[1], "inspect")) {
    if (!object && claim.phase != 3) fail();
    printf("{\"state\":\"%s\",\"proof\":", running ? "running" : "exited"); proof(&claim); fputs("}\n", stdout); return 0;
  }
  if (claim.phase != 3) {
    int group = group_fd(claim.directory, claim.dev, claim.ino);
    stop_original(group);
    int gone = 0;
    for (int count = 0; count < 480 && !gone; count++) { gone = birth(claim.pid) != claim.start && empty(group); if (!gone) usleep(25000); }
    close(group); if (!gone) fail(); claim.phase = 3; persist(&claim);
  }
  retirement(&claim); free(object); return 0;
}
