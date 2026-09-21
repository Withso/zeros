/* Trusted outer lifetime owner for a private PID namespace. Not setuid.
 * A disappearing PGID is not proof: detached descendants are adopted here,
 * and the private receipt is written only after waitpid reports ECHILD.
 * TERM requests destruction of the namespace launcher, never of this reaper.
 * If reaping cannot complete, the engine must quarantine the entire worker.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail(void) { _exit(125); }

int main(int argc, char **argv) {
  if (argc < 5 || argv[1][0] != '/' || strcmp(argv[3], "--") || argv[4][0] != '/') fail();
  char *end;
  long owner = strtol(argv[2], &end, 10);
  if (*end || owner <= 1 || owner != getppid() ||
      prctl(PR_SET_CHILD_SUBREAPER, 1L) || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != owner) fail();
  char directory[4096];
  size_t length = strlen(argv[1]);
  if (length >= sizeof(directory)) fail();
  memcpy(directory, argv[1], length + 1);
  char *leaf = strrchr(directory, '/');
  if (!leaf || strlen(leaf + 1) != 32 || strspn(leaf + 1, "0123456789abcdef") != 32) fail();
  *leaf = '\0';
  int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat metadata;
  if (parent < 0 || fstat(parent, &metadata) || metadata.st_uid != geteuid() || (metadata.st_mode & 0077)) fail();
  /* Synchronous blocked signals avoid the stop-before-wait lost wakeup.
   * Explicitly restore waitable children if our caller ignored CHLD. */
  struct sigaction action = { .sa_handler = SIG_DFL };
  if (sigemptyset(&action.sa_mask) || sigaction(SIGCHLD, &action, NULL) ||
      sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) ||
      sigaction(SIGHUP, &action, NULL)) fail();
  sigset_t events, empty;
  if (sigemptyset(&events) || sigemptyset(&empty) || sigaddset(&events, SIGCHLD) ||
      sigaddset(&events, SIGTERM) || sigaddset(&events, SIGINT) ||
      sigaddset(&events, SIGHUP) || sigprocmask(SIG_SETMASK, &events, NULL)) fail();
  /* The engine may signal only after this private ready marker exists. */
  int receipt = openat(parent, leaf + 1, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (receipt < 0 || close(parent)) fail();
  pid_t self = getpid(), child = fork();
  if (child < 0) fail();
  if (child == 0) {
    close(receipt);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != self) fail();
    if (sigprocmask(SIG_SETMASK, &empty, NULL)) fail();
    execv(argv[4], &argv[4]);
    fail();
  }
  int primary_status = 125 << 8, primary_alive = 1, stopping = 0;
  for (;;) {
    if (stopping && primary_alive) {
      /* The unreaped direct child PID cannot be reused. bwrap's parent-death
       * contract kills PID 1; the kernel kills every namespace descendant. */
      if (kill(child, SIGKILL) && errno != ESRCH) fail();
    }
    int status;
    pid_t reaped = waitpid(-1, &status, WNOHANG);
    if (reaped == child) { primary_status = status; primary_alive = 0; }
    else if (reaped < 0) {
      if (errno == EINTR) continue;
      if (errno != ECHILD) fail();
      break;
    }
    else if (reaped == 0) {
      int event = sigwaitinfo(&events, NULL);
      if (event == SIGTERM || event == SIGINT || event == SIGHUP) stopping = 1;
      else if (event < 0 && errno != EINTR) fail();
    }
  }
  const char proof[] = "zeros-process-domain-reaped-v1\n";
  if (write(receipt, proof, sizeof(proof) - 1) != (ssize_t)(sizeof(proof) - 1) ||
      fsync(receipt) || close(receipt)) fail();
  return WIFEXITED(primary_status) ? WEXITSTATUS(primary_status) :
    WIFSIGNALED(primary_status) ? 128 + WTERMSIG(primary_status) : 125;
}
