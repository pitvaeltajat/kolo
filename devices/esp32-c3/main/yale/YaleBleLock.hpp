#pragma once
// Yale/August BLE lock driver for the ESP32-C3 — a from-scratch C++ port of
// the protocol in bdraco/yalexs-ble, using marcusadolfsson/apple-homekey-yale
// (MIT) as the protocol reference. See yale_crypto.h for the wire format.
//
// Architecture (mirrors the reference):
//   - A FreeRTOS worker task owns all connection state and the crypto.
//   - NimBLE host callbacks (gapEvent, onSvc/onChr/onDsc/onWrite) only post
//     events to a queue; they never log and never touch the worker's state.
//   - waitFor() waits in ~50 ms slices so a command can be aborted.
//
// Behaviour:
//   - Direct connect to the cached address (YALE_DIRECT_CONNECT_MS); scan
//     (YALE_SCAN_MS) only after YALE_DIRECT_FAILURES_BEFORE_SCAN direct
//     failures. A failed connect does NOT clear the GATT cache.
//   - Linger YALE_LINGER_MS after a command so a second command rides the
//     open session. YALE_COOLDOWN_MS between command writes, YALE_DEDUPE_MS
//     coalesces repeats.
//   - Commands return on the lock's ack (0xAA); the result (0xBB) arrives
//     during the linger.
//   - The offline key and session key are never logged.

#include <array>
#include <atomic>
#include <cstdint>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs_config.h"
#include "yale/yale_crypto.h"

struct ble_gap_event;
struct ble_gatt_error;
struct ble_gatt_svc;
struct ble_gatt_chr;
struct ble_gatt_dsc;
struct ble_gatt_attr;

class YaleBleLock {
 public:
  explicit YaleBleLock(const nvs_config::YaleCreds& creds);
  ~YaleBleLock();
  YaleBleLock(const YaleBleLock&) = delete;
  YaleBleLock& operator=(const YaleBleLock&) = delete;

  /** Parse config and start the worker. No-op (logged) if credentials are
   * missing. */
  void begin();

  enum class Cmd : uint8_t { Status, Unlock, Lock };
  /** Queue a command for the worker. */
  void request(Cmd cmd);

  // Latest known state (worker-owned; read from any task).
  struct State {
    uint8_t lock = 0xFF;     // yale::LOCK_* ; 0xFF = unknown
    uint8_t door = 0xFF;     // yale::DOOR_* ; 0xFF = unknown
    uint16_t batteryMv = 0;  // 0 = unknown
  };
  State state() const { return m_state; }

  // Result of a command, reported through the callback.
  struct Result {
    Cmd cmd = Cmd::Status;
    bool ok = false;
    uint8_t error = 0;  // lock's result byte (0xBB frames), 0 on success
    int64_t elapsedMs = 0;
  };

  /** Called from the worker task when a command completes (ack or failure). */
  void setResultCallback(void (*cb)(const Result&, void*), void* arg);

 private:
  static constexpr const char* TAG = "YaleBle";
  static constexpr size_t FRAME_LEN = yale::FRAME_LEN;
  using Frame = yale::Frame;

  // Messages from the NimBLE host task to the worker.
  enum class EvType : uint8_t {
    Synced,
    DiscFound,
    DiscSeen,
    DiscDone,
    Connected,
    ConnectFailed,
    Disconnected,
    GattDone,
    NotifySecure,
    NotifyCmd,
  };
  struct Ev {
    EvType type;
    int status = 0;  // also: rssi for DiscSeen
    uint8_t addrType = 0;
    Frame frame{};
    std::array<uint8_t, 6> addr{};  // DiscSeen, MSB first
  };

  // Worker
  static void taskEntry(void* arg);
  void run();
  bool ensureConnected();
  bool establishSession();
  bool scanAndConnect();
  bool connectDirect(uint32_t timeoutMs);
  bool discover();
  bool writeCccd(uint16_t cccdHandle, uint8_t props, const char* what);
  bool handshake();
  bool secureExchange(uint8_t opcode, const uint8_t payload8[8],
                      Frame& response);
  bool sendCommand(uint8_t opcode, uint8_t subtype, uint8_t expectFlag,
                   uint8_t expectOpcode, int expectSubtype, uint32_t timeoutMs,
                   Frame& response);
  bool writeFrame(uint16_t handle, const Frame& frame);
  void handleCommandFrame(const Frame& plain);
  void performCommand(Cmd cmd);
  void disconnect();
  void loadCache();
  void saveCache();
  void clearCache();
  bool waitFor(EvType type, uint32_t timeoutMs, Ev& out);
  void cooldown();
  void reportResult(Cmd cmd, bool ok, uint8_t error, int64_t elapsedMs);

  // NimBLE callbacks (host task)
  static int gapEvent(ble_gap_event* event, void* arg);
  static int onSvc(uint16_t conn, const ble_gatt_error* error,
                   const ble_gatt_svc* svc, void* arg);
  static int onChr(uint16_t conn, const ble_gatt_error* error,
                   const ble_gatt_chr* chr, void* arg);
  static int onDsc(uint16_t conn, const ble_gatt_error* error,
                   uint16_t chr_val_handle, const ble_gatt_dsc* dsc, void* arg);
  static int onWrite(uint16_t conn, const ble_gatt_error* error,
                     ble_gatt_attr* attr, void* arg);
  static void onSync();
  static void onReset(int reason);
  static void hostTask(void* param);
  void post(const Ev& ev);

  static YaleBleLock* s_instance;

  bool m_enabled = false;
  std::array<uint8_t, 6> m_mac{};
  std::array<uint8_t, 16> m_offlineKey{};
  uint8_t m_slot = 0;

  QueueHandle_t m_events = nullptr;
  QueueHandle_t m_commands = nullptr;
  TaskHandle_t m_task = nullptr;

  // Connection state (worker-owned unless noted)
  uint8_t m_ownAddrType = 0;
  uint8_t m_peerAddrType = 0;
  uint16_t m_conn = 0xFFFF;  // written by host task on connect/disconnect
  int64_t m_lastDisconnectUs = 0;
  int m_directFailures = 0;

  uint16_t m_svcStart = 0, m_svcEnd = 0;
  uint16_t m_hWrite = 0, m_hRead = 0, m_hSecWrite = 0, m_hSecRead = 0;
  // Declaration handles, used to bound descriptor discovery (the CCCD of a
  // characteristic lives between its value handle and the next declaration).
  uint16_t m_defWrite = 0, m_defRead = 0, m_defSecWrite = 0, m_defSecRead = 0;
  uint16_t m_hReadCccd = 0, m_hSecReadCccd = 0;
  uint8_t m_readProps = 0, m_secReadProps = 0;
  uint16_t m_dscTarget = 0;  // characteristic whose CCCD is being searched
  bool m_sessionReady = false;
  bool m_scanMatched = false;
  bool m_addrKnown = false;
  bool m_synced = false;  // NimBLE host has synced (GAP calls are valid)
  bool m_gattCached = false;

  int64_t m_lastRxUs = 0;
  int64_t m_lastCmdRxUs = 0;  // command channel only: what cooldown() spaces
  int64_t m_lastOwnOpUs = 0;  // last lock/unlock we sent (dedupe)
  Cmd m_lastOwnOp = Cmd::Status;

  yale::Ecb m_ecb{};
  yale::Cbc m_cbc{};

  State m_state{};
  void (*m_resultCb)(const Result&, void*) = nullptr;
  void* m_resultCbArg = nullptr;
};