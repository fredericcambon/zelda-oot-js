// Per-file dispatch tables emitted by the recompiler and the registry the runtime searches for indirect calls.
#ifndef OOT_DISPATCH_H
#define OOT_DISPATCH_H

#include "cpu.h"

typedef struct DispatchEntry {
  uint32_t addr;
  GuestFn fn;
} DispatchEntry;

// One recompiled file: the boot code, the main code file or an overlay. Code is recompiled against
// [link_start, link_end); an overlay runs at link address + delta once the game's loader has placed it.
typedef struct ImageInfo {
  const char *name;
  uint32_t link_start, link_end;
  int overlay;
  uint32_t delta;
  int loaded;
  const DispatchEntry *table;
  uint32_t count;
  // The call sites of the image's functions are the entries [first_site, first_site + site_count) of oot_sites.
  uint32_t first_site, site_count;
} ImageInfo;

extern ImageInfo oot_images[];
extern const uint32_t oot_image_count;

// A call site of a recompiled function. A thread's shadow stack holds indices into this table.
typedef struct SiteEntry {
  GuestFn fn;     // the function that holds the site
  uint32_t entry; // its entry address, as linked
  uint32_t site;  // the address of the call, as linked
} SiteEntry;

extern const SiteEntry oot_sites[];
extern const uint32_t oot_site_count;

// The recompiled function that starts at a guest address as seen by the running game, or NULL.
GuestFn oot_lookup(uint32_t addr);

#endif
