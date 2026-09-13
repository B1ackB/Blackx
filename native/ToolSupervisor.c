// Packx-owned supervisor. Apple APIs are linked from the OS, not redistributed.
#include <sys/resource.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <libproc.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <ftw.h>

static volatile sig_atomic_t stopping = 0;
static uint64_t bytes, entries, byte_limit, entry_limit;
static void stop(int sig) { stopping = sig; }
static int limit(int resource, rlim_t value) {
	struct rlimit bound = {value, value};
	if (resource == RLIMIT_CPU) bound.rlim_max = value + 1;
	return setrlimit(resource, &bound);
}
static int measure(const char *path, const struct stat *s, int type, struct FTW *f) {
	(void)path;
	if (type == FTW_F) bytes += (uint64_t)s->st_size;
	if (f->level > 0) entries++;
	return bytes > byte_limit || entries > entry_limit || f->level > 32;
}
static int erase(const char *path, const struct stat *s, int type, struct FTW *f) {
	(void)s; (void)type; (void)f;
	return remove(path);
}

int main(int argc, char **argv) {
	if (argc < 9) return 70;
	const pid_t host = getppid();
	const rlim_t cpu = strtoull(argv[1], NULL, 10);
	const uint64_t memory = strtoull(argv[2], NULL, 10);
	const int processes = atoi(argv[3]);
	byte_limit = strtoull(argv[4], NULL, 10);
	entry_limit = strtoull(argv[5], NULL, 10);
	const char *temporary = argv[6];
	if (!cpu || !memory || processes < 1 || processes > 64 || temporary[0] != '/') return 70;
	signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
	// A separate group lets this supervisor survive while terminating parser descendants.
	pid_t child = fork();
	if (child < 0) return 70;
	if (!child) {
		setpgid(0, 0);
		signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
		if (limit(RLIMIT_CPU, cpu) || limit(RLIMIT_FSIZE, byte_limit) || limit(RLIMIT_NOFILE, 128) || limit(RLIMIT_CORE, 0)) _exit(70);
		execv(argv[7], &argv[7]);
		_exit(70);
	}
	setpgid(child, child);
	int status = 0, exhausted = 0, unavailable = 0, host_lost = 0;
	for (;;) {
		if (getppid() != host) { host_lost = 1; break; }
		if (stopping) break;
		// RSS/process/tree budgets are sampled every 20 ms. CPU and per-file size are kernel limits.
		pid_t pids[65];
		int size = proc_listpids(PROC_PGRP_ONLY, (uint32_t)child, pids, sizeof(pids));
		if (size < 0) { unavailable = 1; break; }
		int count = size / (int)sizeof(pid_t);
		uint64_t rss = 0;
		for (int i = 0; i < count; i++) {
			struct proc_taskinfo info;
			int got = proc_pidinfo(pids[i], PROC_PIDTASKINFO, 0, &info, sizeof(info));
			if (got == sizeof(info)) rss += info.pti_resident_size;
			else if (errno == EPERM) { unavailable = 1; break; }
		}
		bytes = 0; entries = 0;
		int tree = nftw(temporary, measure, 16, FTW_PHYS);
		if (tree < 0 && errno != ENOENT) { unavailable = 1; break; }
		if (count > processes || rss > memory || tree > 0) { exhausted = 1; break; }
		siginfo_t info = {0};
		if (waitid(P_PID, child, &info, WEXITED | WNOHANG | WNOWAIT) < 0) { unavailable = 1; break; }
		if (info.si_pid == child) break;
		usleep(20000);
	}
	// Keep the leader unreaped until group termination on all early exits.
	kill(-child, SIGKILL);
	while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
	if (host_lost) { nftw(temporary, erase, 16, FTW_DEPTH | FTW_PHYS); return 74; }
	if (exhausted || (WIFSIGNALED(status) && (WTERMSIG(status) == SIGXCPU || WTERMSIG(status) == SIGXFSZ))) return 75;
	if (unavailable) return 70;
	if (stopping) return 74;
	return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
