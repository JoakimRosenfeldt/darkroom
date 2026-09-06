#define _POSIX_C_SOURCE 200809L
#if defined(__linux__)
#define _GNU_SOURCE 1
#endif
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE 1
#endif

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif

#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#ifndef NAME_MAX
#define NAME_MAX 255
#endif

enum {
  OUTPUT_BUFFER_SIZE = 1024 * 1024,
  PAUSE_TIMEOUT_SECONDS = 300,
  ATOMIC_WRITE_LIMIT = 16 * 1024 * 1024,
};

typedef struct {
  int fd;
  char name[NAME_MAX + 1];
} parent_ref;

static const char *error_name(int error_number) {
  switch (error_number) {
    case EACCES: return "EACCES";
    case EEXIST: return "EEXIST";
    case EINTR: return "EINTR";
    case EINVAL: return "EINVAL";
    case ELOOP: return "ELOOP";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case ENOSPC: return "ENOSPC";
    case EPERM: return "EPERM";
    case EROFS: return "EROFS";
    case EXDEV: return "EXDEV";
    default: return "IO";
  }
}

static int fail_name(const char *name) {
  if (name == NULL || name[0] == '\0') name = "IO";
  (void)dprintf(STDERR_FILENO, "ERR %.32s\n", name);
  return 1;
}

static int fail_errno(void) {
  return fail_name(error_name(errno));
}

static int fail_invalid(void) {
  return fail_name("INVALID_ARGUMENT");
}

static int fail_unsafe(void) {
  return fail_name("UNSAFE");
}

static int is_component_valid(const char *component, size_t length) {
  if (length == 0 || length > NAME_MAX) return 0;
  if (length == 1 && component[0] == '.') return 0;
  if (length == 2 && component[0] == '.' && component[1] == '.') return 0;
  return 1;
}

static int validate_absolute_path(const char *file_path, int allow_root) {
  size_t length;
  size_t start;

  if (file_path == NULL || file_path[0] != '/') return 0;
  length = strlen(file_path);
  if (length == 0 || length >= PATH_MAX) return 0;
  if (length == 1) return allow_root;
  if (file_path[length - 1] == '/') return 0;
  start = 1;
  while (start < length) {
    size_t end = start;
    while (end < length && file_path[end] != '/') end += 1;
    if (!is_component_valid(file_path + start, end - start)) return 0;
    if (end < length && file_path[end + 1] == '/') return 0;
    start = end + 1;
  }
  return 1;
}

static int open_root(void) {
  int flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
  int fd;
  do {
    fd = open("/", flags);
  } while (fd < 0 && errno == EINTR);
  return fd;
}

static int open_child_directory(int parent_fd, const char *name, size_t length) {
  char component[NAME_MAX + 1];
  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
  int fd;
  if (!is_component_valid(name, length)) {
    errno = EINVAL;
    return -1;
  }
  memcpy(component, name, length);
  component[length] = '\0';
  do {
    fd = openat(parent_fd, component, flags);
  } while (fd < 0 && errno == EINTR);
  return fd;
}

static int open_parent(const char *file_path, parent_ref *parent) {
  const char *cursor;
  const char *last_slash;
  size_t parent_length;
  int current_fd;

  if (!validate_absolute_path(file_path, 0) || parent == NULL) return fail_invalid();
  last_slash = strrchr(file_path, '/');
  if (last_slash == NULL || last_slash[1] == '\0') return fail_invalid();
  if (!is_component_valid(last_slash + 1, strlen(last_slash + 1))) return fail_invalid();
  if (strlen(last_slash + 1) > NAME_MAX) return fail_invalid();
  memcpy(parent->name, last_slash + 1, strlen(last_slash + 1) + 1);
  parent_length = (size_t)(last_slash - file_path);
  current_fd = open_root();
  if (current_fd < 0) return fail_errno();

  cursor = file_path + 1;
  while ((size_t)(cursor - file_path) < parent_length) {
    const char *slash = strchr(cursor, '/');
    size_t component_length;
    int next_fd;
    if (slash == NULL || (size_t)(slash - file_path) >= parent_length) {
      component_length = parent_length - (size_t)(cursor - file_path);
    } else {
      component_length = (size_t)(slash - cursor);
    }
    if (!is_component_valid(cursor, component_length)) {
      close(current_fd);
      return fail_invalid();
    }
    next_fd = open_child_directory(current_fd, cursor, component_length);
    if (next_fd < 0) {
      int error_number = errno;
      close(current_fd);
      errno = error_number;
      if (error_number == ELOOP || error_number == ENOTDIR) return fail_unsafe();
      return fail_errno();
    }
    close(current_fd);
    current_fd = next_fd;
    cursor += component_length;
    if ((size_t)(cursor - file_path) < parent_length) {
      if (*cursor != '/') {
        close(current_fd);
        return fail_invalid();
      }
      cursor += 1;
    }
  }
  parent->fd = current_fd;
  return 0;
}

static int open_or_create_directory(int parent_fd, const char *name, size_t length) {
  char component[NAME_MAX + 1];
  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
  int fd;
  if (!is_component_valid(name, length)) {
    errno = EINVAL;
    return -1;
  }
  memcpy(component, name, length);
  component[length] = '\0';
  do {
    fd = openat(parent_fd, component, flags);
  } while (fd < 0 && errno == EINTR);
  if (fd >= 0) return fd;
  if (errno != ENOENT) return -1;
  do {
    fd = mkdirat(parent_fd, component, 0700);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0 && errno != EEXIST) return -1;
  do {
    fd = openat(parent_fd, component, flags);
  } while (fd < 0 && errno == EINTR);
  return fd;
}

static int mkdir_recursive(const char *directory_path) {
  const char *cursor;
  size_t length;
  int current_fd;
  if (!validate_absolute_path(directory_path, 1)) return fail_invalid();
  if (strcmp(directory_path, "/") == 0) return 0;
  length = strlen(directory_path);
  current_fd = open_root();
  if (current_fd < 0) return fail_errno();
  cursor = directory_path + 1;
  while ((size_t)(cursor - directory_path) < length) {
    const char *slash = strchr(cursor, '/');
    size_t component_length = slash == NULL
      ? length - (size_t)(cursor - directory_path)
      : (size_t)(slash - cursor);
    int next_fd;
    if (!is_component_valid(cursor, component_length)) {
      close(current_fd);
      return fail_invalid();
    }
    next_fd = open_or_create_directory(current_fd, cursor, component_length);
    if (next_fd < 0) {
      int error_number = errno;
      close(current_fd);
      errno = error_number;
      if (error_number == ELOOP || error_number == ENOTDIR) return fail_unsafe();
      return fail_errno();
    }
    close(current_fd);
    current_fd = next_fd;
    cursor += component_length;
    if ((size_t)(cursor - directory_path) < length) cursor += 1;
  }
  close(current_fd);
  return 0;
}

static int stat_regular_at(int parent_fd, const char *name, struct stat *stat_buffer, int missing_ok) {
  int result;
  do {
    result = fstatat(parent_fd, name, stat_buffer, AT_SYMLINK_NOFOLLOW);
  } while (result < 0 && errno == EINTR);
  if (result < 0 && missing_ok && errno == ENOENT) return 1;
  if (result < 0) return -1;
  if (S_ISLNK(stat_buffer->st_mode) || !S_ISREG(stat_buffer->st_mode)) {
    errno = EINVAL;
    return -2;
  }
  return 0;
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int64_t stat_mtime_ns(const struct stat *stat_buffer) {
#if defined(__APPLE__)
  return (int64_t)stat_buffer->st_mtimespec.tv_sec * INT64_C(1000000000) +
    (int64_t)stat_buffer->st_mtimespec.tv_nsec;
#else
  return (int64_t)stat_buffer->st_mtim.tv_sec * INT64_C(1000000000) +
    (int64_t)stat_buffer->st_mtim.tv_nsec;
#endif
}

static int64_t stat_ctime_ns(const struct stat *stat_buffer) {
#if defined(__APPLE__)
  return (int64_t)stat_buffer->st_ctimespec.tv_sec * INT64_C(1000000000) +
    (int64_t)stat_buffer->st_ctimespec.tv_nsec;
#else
  return (int64_t)stat_buffer->st_ctim.tv_sec * INT64_C(1000000000) +
    (int64_t)stat_buffer->st_ctim.tv_nsec;
#endif
}

static int same_stable_file(const struct stat *left, const struct stat *right) {
  return same_identity(left, right) &&
    left->st_size == right->st_size &&
    stat_mtime_ns(left) == stat_mtime_ns(right) &&
    stat_ctime_ns(left) == stat_ctime_ns(right);
}

static int same_published_file(const struct stat *left, const struct stat *right) {
  return same_identity(left, right) &&
    left->st_size == right->st_size &&
    stat_mtime_ns(left) == stat_mtime_ns(right);
}

static void print_observation(const char *prefix, const struct stat *stat_buffer) {
  (void)dprintf(
    STDERR_FILENO,
    "%s %ju %ju %jd %" PRId64 "\n",
    prefix,
    (uintmax_t)stat_buffer->st_dev,
    (uintmax_t)stat_buffer->st_ino,
    (intmax_t)stat_buffer->st_size,
    stat_mtime_ns(stat_buffer)
  );
}

static int write_all(int fd, const void *buffer, size_t length) {
  const unsigned char *bytes = (const unsigned char *)buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return 0;
}

static int parse_identity(const char *value, uintmax_t *result) {
  char *end = NULL;
  uintmax_t parsed;
  if (value == NULL || value[0] == '\0') return 0;
  errno = 0;
  parsed = strtoumax(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') return 0;
  *result = parsed;
  return 1;
}

static int read_stdin_to_file(int file_fd) {
  unsigned char buffer[64 * 1024];
  size_t total = 0;
  for (;;) {
    ssize_t count;
    do {
      count = read(STDIN_FILENO, buffer, sizeof(buffer));
    } while (count < 0 && errno == EINTR);
    if (count < 0) return -1;
    if (count == 0) return 0;
    if ((size_t)count > ATOMIC_WRITE_LIMIT - total) {
      errno = EFBIG;
      return -1;
    }
    if (write_all(file_fd, buffer, (size_t)count) < 0) return -1;
    total += (size_t)count;
  }
}

static int temporary_name(char *buffer, size_t length, const char *suffix, unsigned int attempt) {
  int written = snprintf(
    buffer,
    length,
    ".darkroom-atomic-%jd-%u.%s",
    (intmax_t)getpid(),
    attempt,
    suffix
  );
  return written > 0 && (size_t)written < length;
}

static int rename_no_replace_at(int directory_fd, const char *source, const char *destination) {
#if defined(__APPLE__)
  return renameatx_np(directory_fd, source, directory_fd, destination, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, directory_fd, source, directory_fd, destination, RENAME_NOREPLACE);
#else
  if (linkat(directory_fd, source, directory_fd, destination, 0) < 0) return -1;
  if (unlinkat(directory_fd, source, 0) == 0) return 0;
  {
    int unlink_error = errno;
    (void)unlinkat(directory_fd, destination, 0);
    errno = unlink_error;
    return -1;
  }
#endif
}

static int rename_exchange_at(int directory_fd, const char *left, const char *right) {
#if defined(__APPLE__)
  return renameatx_np(directory_fd, left, directory_fd, right, RENAME_SWAP);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, directory_fd, left, directory_fd, right, RENAME_EXCHANGE);
#else
  (void)directory_fd;
  (void)left;
  (void)right;
  errno = ENOTSUP;
  return -1;
#endif
}

static int copy_fd(int source_fd, int destination_fd, off_t size) {
  unsigned char *buffer = malloc(OUTPUT_BUFFER_SIZE);
  off_t offset = 0;
  if (buffer == NULL) {
    errno = ENOMEM;
    return -1;
  }
  while (offset < size) {
    size_t requested = (size_t)((size - offset) > OUTPUT_BUFFER_SIZE ? OUTPUT_BUFFER_SIZE : (size - offset));
    ssize_t bytes_read;
    do {
      bytes_read = pread(source_fd, buffer, requested, offset);
    } while (bytes_read < 0 && errno == EINTR);
    if (bytes_read <= 0) {
      free(buffer);
      if (bytes_read == 0) errno = EIO;
      return -1;
    }
    if (write_all(destination_fd, buffer, (size_t)bytes_read) < 0) {
      free(buffer);
      return -1;
    }
    offset += bytes_read;
  }
  free(buffer);
  return 0;
}

static int maybe_pause_after_parents(void) {
  const char *ready_path = getenv("DARKROOM_FILE_TRANSACTION_TEST_PAUSE_READY");
  const char *resume_path = getenv("DARKROOM_FILE_TRANSACTION_TEST_PAUSE_RESUME");
  struct timespec delay;
  int ready_fd;
  time_t started;

  if (ready_path == NULL || resume_path == NULL || ready_path[0] == '\0' || resume_path[0] == '\0') return 0;
  if (!validate_absolute_path(ready_path, 0) || !validate_absolute_path(resume_path, 0)) return fail_invalid();
  ready_fd = open(ready_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (ready_fd < 0) return fail_errno();
  if (write_all(ready_fd, "ready\n", 6) < 0) {
    int error_number = errno;
    close(ready_fd);
    errno = error_number;
    return fail_errno();
  }
  close(ready_fd);
  delay.tv_sec = 0;
  delay.tv_nsec = 10000000L;
  started = time(NULL);
  while (access(resume_path, F_OK) != 0) {
    if (errno != ENOENT && errno != EINTR) return fail_errno();
    if (time(NULL) - started >= PAUSE_TIMEOUT_SECONDS) return fail_name("PAUSE_TIMEOUT");
    nanosleep(&delay, NULL);
  }
  return 0;
}

static int command_exists(const char *file_path) {
  parent_ref parent;
  struct stat stat_buffer;
  int result;
  if (open_parent(file_path, &parent) != 0) {
    if (errno == ENOENT) {
      (void)dprintf(STDOUT_FILENO, "EXISTS 0\n");
      return 0;
    }
    return 1;
  }
  result = fstatat(parent.fd, parent.name, &stat_buffer, AT_SYMLINK_NOFOLLOW);
  close(parent.fd);
  if (result < 0) {
    if (errno == ENOENT) {
      (void)dprintf(STDOUT_FILENO, "EXISTS 0\n");
      return 0;
    }
    return fail_errno();
  }
  (void)dprintf(STDOUT_FILENO, "EXISTS 1\n");
  return 0;
}

static int command_observe(const char *file_path) {
  parent_ref parent;
  struct stat link_stat;
  struct stat opened_stat;
  int file_fd;
  if (open_parent(file_path, &parent) != 0) return 1;
  if (stat_regular_at(parent.fd, parent.name, &link_stat, 0) != 0) {
    int result = errno == EINVAL ? fail_unsafe() : fail_errno();
    close(parent.fd);
    return result;
  }
  do {
    file_fd = openat(parent.fd, parent.name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  } while (file_fd < 0 && errno == EINTR);
  if (file_fd < 0) {
    int result = fail_errno();
    close(parent.fd);
    return result;
  }
  if (fstat(file_fd, &opened_stat) < 0) {
    int result = fail_errno();
    close(file_fd);
    close(parent.fd);
    return result;
  }
  if (!same_identity(&link_stat, &opened_stat)) {
    close(file_fd);
    close(parent.fd);
    return fail_name("CHANGED");
  }
  if (fstatat(parent.fd, parent.name, &link_stat, AT_SYMLINK_NOFOLLOW) < 0 ||
      !same_identity(&opened_stat, &link_stat)) {
    close(file_fd);
    close(parent.fd);
    return fail_name("CHANGED");
  }
  print_observation("OBS", &opened_stat);
  close(file_fd);
  close(parent.fd);
  return 0;
}

static int command_digest(const char *file_path) {
  parent_ref parent;
  struct stat link_stat;
  struct stat before;
  struct stat after;
  int file_fd;
  unsigned char *buffer;
  off_t offset = 0;
  if (open_parent(file_path, &parent) != 0) return 1;
  if (stat_regular_at(parent.fd, parent.name, &link_stat, 0) != 0) {
    int result = errno == EINVAL ? fail_unsafe() : fail_errno();
    close(parent.fd);
    return result;
  }
  do {
    file_fd = openat(parent.fd, parent.name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  } while (file_fd < 0 && errno == EINTR);
  if (file_fd < 0) {
    int result = fail_errno();
    close(parent.fd);
    return result;
  }
  if (fstat(file_fd, &before) < 0 || !S_ISREG(before.st_mode) || !same_identity(&link_stat, &before)) {
    int result = fail_name("CHANGED");
    close(file_fd);
    close(parent.fd);
    return result;
  }
  buffer = malloc(OUTPUT_BUFFER_SIZE);
  if (buffer == NULL) {
    close(file_fd);
    close(parent.fd);
    return fail_name("IO");
  }
  while (offset < before.st_size) {
    size_t requested = (size_t)((before.st_size - offset) > OUTPUT_BUFFER_SIZE ? OUTPUT_BUFFER_SIZE : (before.st_size - offset));
    ssize_t bytes_read;
    do {
      bytes_read = pread(file_fd, buffer, requested, offset);
    } while (bytes_read < 0 && errno == EINTR);
    if (bytes_read <= 0 || write_all(STDOUT_FILENO, buffer, (size_t)bytes_read) < 0) {
      int error_number = bytes_read < 0 ? errno : EIO;
      free(buffer);
      close(file_fd);
      close(parent.fd);
      errno = error_number;
      return fail_errno();
    }
    offset += bytes_read;
  }
  free(buffer);
  if (fstat(file_fd, &after) < 0 || !same_stable_file(&before, &after)) {
    close(file_fd);
    close(parent.fd);
    return fail_name("CHANGED");
  }
  print_observation("META", &after);
  close(file_fd);
  close(parent.fd);
  return 0;
}

static int command_copy(const char *source_path, const char *destination_path) {
  parent_ref source_parent;
  parent_ref destination_parent;
  struct stat source_link;
  struct stat source_before;
  struct stat source_after;
  struct stat destination_stat;
  int source_fd = -1;
  int destination_fd = -1;
  int destination_stat_valid = 0;
  int result = 1;

  if (open_parent(source_path, &source_parent) != 0) return 1;
  if (stat_regular_at(source_parent.fd, source_parent.name, &source_link, 0) != 0) {
    result = errno == EINVAL ? fail_unsafe() : fail_errno();
    close(source_parent.fd);
    return result;
  }
  do {
    source_fd = openat(source_parent.fd, source_parent.name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  } while (source_fd < 0 && errno == EINTR);
  if (source_fd < 0) {
    result = fail_errno();
    close(source_parent.fd);
    return result;
  }
  if (fstat(source_fd, &source_before) < 0 || !S_ISREG(source_before.st_mode) || !same_identity(&source_link, &source_before)) {
    result = fail_name("CHANGED");
    goto cleanup;
  }
  if (open_parent(destination_path, &destination_parent) != 0) goto cleanup;
  if (maybe_pause_after_parents() != 0) goto cleanup_destination;
  do {
    destination_fd = openat(
      destination_parent.fd,
      destination_parent.name,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      0600
    );
  } while (destination_fd < 0 && errno == EINTR);
  if (destination_fd < 0) goto cleanup_destination;
  if (fstat(destination_fd, &destination_stat) < 0) goto cleanup_destination_file;
  destination_stat_valid = 1;
  if (copy_fd(source_fd, destination_fd, source_before.st_size) < 0) goto cleanup_destination_file;
  if (fsync(destination_fd) < 0) goto cleanup_destination_file;
  if (fstat(source_fd, &source_after) < 0 || !same_stable_file(&source_before, &source_after)) {
    result = fail_name("CHANGED");
    goto cleanup_destination_file;
  }
  if (fstat(destination_fd, &destination_stat) < 0 ||
      !S_ISREG(destination_stat.st_mode) ||
      destination_stat.st_size != source_before.st_size) {
    result = fail_name("CHANGED");
    goto cleanup_destination_file;
  }
  close(destination_fd);
  destination_fd = -1;
  close(destination_parent.fd);
  close(source_fd);
  close(source_parent.fd);
  (void)dprintf(STDOUT_FILENO, "OK\n");
  return 0;

cleanup_destination_file:
  if (destination_fd >= 0) {
    int saved_errno = errno;
    struct stat current;
    close(destination_fd);
    destination_fd = -1;
    if (destination_stat_valid &&
        fstatat(destination_parent.fd, destination_parent.name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
        same_identity(&destination_stat, &current) && S_ISREG(current.st_mode)) {
      (void)unlinkat(destination_parent.fd, destination_parent.name, 0);
    }
    errno = saved_errno;
  }
cleanup_destination:
  close(destination_parent.fd);
cleanup:
  close(source_fd);
  close(source_parent.fd);
  if (result == 1) return fail_errno();
  return result;
}

static int command_rename(const char *source_path, const char *destination_path) {
  parent_ref source_parent;
  parent_ref destination_parent;
  struct stat source_stat;
  struct stat destination_stat;
  int destination_result;
  int result;

  if (open_parent(source_path, &source_parent) != 0) return 1;
  if (stat_regular_at(source_parent.fd, source_parent.name, &source_stat, 0) != 0) {
    result = errno == EINVAL ? fail_unsafe() : fail_errno();
    close(source_parent.fd);
    return result;
  }
  if (open_parent(destination_path, &destination_parent) != 0) {
    close(source_parent.fd);
    return 1;
  }
  destination_result = fstatat(destination_parent.fd, destination_parent.name, &destination_stat, AT_SYMLINK_NOFOLLOW);
  if (destination_result < 0 && errno != ENOENT) {
    result = fail_errno();
    close(destination_parent.fd);
    close(source_parent.fd);
    return result;
  }
  if (destination_result == 0 && (S_ISLNK(destination_stat.st_mode) || !S_ISREG(destination_stat.st_mode))) {
    close(destination_parent.fd);
    close(source_parent.fd);
    return fail_unsafe();
  }
  result = maybe_pause_after_parents();
  if (result != 0) {
    close(destination_parent.fd);
    close(source_parent.fd);
    return result;
  }
  do {
    result = renameat(source_parent.fd, source_parent.name, destination_parent.fd, destination_parent.name);
  } while (result < 0 && errno == EINTR);
  close(destination_parent.fd);
  close(source_parent.fd);
  if (result < 0) return fail_errno();
  (void)dprintf(STDOUT_FILENO, "OK\n");
  return 0;
}

static int command_remove(const char *file_path) {
  parent_ref parent;
  struct stat stat_buffer;
  int result;
  if (open_parent(file_path, &parent) != 0) {
    if (errno == ENOENT) return 0;
    return 1;
  }
  result = fstatat(parent.fd, parent.name, &stat_buffer, AT_SYMLINK_NOFOLLOW);
  if (result < 0) {
    int error_number = errno;
    close(parent.fd);
    if (error_number == ENOENT) return 0;
    errno = error_number;
    return fail_errno();
  }
  if (S_ISLNK(stat_buffer.st_mode) || !S_ISREG(stat_buffer.st_mode)) {
    close(parent.fd);
    return fail_unsafe();
  }
  do {
    result = unlinkat(parent.fd, parent.name, 0);
  } while (result < 0 && errno == EINTR);
  close(parent.fd);
  if (result < 0 && errno == ENOENT) return 0;
  if (result < 0) return fail_errno();
  (void)dprintf(STDOUT_FILENO, "OK\n");
  return 0;
}

static int command_atomic_write(
  const char *file_path,
  const char *expected_device,
  const char *expected_inode,
  const char *mode
) {
  parent_ref parent;
  struct stat parent_stat;
  struct stat existing_stat;
  struct stat displaced_stat;
  uintmax_t device;
  uintmax_t inode;
  char temporary[NAME_MAX + 1];
  int replace;
  int existing;
  int file_fd = -1;
  int temporary_created = 0;
  int published = 0;
  int exchanged = 0;
  int failure_reported = 0;
  unsigned int attempt;

  if (!parse_identity(expected_device, &device) || !parse_identity(expected_inode, &inode)) return fail_invalid();
  if (strcmp(mode, "exclusive") == 0) replace = 0;
  else if (strcmp(mode, "replace") == 0) replace = 1;
  else return fail_invalid();
  if (open_parent(file_path, &parent) != 0) return 1;
  if (fstat(parent.fd, &parent_stat) < 0) goto cleanup;
  if ((uintmax_t)parent_stat.st_dev != device || (uintmax_t)parent_stat.st_ino != inode) {
    (void)fail_name("CHANGED");
    failure_reported = 1;
    goto cleanup;
  }
  if (maybe_pause_after_parents() != 0) goto cleanup;
  existing = stat_regular_at(parent.fd, parent.name, &existing_stat, 1);
  if (existing < 0) {
    if (existing == -2) (void)fail_unsafe();
    else (void)fail_errno();
    failure_reported = 1;
    goto cleanup;
  }
  if (!replace && existing == 0) {
    (void)fail_name("EEXIST");
    failure_reported = 1;
    goto cleanup;
  }

  for (attempt = 0; attempt < 100; attempt += 1) {
    if (!temporary_name(temporary, sizeof(temporary), "tmp", attempt)) {
      (void)fail_invalid();
      failure_reported = 1;
      goto cleanup;
    }
    do {
      file_fd = openat(parent.fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    } while (file_fd < 0 && errno == EINTR);
    if (file_fd >= 0) break;
    if (errno != EEXIST) goto cleanup;
  }
  if (file_fd < 0) {
    errno = EEXIST;
    goto cleanup;
  }
  temporary_created = 1;
  if (read_stdin_to_file(file_fd) < 0 || fsync(file_fd) < 0) goto cleanup;
  if (close(file_fd) < 0) {
    file_fd = -1;
    goto cleanup;
  }
  file_fd = -1;

  if (replace && existing == 0) {
    do {
      published = rename_exchange_at(parent.fd, temporary, parent.name);
    } while (published < 0 && errno == EINTR);
    if (published < 0) goto cleanup;
    published = 1;
    exchanged = 1;
    if (stat_regular_at(parent.fd, temporary, &displaced_stat, 0) != 0 ||
        !same_published_file(&existing_stat, &displaced_stat)) {
      int changed_error = errno;
      int rollback;
      do {
        rollback = rename_exchange_at(parent.fd, temporary, parent.name);
      } while (rollback < 0 && errno == EINTR);
      if (rollback < 0 || fsync(parent.fd) < 0) {
        (void)fail_name("ROLLBACK");
      } else {
        (void)fail_name("CHANGED");
      }
      failure_reported = 1;
      published = 0;
      exchanged = 0;
      errno = changed_error;
      goto cleanup;
    }
  } else {
    int publish_result;
    do {
      publish_result = rename_no_replace_at(parent.fd, temporary, parent.name);
    } while (publish_result < 0 && errno == EINTR);
    if (publish_result < 0) goto cleanup;
    published = 1;
    temporary_created = 0;
  }

  if (fsync(parent.fd) < 0) {
    int publish_error = errno;
    int rollback_result;
    if (exchanged) {
      do {
        rollback_result = rename_exchange_at(parent.fd, temporary, parent.name);
      } while (rollback_result < 0 && errno == EINTR);
      if (rollback_result == 0) exchanged = 0;
    } else {
      do {
        rollback_result = renameat(parent.fd, parent.name, parent.fd, temporary);
      } while (rollback_result < 0 && errno == EINTR);
      if (rollback_result == 0) temporary_created = 1;
    }
    if (rollback_result < 0 || fsync(parent.fd) < 0) {
      (void)fail_name("ROLLBACK");
      failure_reported = 1;
      goto cleanup;
    }
    published = 0;
    errno = publish_error;
    goto cleanup;
  }
  if (exchanged) {
    int cleanup_result;
    do {
      cleanup_result = unlinkat(parent.fd, temporary, 0);
    } while (cleanup_result < 0 && errno == EINTR);
    if (cleanup_result < 0 || fsync(parent.fd) < 0) {
      (void)fail_name("CLEANUP");
      failure_reported = 1;
      goto cleanup;
    }
    temporary_created = 0;
    exchanged = 0;
  }
  close(parent.fd);
  (void)dprintf(STDOUT_FILENO, "OK\n");
  return 0;

cleanup:
  if (file_fd >= 0) close(file_fd);
  if (temporary_created && !exchanged) (void)unlinkat(parent.fd, temporary, 0);
  close(parent.fd);
  if (failure_reported) return 1;
  return fail_errno();
}

static int dispatch(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "exists") == 0 && argc == 3) return command_exists(argv[2]);
  if (argc >= 2 && strcmp(argv[1], "mkdir") == 0 && argc == 3) return mkdir_recursive(argv[2]);
  if (argc >= 2 && strcmp(argv[1], "copy") == 0 && argc == 4) return command_copy(argv[2], argv[3]);
  if (argc >= 2 && strcmp(argv[1], "rename") == 0 && argc == 4) return command_rename(argv[2], argv[3]);
  if (argc >= 2 && strcmp(argv[1], "remove") == 0 && argc == 3) return command_remove(argv[2]);
  if (argc >= 2 && strcmp(argv[1], "observe") == 0 && argc == 3) return command_observe(argv[2]);
  if (argc >= 2 && strcmp(argv[1], "digest") == 0 && argc == 3) return command_digest(argv[2]);
  if (argc >= 2 && strcmp(argv[1], "atomic-write") == 0 && argc == 6) {
    return command_atomic_write(argv[2], argv[3], argv[4], argv[5]);
  }
  return fail_invalid();
}

int main(int argc, char **argv) {
  if (argc < 2 || argc > 6) return fail_invalid();
  return dispatch(argc, argv);
}
