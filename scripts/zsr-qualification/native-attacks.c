#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#elif defined(__APPLE__)
#include <stdio.h>
#ifndef RENAME_SWAP
#define RENAME_SWAP 0x00000002
#endif
#endif

static int write_all(int fd, const char *value) {
  size_t remaining = strlen(value);
  while (remaining > 0) {
    ssize_t written = write(fd, value, remaining);
    if (written < 0) return -1;
    value += written;
    remaining -= (size_t)written;
  }
  return 0;
}

static int attack_openat(const char *design) {
  int directory = open(design, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory < 0) return 2;
  int target = openat(directory, "tracked.txt", O_WRONLY | O_TRUNC | O_CLOEXEC);
  int saved = errno;
  close(directory);
  errno = saved;
  if (target < 0) return 3;
  int result = write_all(target, "openat mutation\n");
  close(target);
  return result == 0 ? 0 : 4;
}

static int attack_openat_create(const char *design) {
  int directory = open(design, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory < 0) return 2;
  int target = openat(
      directory,
      "openat-created.txt",
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
      0600);
  int saved = errno;
  close(directory);
  errno = saved;
  if (target < 0) return 3;
  int result = write_all(target, "openat create mutation\n");
  close(target);
  return result == 0 ? 0 : 4;
}

static int attack_mmap(const char *target_path) {
  int target = open(target_path, O_RDWR | O_CLOEXEC);
  if (target < 0) return 2;
  struct stat metadata;
  if (fstat(target, &metadata) != 0 || metadata.st_size < 1) {
    close(target);
    return 3;
  }
  void *mapped = mmap(
      NULL,
      (size_t)metadata.st_size,
      PROT_READ | PROT_WRITE,
      MAP_SHARED,
      target,
      0);
  if (mapped == MAP_FAILED) {
    close(target);
    return 4;
  }
  ((char *)mapped)[0] = 'M';
  int result = msync(mapped, (size_t)metadata.st_size, MS_SYNC);
  munmap(mapped, (size_t)metadata.st_size);
  close(target);
  return result == 0 ? 0 : 5;
}

static int attack_exchange(const char *left, const char *right) {
#if defined(__linux__)
  return syscall(
             SYS_renameat2,
             AT_FDCWD,
             left,
             AT_FDCWD,
             right,
             RENAME_EXCHANGE) == 0
             ? 0
             : 2;
#elif defined(__APPLE__)
  return renameatx_np(AT_FDCWD, left, AT_FDCWD, right, RENAME_SWAP) == 0 ? 0
                                                                            : 2;
#else
  (void)left;
  (void)right;
  errno = ENOTSUP;
  return 2;
#endif
}

int main(int argc, char **argv) {
  if (argc < 3) return 64;
  if (strcmp(argv[1], "openat") == 0 && argc == 3) {
    return attack_openat(argv[2]);
  }
  if (strcmp(argv[1], "openat-create") == 0 && argc == 3) {
    return attack_openat_create(argv[2]);
  }
  if (strcmp(argv[1], "mmap") == 0 && argc == 3) {
    return attack_mmap(argv[2]);
  }
  if (strcmp(argv[1], "rename-exchange") == 0 && argc == 4) {
    return attack_exchange(argv[2], argv[3]);
  }
  return 64;
}
