// Zeros Sandbox Runtime — macOS detached-process domain helper.
//
// Seatbelt policy is inherited across fork/exec, including setsid(2) and a
// double fork, but POSIX process groups are not.  This helper identifies one
// exact ZSR generation by two immutable path decisions in that inherited
// kernel policy, freezes every matching process, rescans until the set is
// stable, then kills and proves the domain empty.  It deliberately performs no
// filesystem mutation and accepts no command to execute.

#define _DARWIN_C_SOURCE 1

#include <arpa/inet.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

// Apple keeps sandbox_check(3) outside the public SDK header even though the
// system itself and browser engines use it.  Resolve it from libSystem at link
// time and fail the runtime self-test if the symbol ever disappears.
extern int sandbox_check(pid_t pid, const char *operation, int filter, ...);

enum {
  ZSR_SANDBOX_FILTER_NONE = 0,
  ZSR_SANDBOX_FILTER_PATH = 1,
  ZSR_HELPER_VERSION = 1,
  ZSR_MAX_PROCESSES = 262144,
  ZSR_MAX_PROCESS_FDS = 65536,
  ZSR_MAX_TCP_LISTENERS = 256,
  ZSR_TERM_WINDOW_MS = 300,
  ZSR_FREEZE_WINDOW_MS = 2000,
  ZSR_KILL_WINDOW_MS = 2000,
  ZSR_SCAN_PAUSE_US = 10000,
};

typedef struct {
  pid_t pid;
  uint64_t start_sec;
  uint64_t start_usec;
  uid_t uid;
  int status;
} zsr_process;

typedef struct {
  zsr_process *items;
  size_t count;
} zsr_process_list;

typedef struct {
  uint16_t port;
  bool ipv4;
  bool ipv6;
} zsr_tcp_listener;

typedef struct {
  zsr_tcp_listener items[ZSR_MAX_TCP_LISTENERS];
  size_t count;
} zsr_tcp_listener_list;

typedef struct {
  const char *allow_path;
  const char *deny_path;
  uid_t owner_uid;
  pid_t excluded_pid;
} zsr_fingerprint;

static uint64_t monotonic_millis(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return ((uint64_t)now.tv_sec * 1000ULL) +
         ((uint64_t)now.tv_nsec / 1000000ULL);
}

static bool parse_u64(const char *text, uint64_t *out) {
  if (!text || !*text || text[0] == '-') return false;
  errno = 0;
  char *end = NULL;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno != 0 || !end || *end != '\0') return false;
  *out = (uint64_t)value;
  return true;
}

static bool process_info(pid_t pid, zsr_process *out) {
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  int read = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (read != (int)sizeof(info)) return false;
  out->pid = pid;
  out->start_sec = info.pbi_start_tvsec;
  out->start_usec = info.pbi_start_tvusec;
  out->uid = info.pbi_uid;
  out->status = info.pbi_status;
  return out->start_sec != 0 || out->start_usec != 0;
}

static bool canonical_regular_file(const char *input, char output[PATH_MAX]) {
  if (!input || input[0] != '/') return false;
  char *resolved = realpath(input, output);
  if (!resolved || strcmp(resolved, input) != 0) return false;
  struct stat metadata;
  if (lstat(output, &metadata) != 0) return false;
  return S_ISREG(metadata.st_mode) && !S_ISLNK(metadata.st_mode);
}

static int path_decision(pid_t pid, const char *operation, const char *path) {
  errno = 0;
  return sandbox_check(pid, operation, ZSR_SANDBOX_FILTER_PATH, path);
}

static bool matches_fingerprint(const zsr_process *candidate,
                                const zsr_fingerprint *fingerprint) {
  if (candidate->pid <= 1 || candidate->pid == getpid() ||
      candidate->pid == fingerprint->excluded_pid ||
      candidate->uid != fingerprint->owner_uid ||
      candidate->status == SZOMB) {
    return false;
  }
  if (sandbox_check(candidate->pid, NULL, ZSR_SANDBOX_FILTER_NONE) != 1) {
    return false;
  }

  // The generation-private marker is readable but immutable.  The policy
  // descriptor is unreadable and immutable.  An unsandboxed process is already
  // excluded above; a sibling ZSR generation cannot read this marker because
  // the enclosing engine state is denied and only its own tools subtree is
  // carved back in.
  int allow_read = path_decision(candidate->pid, "file-read-data",
                                 fingerprint->allow_path);
  int allow_write = path_decision(candidate->pid, "file-write-data",
                                  fingerprint->allow_path);
  int deny_read = path_decision(candidate->pid, "file-read-data",
                                fingerprint->deny_path);
  int deny_write = path_decision(candidate->pid, "file-write-data",
                                 fingerprint->deny_path);
  return allow_read == 0 && allow_write > 0 && deny_read > 0 && deny_write > 0;
}

static int compare_process(const void *left, const void *right) {
  const zsr_process *a = (const zsr_process *)left;
  const zsr_process *b = (const zsr_process *)right;
  if (a->pid < b->pid) return -1;
  if (a->pid > b->pid) return 1;
  if (a->start_sec < b->start_sec) return -1;
  if (a->start_sec > b->start_sec) return 1;
  if (a->start_usec < b->start_usec) return -1;
  if (a->start_usec > b->start_usec) return 1;
  return 0;
}

static bool same_process_set(const zsr_process_list *a,
                             const zsr_process_list *b) {
  if (a->count != b->count) return false;
  for (size_t index = 0; index < a->count; index++) {
    if (a->items[index].pid != b->items[index].pid ||
        a->items[index].start_sec != b->items[index].start_sec ||
        a->items[index].start_usec != b->items[index].start_usec) {
      return false;
    }
  }
  return true;
}

static void free_process_list(zsr_process_list *list) {
  free(list->items);
  list->items = NULL;
  list->count = 0;
}

static int collect_matches(const zsr_fingerprint *fingerprint,
                           zsr_process_list *out) {
  out->items = NULL;
  out->count = 0;
  int estimated = proc_listallpids(NULL, 0);
  if (estimated < 0) return -1;
  size_t capacity = (size_t)estimated + 1024;
  if (capacity < 2048) capacity = 2048;
  if (capacity > ZSR_MAX_PROCESSES) capacity = ZSR_MAX_PROCESSES;

  pid_t *pids = calloc(capacity, sizeof(pid_t));
  zsr_process *matches = calloc(capacity, sizeof(zsr_process));
  if (!pids || !matches) {
    free(pids);
    free(matches);
    errno = ENOMEM;
    return -1;
  }
  // Unlike proc_listpids(3), proc_listallpids(3) returns an element count.
  int listed = proc_listallpids(pids, (int)(capacity * sizeof(pid_t)));
  if (listed < 0) {
    free(pids);
    free(matches);
    return -1;
  }
  size_t count = (size_t)listed;
  if (count >= capacity) {
    free(pids);
    free(matches);
    errno = EOVERFLOW;
    return -1;
  }
  size_t matched = 0;
  for (size_t index = 0; index < count; index++) {
    zsr_process candidate;
    if (!process_info(pids[index], &candidate)) continue;
    if (!matches_fingerprint(&candidate, fingerprint)) continue;
    matches[matched++] = candidate;
  }
  free(pids);
  qsort(matches, matched, sizeof(zsr_process), compare_process);
  out->items = matches;
  out->count = matched;
  return 0;
}

static int compare_tcp_listener(const void *left, const void *right) {
  const zsr_tcp_listener *a = (const zsr_tcp_listener *)left;
  const zsr_tcp_listener *b = (const zsr_tcp_listener *)right;
  if (a->port < b->port) return -1;
  if (a->port > b->port) return 1;
  return 0;
}

static int add_tcp_listener(zsr_tcp_listener_list *listeners, uint16_t port,
                            bool ipv4, bool ipv6) {
  if (port == 0 || (!ipv4 && !ipv6)) return 0;
  for (size_t index = 0; index < listeners->count; index++) {
    if (listeners->items[index].port != port) continue;
    listeners->items[index].ipv4 |= ipv4;
    listeners->items[index].ipv6 |= ipv6;
    return 0;
  }
  if (listeners->count >= ZSR_MAX_TCP_LISTENERS) {
    errno = EOVERFLOW;
    return -1;
  }
  listeners->items[listeners->count++] =
      (zsr_tcp_listener){.port = port, .ipv4 = ipv4, .ipv6 = ipv6};
  return 0;
}

static bool ipv4_loopback_or_any(const struct in_addr *address) {
  uint32_t host = ntohl(address->s_addr);
  return host == INADDR_ANY || (host & 0xff000000U) == 0x7f000000U;
}

static bool ipv6_loopback_or_any(const struct in6_addr *address) {
  if (IN6_IS_ADDR_UNSPECIFIED(address) || IN6_IS_ADDR_LOOPBACK(address)) {
    return true;
  }
  if (!IN6_IS_ADDR_V4MAPPED(address)) return false;
  struct in_addr mapped;
  memcpy(&mapped, &address->s6_addr[12], sizeof(mapped));
  return ipv4_loopback_or_any(&mapped);
}

static int collect_process_tcp_listeners(
    const zsr_process *process, const zsr_fingerprint *fingerprint,
    zsr_tcp_listener_list *listeners) {
  int estimated = proc_pidinfo(process->pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (estimated <= 0) {
    zsr_process current;
    if (!process_info(process->pid, &current)) return 0;
    errno = errno ? errno : EIO;
    return -1;
  }
  size_t maximum_bytes =
      (size_t)ZSR_MAX_PROCESS_FDS * sizeof(struct proc_fdinfo);
  size_t capacity = (size_t)estimated +
                    (32U * sizeof(struct proc_fdinfo));
  if (capacity > maximum_bytes || capacity > INT_MAX) {
    errno = EOVERFLOW;
    return -1;
  }
  struct proc_fdinfo *fds = calloc(1, capacity);
  if (!fds) {
    errno = ENOMEM;
    return -1;
  }
  int bytes = proc_pidinfo(process->pid, PROC_PIDLISTFDS, 0, fds,
                           (int)capacity);
  if (bytes <= 0) {
    free(fds);
    zsr_process current;
    if (!process_info(process->pid, &current)) return 0;
    errno = errno ? errno : EIO;
    return -1;
  }

  zsr_tcp_listener_list original = *listeners;
  size_t fd_count = (size_t)bytes / sizeof(struct proc_fdinfo);
  for (size_t index = 0; index < fd_count; index++) {
    if (fds[index].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
    struct socket_fdinfo info;
    memset(&info, 0, sizeof(info));
    int read = proc_pidfdinfo(process->pid, fds[index].proc_fd,
                              PROC_PIDFDSOCKETINFO, &info, sizeof(info));
    if (read != (int)sizeof(info) || info.psi.soi_kind != SOCKINFO_TCP ||
        info.psi.soi_proto.pri_tcp.tcpsi_state != TSI_S_LISTEN) {
      continue;
    }
    const struct in_sockinfo *internet =
        &info.psi.soi_proto.pri_tcp.tcpsi_ini;
    uint16_t port = ntohs((uint16_t)internet->insi_lport);
    bool ipv4 = false;
    bool ipv6 = false;
    if (info.psi.soi_family == AF_INET) {
      ipv4 = ipv4_loopback_or_any(&internet->insi_laddr.ina_46.i46a_addr4);
    } else if (info.psi.soi_family == AF_INET6) {
      ipv6 = ipv6_loopback_or_any(&internet->insi_laddr.ina_6);
    }
    if (add_tcp_listener(listeners, port, ipv4, ipv6) != 0) {
      free(fds);
      return -1;
    }
  }
  free(fds);

  // A pid or fd can be recycled during the scan. Keep results only when the
  // immutable start identity and Seatbelt fingerprint still match afterward.
  zsr_process current;
  if (!process_info(process->pid, &current) ||
      current.start_sec != process->start_sec ||
      current.start_usec != process->start_usec ||
      !matches_fingerprint(&current, fingerprint)) {
    *listeners = original;
  }
  return 0;
}

static int signal_checked(const zsr_process *target,
                          const zsr_fingerprint *fingerprint, int signal) {
  zsr_process current;
  if (!process_info(target->pid, &current)) return 0;
  if (current.start_sec != target->start_sec ||
      current.start_usec != target->start_usec ||
      !matches_fingerprint(&current, fingerprint)) {
    return 0;
  }
  if (kill(target->pid, signal) == 0 || errno == ESRCH) return 0;
  return -1;
}

static int signal_list(const zsr_process_list *list,
                       const zsr_fingerprint *fingerprint, int signal,
                       uint64_t *counter) {
  for (size_t index = 0; index < list->count; index++) {
    if (signal_checked(&list->items[index], fingerprint, signal) != 0) {
      return -1;
    }
    (*counter)++;
  }
  return 0;
}

static int sleep_scan_pause(void) {
  struct timespec delay = {.tv_sec = 0,
                           .tv_nsec = ZSR_SCAN_PAUSE_US * 1000L};
  while (nanosleep(&delay, &delay) != 0) {
    if (errno != EINTR) return -1;
  }
  return 0;
}

static int command_self_test(void) {
  zsr_process self;
  if (!process_info(getpid(), &self)) {
    fprintf(stderr, "process identity API unavailable\n");
    return 3;
  }
  int sandboxed = sandbox_check(getpid(), NULL, ZSR_SANDBOX_FILTER_NONE);
  if (sandboxed < 0) {
    fprintf(stderr, "Seatbelt inspection API unavailable\n");
    return 3;
  }
  printf("{\"version\":%d,\"platform\":\"darwin\","
         "\"processIdentity\":true,\"sandboxInspection\":true,"
         "\"callerSandboxed\":%s}\n",
         ZSR_HELPER_VERSION, sandboxed == 1 ? "true" : "false");
  return 0;
}

static int command_identity(int argc, char **argv) {
  if (argc != 3) return 2;
  uint64_t raw_pid;
  if (!parse_u64(argv[2], &raw_pid) || raw_pid == 0 || raw_pid > INT_MAX) {
    return 2;
  }
  zsr_process identity;
  if (!process_info((pid_t)raw_pid, &identity)) {
    fprintf(stderr, "process identity unavailable\n");
    return 4;
  }
  printf("{\"version\":%d,\"pid\":%d,\"uid\":%u,"
         "\"startSec\":\"%" PRIu64 "\",\"startUsec\":\"%" PRIu64
         "\"}\n",
         ZSR_HELPER_VERSION, identity.pid, identity.uid,
         identity.start_sec, identity.start_usec);
  return 0;
}

static int parse_fingerprint(int argc, char **argv, int start,
                             zsr_fingerprint *fingerprint, pid_t *target_pid) {
  const char *allow = NULL;
  const char *deny = NULL;
  uint64_t uid_value = UINT64_MAX;
  uint64_t excluded = 0;
  uint64_t target = 0;
  for (int index = start; index < argc; index++) {
    if (strcmp(argv[index], "--allow") == 0 && index + 1 < argc) {
      allow = argv[++index];
    } else if (strcmp(argv[index], "--deny") == 0 && index + 1 < argc) {
      deny = argv[++index];
    } else if (strcmp(argv[index], "--uid") == 0 && index + 1 < argc) {
      if (!parse_u64(argv[++index], &uid_value) || uid_value > UINT_MAX) {
        return -1;
      }
    } else if (strcmp(argv[index], "--exclude") == 0 && index + 1 < argc) {
      if (!parse_u64(argv[++index], &excluded) || excluded > INT_MAX) return -1;
    } else if (strcmp(argv[index], "--pid") == 0 && index + 1 < argc &&
               target_pid) {
      if (!parse_u64(argv[++index], &target) || target == 0 ||
          target > INT_MAX) {
        return -1;
      }
    } else {
      return -1;
    }
  }
  if (!allow || !deny || uid_value == UINT64_MAX ||
      (target_pid && target == 0)) {
    return -1;
  }
  static char allow_real[PATH_MAX];
  static char deny_real[PATH_MAX];
  if (!canonical_regular_file(allow, allow_real) ||
      !canonical_regular_file(deny, deny_real) ||
      strcmp(allow_real, deny_real) == 0) {
    return -1;
  }
  fingerprint->allow_path = allow_real;
  fingerprint->deny_path = deny_real;
  fingerprint->owner_uid = (uid_t)uid_value;
  fingerprint->excluded_pid = (pid_t)excluded;
  if (target_pid) *target_pid = (pid_t)target;
  return 0;
}

static int command_match(int argc, char **argv) {
  zsr_fingerprint fingerprint;
  pid_t target;
  if (parse_fingerprint(argc, argv, 2, &fingerprint, &target) != 0) return 2;
  zsr_process candidate;
  bool has_process = process_info(target, &candidate);
  bool eligible = has_process && candidate.pid > 1 &&
                  candidate.pid != getpid() &&
                  candidate.pid != fingerprint.excluded_pid &&
                  candidate.uid == fingerprint.owner_uid &&
                  candidate.status != SZOMB;
  int sandboxed =
      eligible
          ? sandbox_check(candidate.pid, NULL, ZSR_SANDBOX_FILTER_NONE)
          : -2;
  int allow_read =
      eligible ? path_decision(candidate.pid, "file-read-data",
                               fingerprint.allow_path)
               : -2;
  int allow_write =
      eligible ? path_decision(candidate.pid, "file-write-data",
                               fingerprint.allow_path)
               : -2;
  int deny_read = eligible ? path_decision(candidate.pid, "file-read-data",
                                            fingerprint.deny_path)
                           : -2;
  int deny_write =
      eligible ? path_decision(candidate.pid, "file-write-data",
                               fingerprint.deny_path)
               : -2;
  bool match = eligible && sandboxed == 1 && allow_read == 0 &&
               allow_write > 0 && deny_read > 0 && deny_write > 0;
  // The decision tuple contains no paths or process arguments. Keeping it in
  // the one-pid diagnostic makes a fail-closed admission actionable when a
  // future Seatbelt/SRT change alters one fingerprint operation.
  printf("{\"version\":%d,\"match\":%s,\"eligible\":%s,"
         "\"sandboxed\":%d,\"allowRead\":%d,\"allowWrite\":%d,"
         "\"denyRead\":%d,\"denyWrite\":%d}\n",
         ZSR_HELPER_VERSION, match ? "true" : "false",
         eligible ? "true" : "false", sandboxed, allow_read, allow_write,
         deny_read, deny_write);
  return match ? 0 : 4;
}

static int command_listeners(int argc, char **argv) {
  zsr_fingerprint fingerprint;
  if (parse_fingerprint(argc, argv, 2, &fingerprint, NULL) != 0) return 2;
  zsr_process_list processes;
  if (collect_matches(&fingerprint, &processes) != 0) {
    fprintf(stderr, "process-domain listener scan failed\n");
    return 4;
  }
  zsr_tcp_listener_list listeners = {0};
  int result = 0;
  for (size_t index = 0; index < processes.count; index++) {
    if (collect_process_tcp_listeners(&processes.items[index], &fingerprint,
                                      &listeners) != 0) {
      result = 4;
      break;
    }
  }
  free_process_list(&processes);
  if (result != 0) {
    fprintf(stderr, "process-domain listener scan failed\n");
    return result;
  }
  qsort(listeners.items, listeners.count, sizeof(zsr_tcp_listener),
        compare_tcp_listener);
  printf("{\"version\":%d,\"listeners\":[", ZSR_HELPER_VERSION);
  for (size_t index = 0; index < listeners.count; index++) {
    if (index > 0) putchar(',');
    printf("{\"port\":%u,\"ipv4\":%s,\"ipv6\":%s}",
           listeners.items[index].port,
           listeners.items[index].ipv4 ? "true" : "false",
           listeners.items[index].ipv6 ? "true" : "false");
  }
  printf("]}\n");
  return 0;
}

static int command_reap(int argc, char **argv) {
  zsr_fingerprint fingerprint;
  if (parse_fingerprint(argc, argv, 2, &fingerprint, NULL) != 0) return 2;

  uint64_t term_signals = 0;
  uint64_t stop_signals = 0;
  uint64_t kill_signals = 0;
  uint64_t matched_total = 0;
  int error_code = 0;

  uint64_t term_deadline = monotonic_millis() + ZSR_TERM_WINDOW_MS;
  do {
    zsr_process_list list;
    if (collect_matches(&fingerprint, &list) != 0) {
      error_code = errno ? errno : EIO;
      break;
    }
    matched_total += list.count;
    if (signal_list(&list, &fingerprint, SIGTERM, &term_signals) != 0) {
      error_code = errno ? errno : EIO;
    }
    free_process_list(&list);
    if (error_code || sleep_scan_pause() != 0) break;
  } while (monotonic_millis() < term_deadline);

  zsr_process_list previous = {0};
  bool stable = false;
  uint64_t freeze_deadline = monotonic_millis() + ZSR_FREEZE_WINDOW_MS;
  while (!error_code && monotonic_millis() < freeze_deadline) {
    zsr_process_list current;
    if (collect_matches(&fingerprint, &current) != 0) {
      error_code = errno ? errno : EIO;
      break;
    }
    matched_total += current.count;
    if (current.count == 0) {
      free_process_list(&previous);
      previous = current;
      stable = true;
      break;
    }
    if (signal_list(&current, &fingerprint, SIGSTOP, &stop_signals) != 0) {
      error_code = errno ? errno : EIO;
      free_process_list(&current);
      break;
    }
    if (same_process_set(&previous, &current)) {
      free_process_list(&previous);
      previous = current;
      stable = true;
      break;
    }
    free_process_list(&previous);
    previous = current;
    if (sleep_scan_pause() != 0) {
      error_code = errno ? errno : EIO;
      break;
    }
  }

  if (!error_code && !stable) error_code = ETIMEDOUT;
  if (!error_code && previous.count > 0 &&
      signal_list(&previous, &fingerprint, SIGKILL, &kill_signals) != 0) {
    error_code = errno ? errno : EIO;
  }
  free_process_list(&previous);

  size_t remaining = 0;
  unsigned empty_scans = 0;
  uint64_t kill_deadline = monotonic_millis() + ZSR_KILL_WINDOW_MS;
  while (!error_code && monotonic_millis() < kill_deadline) {
    zsr_process_list current;
    if (collect_matches(&fingerprint, &current) != 0) {
      error_code = errno ? errno : EIO;
      break;
    }
    remaining = current.count;
    matched_total += current.count;
    if (current.count == 0) {
      empty_scans++;
      free_process_list(&current);
      if (empty_scans >= 3) break;
    } else {
      empty_scans = 0;
      if (signal_list(&current, &fingerprint, SIGSTOP, &stop_signals) != 0 ||
          signal_list(&current, &fingerprint, SIGKILL, &kill_signals) != 0) {
        error_code = errno ? errno : EIO;
      }
      free_process_list(&current);
    }
    if (!error_code && sleep_scan_pause() != 0) {
      error_code = errno ? errno : EIO;
    }
  }
  if (!error_code && empty_scans < 3) error_code = ETIMEDOUT;

  printf("{\"version\":%d,\"matched\":%" PRIu64
         ",\"termSignals\":%" PRIu64 ",\"stopSignals\":%" PRIu64
         ",\"killSignals\":%" PRIu64 ",\"remaining\":%zu,"
         "\"provedEmpty\":%s}\n",
         ZSR_HELPER_VERSION, matched_total, term_signals, stop_signals,
         kill_signals, remaining,
         (!error_code && empty_scans >= 3) ? "true" : "false");
  if (error_code) {
    fprintf(stderr, "process-domain teardown failed (%d)\n", error_code);
    return 4;
  }
  return 0;
}

static void usage(void) {
  fprintf(stderr,
          "usage: zsr-macos-process-domain self-test | identity PID | "
          "match/listeners/reap --allow PATH --deny PATH --uid UID "
          "[--exclude PID] [--pid PID]\n");
}

int main(int argc, char **argv) {
  if (argc < 2) {
    usage();
    return 2;
  }
  if (strcmp(argv[1], "self-test") == 0 && argc == 2) {
    return command_self_test();
  }
  if (strcmp(argv[1], "identity") == 0) return command_identity(argc, argv);
  if (strcmp(argv[1], "match") == 0) return command_match(argc, argv);
  if (strcmp(argv[1], "listeners") == 0) {
    return command_listeners(argc, argv);
  }
  if (strcmp(argv[1], "reap") == 0) return command_reap(argc, argv);
  usage();
  return 2;
}
