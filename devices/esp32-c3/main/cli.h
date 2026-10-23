#pragma once
// Serial console for the kolo door firmware (USB-Serial-JTAG). Commands:
//   scan, status, unlock, lock, setkey <hex>, setmac <aa:..>, setslot <n>,
//   info, forget
// The console is unauthenticated (USB only) — fine for a bench spike.

#include "yale/YaleBleLock.hpp"

namespace cli {

void init(YaleBleLock* lock);

}  // namespace cli