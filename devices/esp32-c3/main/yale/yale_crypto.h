#pragma once
// Yale/August BLE protocol crypto and frame helpers — the parts that are pure
// logic and therefore host-testable (test/test_crypto.cpp). No ESP-IDF
// includes here; mbedTLS only.
//
// Protocol summary (reference: marcusadolfsson/apple-homekey-yale CLAUDE.md
// §5):
//   - Service 0xFE24. Every frame is 18 bytes: a 16-byte AES block plus two
//     plain trailing bytes.
//   - Secure channel (…613 write / …614 notify), AES-128-ECB with the offline
//     key: opcode 0x01 exchanges 8 random bytes each way; the session key is
//     ours[0:8] || theirs[0:8]; opcode 0x03 confirms. Frames carry the key
//     slot at 0x11 and a 32-bit checksum at 0x0C.
//   - Command channel (…611 write / …612 notify), AES-128-CBC with a zero IV
//     and the session key; the CBC chain continues across every frame of the
//     connection in each direction. Frames start 0xEE (command) or 0xAA/0xBB
//     (ack/result) with an 8-bit checksum at 0x03.

#include <array>
#include <cstdint>
#include <cstring>

#include "mbedtls/aes.h"

namespace yale {

// Every frame on the wire is exactly this long.
constexpr size_t FRAME_LEN = 18;

using Frame = std::array<uint8_t, FRAME_LEN>;

// Frame layout (offsets into the 18 bytes).
constexpr uint8_t OFF_HEADER = 0x00;  // 0xEE command, 0xAA ack, 0xBB result
constexpr uint8_t OFF_OPCODE = 0x01;
constexpr uint8_t OFF_CHECKSUM = 0x03;  // 8-bit checksum
constexpr uint8_t OFF_SUBTYPE = 0x04;
constexpr uint8_t OFF_RESULT = 0x0F;  // result byte (0xBB frames)
constexpr uint8_t OFF_CRC32 = 0x0C;   // 32-bit checksum (secure channel)
constexpr uint8_t OFF_SLOT = 0x11;    // key slot (secure channel)

// Opcodes.
constexpr uint8_t OP_GETSTATUS = 0x02;
constexpr uint8_t OP_UNLOCK = 0x0A;
constexpr uint8_t OP_LOCK = 0x0B;

// GETSTATUS sub-types.
constexpr uint8_t SUB_LOCK = 0x02;
constexpr uint8_t SUB_DOOR = 0x2E;
constexpr uint8_t SUB_DOOR_LOCK = 0x2F;
constexpr uint8_t SUB_BATTERY = 0x0F;

// Lock status values (byte 8 of a GETSTATUS lock reply).
constexpr uint8_t LOCK_UNKNOWN = 0x00;
constexpr uint8_t LOCK_CALIBRATING = 0x01;
constexpr uint8_t LOCK_UNLOCKING = 0x02;
constexpr uint8_t LOCK_UNLOCKED = 0x03;
constexpr uint8_t LOCK_LOCKING = 0x04;
constexpr uint8_t LOCK_LOCKED = 0x05;
constexpr uint8_t LOCK_POL_DISCOVERY = 0x06;
constexpr uint8_t LOCK_JAMMED = 0x07;
constexpr uint8_t LOCK_SECURE_MODE = 0x0C;

// Door status values.
constexpr uint8_t DOOR_CLOSED = 0x01;
constexpr uint8_t DOOR_AJAR = 0x02;
constexpr uint8_t DOOR_OPEN = 0x03;

// AES-128-ECB wrapper (secure channel / handshake). Separate contexts for
// encrypt and decrypt — mbedTLS stores different key schedules for each.
class Ecb {
 public:
  Ecb() {
    mbedtls_aes_init(&m_enc);
    mbedtls_aes_init(&m_dec);
  }
  ~Ecb() {
    mbedtls_aes_free(&m_enc);
    mbedtls_aes_free(&m_dec);
  }
  Ecb(const Ecb&) = delete;
  Ecb& operator=(const Ecb&) = delete;

  void setKey(const uint8_t key[16]) {
    mbedtls_aes_setkey_enc(&m_enc, key, 128);
    mbedtls_aes_setkey_dec(&m_dec, key, 128);
  }
  void encrypt(const uint8_t in[16], uint8_t out[16]) {
    mbedtls_aes_crypt_ecb(&m_enc, MBEDTLS_AES_ENCRYPT, in, out);
  }
  void decrypt(const uint8_t in[16], uint8_t out[16]) {
    mbedtls_aes_crypt_ecb(&m_dec, MBEDTLS_AES_DECRYPT, in, out);
  }

 private:
  mbedtls_aes_context m_enc;
  mbedtls_aes_context m_dec;
};

// AES-128-CBC wrapper (command channel). The chain continues across every
// frame of the connection in each direction, so the IV is kept in the object.
// The encrypt and decrypt chains are SEPARATE (the lock's protocol uses
// independent chains per direction), so this holds two contexts and two IVs.
class Cbc {
 public:
  Cbc() {
    mbedtls_aes_init(&m_enc);
    mbedtls_aes_init(&m_dec);
  }
  ~Cbc() {
    mbedtls_aes_free(&m_enc);
    mbedtls_aes_free(&m_dec);
  }
  Cbc(const Cbc&) = delete;
  Cbc& operator=(const Cbc&) = delete;

  void setKey(const uint8_t key[16]) {
    mbedtls_aes_setkey_enc(&m_enc, key, 128);
    mbedtls_aes_setkey_dec(&m_dec, key, 128);
    reset();
  }
  void reset() {
    std::memset(m_ivEnc.data(), 0, m_ivEnc.size());
    std::memset(m_ivDec.data(), 0, m_ivDec.size());
  }

  // Encrypt one 16-byte block in place, chaining the encrypt IV.
  void encryptBlock(uint8_t block[16]) {
    mbedtls_aes_crypt_cbc(&m_enc, MBEDTLS_AES_ENCRYPT, 16, m_ivEnc.data(),
                          block, block);
  }
  // Decrypt one 16-byte block in place, chaining the decrypt IV.
  void decryptBlock(uint8_t block[16]) {
    mbedtls_aes_crypt_cbc(&m_dec, MBEDTLS_AES_DECRYPT, 16, m_ivDec.data(),
                          block, block);
  }

 private:
  mbedtls_aes_context m_enc;
  mbedtls_aes_context m_dec;
  std::array<uint8_t, 16> m_ivEnc{};
  std::array<uint8_t, 16> m_ivDec{};
};

// 8-bit checksum at OFF_CHECKSUM: sum of bytes 0..2 (header, opcode, 0x00)
// plus bytes 4..17, negated, so the whole frame sums to zero.
inline uint8_t simpleChecksum(const Frame& f) {
  uint8_t sum = 0;
  for (size_t i = 0; i < FRAME_LEN; ++i) {
    if (i == OFF_CHECKSUM) continue;
    sum = static_cast<uint8_t>(sum + f[i]);
  }
  return static_cast<uint8_t>(0 - sum);
}

// 32-bit checksum at OFF_CRC32 (secure channel): CRC32 of bytes 0..0x0B,
// little-endian at 0x0C..0x0F.
uint32_t crc32(const uint8_t* data, size_t len);
inline void putCrc32(Frame& f) {
  const uint32_t c = crc32(f.data(), OFF_CRC32);
  f[OFF_CRC32] = static_cast<uint8_t>(c & 0xFF);
  f[OFF_CRC32 + 1] = static_cast<uint8_t>((c >> 8) & 0xFF);
  f[OFF_CRC32 + 2] = static_cast<uint8_t>((c >> 16) & 0xFF);
  f[OFF_CRC32 + 3] = static_cast<uint8_t>((c >> 24) & 0xFF);
}

// Build a command frame (header 0xEE) with the given opcode/subtype, compute
// the 8-bit checksum, and encrypt the 16-byte block with the command CBC.
inline void buildCommand(Frame& f, uint8_t opcode, uint8_t subtype, Cbc& cbc) {
  f.fill(0);
  f[OFF_HEADER] = 0xEE;
  f[OFF_OPCODE] = opcode;
  f[OFF_SUBTYPE] = subtype;
  f[0x10] = 0x02;  // fixed byte, as in the reference implementation
  f[OFF_CHECKSUM] = simpleChecksum(f);
  cbc.encryptBlock(f.data());
}

// Build a secure-channel frame (handshake): header 0x01/0x03, payload at
// 0x04..0x0B, slot at 0x11, 32-bit checksum at 0x0C, then ECB-encrypt.
inline void buildSecure(Frame& f, uint8_t opcode, const uint8_t payload8[8],
                        uint8_t slot, Ecb& ecb) {
  f.fill(0);
  f[OFF_HEADER] = opcode;
  f[OFF_SLOT] = slot;
  std::memcpy(f.data() + 0x04, payload8, 8);
  putCrc32(f);
  ecb.encrypt(f.data(), f.data());
}

// Decrypt a received secure-channel frame in place.
inline void decryptSecure(Frame& f, Ecb& ecb) {
  ecb.encrypt(f.data(), f.data());
}

// Decrypt a received command-channel frame in place.
inline void decryptCommand(Frame& f, Cbc& cbc) { cbc.decryptBlock(f.data()); }

// Verify the 8-bit checksum of a decrypted frame.
inline bool checksumOk(const Frame& f) {
  uint8_t sum = 0;
  for (uint8_t b : f) sum = static_cast<uint8_t>(sum + b);
  return sum == 0;
}

}  // namespace yale