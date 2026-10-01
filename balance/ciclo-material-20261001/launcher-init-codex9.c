/* Own-exec startup only. Never runs a periodic repair, changes affinity, or touches another process. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

static void fail(const char *what) {
  dprintf(STDERR_FILENO, "codex9 startup guard failed: %s (errno=%d)\n", what, errno);
  _exit(125);
}

__attribute__((constructor)) static void codex9_startup(void) {
  const char *enabled = getenv("CODEX9_LAUNCHER_INIT");
  if (!enabled || strcmp(enabled, "1")) return;
  const char *tmp = getenv("TMPDIR");
  if (!tmp || strcmp(tmp, "/datos/tmp-atlas-lab")) fail("TMPDIR");
  if (prctl(PR_SET_NAME, "codex9-init", 0, 0, 0)) fail("own comm initialization");
  const char *audit = getenv("CODEX9_INIT_AUDIT");
  const char *allowed = "/datos/tmp-atlas-lab/balance/codex9/launcher-init-codex9.";
  int log = -1;
  if (audit) {
    if (strncmp(audit, allowed, strlen(allowed))) fail("audit path outside own launcher artifacts");
    log = open(audit, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (log < 0) fail("audit open");
  }
  DIR *tasks = opendir("/proc/self/task");
  if (!tasks) fail("own tasks");
  struct dirent *entry;
  while ((entry = readdir(tasks))) {
    char *end;
    long tid = strtol(entry->d_name, &end, 10);
    if (tid <= 0 || *end) continue;
    cpu_set_t cpus;
    CPU_ZERO(&cpus);
    if (sched_getaffinity((pid_t)tid, sizeof(cpus), &cpus)) fail("own initial affinity read");
    for (int cpu = 0; cpu < CPU_SETSIZE; ++cpu)
      if (CPU_ISSET(cpu, &cpus) != (cpu >= 6 && cpu <= 31)) fail("own affinity must be exactly 6-31");
    errno = 0;
    int before = getpriority(PRIO_PROCESS, (id_t)tid);
    if (errno || setpriority(PRIO_PROCESS, (id_t)tid, 19)) fail("own absolute startup nice");
    errno = 0;
    int after = getpriority(PRIO_PROCESS, (id_t)tid);
    if (errno || after != 19) fail("own startup nice verification");
    if (log >= 0) dprintf(log, "{\"pid\":%ld,\"tid\":%ld,\"beforeNice\":%d,\"initializedNice\":%d,\"cpus\":\"6-31\",\"comm\":\"codex9-init\",\"phase\":\"pre-main\"}\n",
      (long)getpid(), tid, before, after);
  }
  closedir(tasks);
  if (log >= 0) close(log);
}
