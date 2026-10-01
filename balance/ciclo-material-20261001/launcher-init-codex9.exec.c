/* Before-kernel exec routing for this owned launcher only. No runtime reprioritization. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int active;
static int (*original_execve)(const char *, char *const[], char *const[]);
static int (*original_execvp)(const char *, char *const[]);
static int (*original_execvpe)(const char *, char *const[], char *const[]);
static const char *node_copy = "/datos/tmp-atlas-lab/codex9-runtime/codex9-node";
static const char *bash_copy = "/datos/tmp-atlas-lab/balance/codex9/launcher-init-codex9.bash";

static void audit_route(const char *target) {
  const char *audit = getenv("CODEX9_INIT_AUDIT");
  const char *allowed = "/datos/tmp-atlas-lab/balance/codex9/launcher-init-codex9.";
  if (!audit || strncmp(audit, allowed, strlen(allowed))) return;
  int fd = open(audit, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return;
  dprintf(fd, "{\"pid\":%ld,\"phase\":\"before-exec\",\"route\":\"%s\",\"neutralTarget\":true}\n", (long)getpid(), target == node_copy ? "node" : "bash");
  close(fd);
}
static int routed_exec(const char *target, char *const argv[], char *const env[]) {
  size_t count = 0;
  while (argv && argv[count]) count++;
  char **neutral_argv = calloc(count + 2, sizeof(char *));
  if (!neutral_argv) { errno = ENOMEM; return -1; }
  for (size_t i = 0; i < count; ++i) neutral_argv[i] = argv[i];
  neutral_argv[0] = (char *)target;
  audit_route(target);
  int result = original_execve(target, neutral_argv, env), error = errno;
  free(neutral_argv); errno = error; return result;
}

__attribute__((constructor)) static void codex9_resolve_exec(void) {
  original_execve = dlsym(RTLD_NEXT, "execve");
  original_execvp = dlsym(RTLD_NEXT, "execvp");
  original_execvpe = dlsym(RTLD_NEXT, "execvpe");
  const char *enabled = getenv("CODEX9_LAUNCHER_INIT");
  active = enabled && !strcmp(enabled, "1");
}
static const char *neutral_if_owned_or_system(const char *file) {
  char resolved[PATH_MAX];
  if (!realpath(file, resolved)) return NULL;
  if (!strcmp(resolved, "/usr/bin/node") || !strcmp(resolved, node_copy)) return node_copy;
  if (!strcmp(resolved, "/usr/bin/bash") || !strcmp(resolved, bash_copy)) return bash_copy;
  return NULL;
}
static const char *replacement(const char *file) {
  if (!active || !file) return NULL;
  const char *base = strrchr(file, '/'); base = base ? base + 1 : file;
  if (strcmp(base, "node") && strcmp(base, "bash")) return NULL;
  if (strchr(file, '/')) return neutral_if_owned_or_system(file);
  const char *search = getenv("PATH"); if (!search) return NULL;
  while (1) {
    const char *end = strchr(search, ':'); size_t size = end ? (size_t)(end - search) : strlen(search);
    char path[PATH_MAX];
    if (size + strlen(file) + 2 < sizeof(path)) {
      memcpy(path, search, size); path[size] = '/'; strcpy(path + size + 1, file);
      if (!size) strcpy(path, file);
      if (!access(path, X_OK)) return neutral_if_owned_or_system(path);
    }
    if (!end) break;
    search = end + 1;
  }
  return NULL;
}
int execve(const char *file, char *const argv[], char *const env[]) {
  if (!original_execve) { errno = ENOSYS; return -1; }
  const char *target = replacement(file);
  return target ? routed_exec(target, argv, env) : original_execve(file, argv, env);
}
int execv(const char *file, char *const argv[]) { return execve(file, argv, environ); }
int execvp(const char *file, char *const argv[]) {
  const char *target = replacement(file);
  if (target) return routed_exec(target, argv, environ);
  if (!original_execvp) { errno = ENOSYS; return -1; }
  return original_execvp(file, argv);
}
int execvpe(const char *file, char *const argv[], char *const env[]) {
  const char *target = replacement(file);
  if (target) return routed_exec(target, argv, env);
  if (!original_execvpe) { errno = ENOSYS; return -1; }
  return original_execvpe(file, argv, env);
}
