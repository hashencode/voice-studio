#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("native-worker-launcher: missing executable\n", stderr);
    return 64;
  }
  if (setpgid(0, 0) != 0 && errno != EACCES) {
    perror("native-worker-launcher: setpgid");
    return 70;
  }
  execv(argv[1], &argv[1]);
  perror("native-worker-launcher: execv");
  return 71;
}
