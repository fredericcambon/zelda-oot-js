// Entry point of the built game. The shell loads the ROM and drives rt_run; there is nothing to do here.
#include <stdio.h>
#include "rt.h"

int main(void) {
  rt_reset();
  fprintf(stderr, "runtime ready\n");
  return 0;
}
