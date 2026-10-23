// Host-side unit tests for yale_crypto (frame build/parse, checksums, CBC
// chain). No ESP-IDF needed — build with:
//   cmake -S test -B build-test && cmake --build build-test &&
//   ./build-test/test_crypto

#include <cassert>
#include <cstdio>
#include <cstring>

#include "yale/yale_crypto.h"

using yale::Cbc;
using yale::Ecb;
using yale::Frame;
using yale::FRAME_LEN;

static int failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                 \
    }                                                             \
  } while (0)

static void test_simple_checksum() {
  Frame f{};
  f.fill(0);
  f[0] = 0xEE;
  f[1] = 0x0A;
  f[4] = 0x00;
  f[0x10] = 0x02;
  f[3] = yale::simpleChecksum(f);
  CHECK(yale::checksumOk(f));
}

static void test_crc32() {
  // CRC-32 of "123456789" is 0xCBF43926.
  const uint8_t data[] = "123456789";
  CHECK(yale::crc32(data, 9) == 0xCBF43926u);
}

static void test_cbc_chain() {
  // The CBC chain continues across frames: encrypting two blocks with one
  // Cbc object must differ from encrypting each with a fresh IV.
  uint8_t key[16] = {0};
  key[0] = 0x01;
  uint8_t block1[16] = {0xAA};
  uint8_t block2[16] = {0xBB};

  Cbc chained;
  chained.setKey(key);
  uint8_t e1[16], e2[16];
  std::memcpy(e1, block1, 16);
  std::memcpy(e2, block2, 16);
  chained.encryptBlock(e1);
  chained.encryptBlock(e2);

  Cbc fresh;
  fresh.setKey(key);
  uint8_t f1[16], f2[16];
  std::memcpy(f1, block1, 16);
  std::memcpy(f2, block2, 16);
  fresh.encryptBlock(f1);  // first block: same IV → same output as chained
  // fresh's second block is NOT chained from f1's ciphertext — reset and
  // encrypt block2 alone with a zero IV.
  fresh.reset();
  std::memcpy(f2, block2, 16);
  fresh.encryptBlock(f2);

  CHECK(std::memcmp(e1, f1, 16) == 0);  // first block: same IV → same output
  CHECK(std::memcmp(e2, f2, 16) != 0);  // second block: chained IV → different

  // Decrypt back with a fresh Cbc and verify round-trip.
  Cbc dec;
  dec.setKey(key);
  dec.decryptBlock(e1);
  dec.decryptBlock(e2);
  CHECK(std::memcmp(e1, block1, 16) == 0);
  CHECK(std::memcmp(e2, block2, 16) == 0);
}

static void test_ecb_roundtrip() {
  uint8_t key[16] = {0};
  key[0] = 0x42;
  uint8_t in[16] = {0xDE, 0xAD, 0xBE, 0xEF};
  uint8_t out[16], back[16];

  Ecb enc;
  enc.setKey(key);
  enc.encrypt(in, out);

  Ecb dec;
  dec.setKey(key);
  dec.decrypt(out, back);
  CHECK(std::memcmp(back, in, 16) == 0);
}

static void test_build_command() {
  uint8_t key[16] = {0};
  Cbc cbc;
  cbc.setKey(key);

  Frame f;
  yale::buildCommand(f, yale::OP_UNLOCK, 0, cbc);

  // Decrypt and verify the plaintext frame.
  Cbc dec;
  dec.setKey(key);
  dec.decryptBlock(f.data());
  CHECK(f[0] == 0xEE);
  CHECK(f[1] == yale::OP_UNLOCK);
  CHECK(f[0x10] == 0x02);
  CHECK(yale::checksumOk(f));
}

static void test_build_secure() {
  uint8_t key[16] = {0};
  Ecb ecb;
  ecb.setKey(key);

  uint8_t payload[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  Frame f;
  yale::buildSecure(f, 0x01, payload, 3, ecb);

  // Decrypt and verify.
  Ecb dec;
  dec.setKey(key);
  dec.decrypt(f.data(), f.data());
  CHECK(f[0] == 0x01);
  CHECK(f[yale::OFF_SLOT] == 3);
  CHECK(std::memcmp(f.data() + 0x04, payload, 8) == 0);
  // CRC32 over bytes 0..0x0B must match the stored value.
  const uint32_t stored =
      static_cast<uint32_t>(f[yale::OFF_CRC32]) |
      (static_cast<uint32_t>(f[yale::OFF_CRC32 + 1]) << 8) |
      (static_cast<uint32_t>(f[yale::OFF_CRC32 + 2]) << 16) |
      (static_cast<uint32_t>(f[yale::OFF_CRC32 + 3]) << 24);
  CHECK(stored == yale::crc32(f.data(), yale::OFF_CRC32));
}

int main() {
  test_simple_checksum();
  test_crc32();
  test_cbc_chain();
  test_ecb_roundtrip();
  test_build_command();
  test_build_secure();

  if (failures == 0) {
    std::printf("all tests passed\n");
    return 0;
  }
  std::printf("%d test(s) failed\n", failures);
  return 1;
}