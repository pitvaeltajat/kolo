#include "yale/yale_crypto.h"

// All Yale protocol crypto/frame helpers are header-inline (yale_crypto.h).
// This translation unit is intentionally empty; it stays in the build so the
// existing CMake source lists (firmware + host test) need no change.
//
// The secure-channel checksum used to live here as a CRC-32, which was wrong:
// the real algorithm (yale::putSecurityChecksum) is a negated sum of three
// little-endian 32-bit words, matching yalexs-ble util._security_checksum.
