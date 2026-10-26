#include "yale/YaleBleLock.hpp"

#include <cstring>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "sdkconfig.h"

YaleBleLock* YaleBleLock::s_instance = nullptr;

namespace {

// Service and characteristic UUIDs (Yale Access BLE).
// The service is a 16-bit SIG UUID (0xFE24), but the characteristics use the
// vendor base bd4ac6xx-0b45-11e3-8ffd-0800200c9a66 — NOT the SIG base — so
// they are 128-bit and must be matched with ble_uuid_cmp, not a 16-bit value.
constexpr uint16_t SVC_YALE = 0xFE24;
// NimBLE stores 128-bit UUIDs little-endian (the string read backwards).
// bd4ac611-0b45-11e3-8ffd-0800200c9a66 (command write)
const ble_uuid128_t UUID_CMD_WRITE =
    BLE_UUID128_INIT(0x66, 0x9a, 0x0c, 0x20, 0x00, 0x08, 0xfd, 0x8f, 0xe3,
                     0x11, 0x45, 0x0b, 0x11, 0xc6, 0x4a, 0xbd);
// bd4ac612-… (command notify)
const ble_uuid128_t UUID_CMD_NOTIFY =
    BLE_UUID128_INIT(0x66, 0x9a, 0x0c, 0x20, 0x00, 0x08, 0xfd, 0x8f, 0xe3,
                     0x11, 0x45, 0x0b, 0x12, 0xc6, 0x4a, 0xbd);
// bd4ac613-… (secure write)
const ble_uuid128_t UUID_SEC_WRITE =
    BLE_UUID128_INIT(0x66, 0x9a, 0x0c, 0x20, 0x00, 0x08, 0xfd, 0x8f, 0xe3,
                     0x11, 0x45, 0x0b, 0x13, 0xc6, 0x4a, 0xbd);
// bd4ac614-… (secure notify)
const ble_uuid128_t UUID_SEC_NOTIFY =
    BLE_UUID128_INIT(0x66, 0x9a, 0x0c, 0x20, 0x00, 0x08, 0xfd, 0x8f, 0xe3,
                     0x11, 0x45, 0x0b, 0x14, 0xc6, 0x4a, 0xbd);

constexpr uint8_t OP_GETSTATUS = yale::OP_GETSTATUS;
constexpr uint8_t OP_UNLOCK = yale::OP_UNLOCK;
constexpr uint8_t OP_LOCK = yale::OP_LOCK;

constexpr uint8_t SUB_LOCK = yale::SUB_LOCK;
constexpr uint8_t SUB_DOOR = yale::SUB_DOOR;
constexpr uint8_t SUB_BATTERY = yale::SUB_BATTERY;

constexpr uint32_t DIRECT_CONNECT_MS = CONFIG_YALE_DIRECT_CONNECT_MS;
constexpr uint32_t SCAN_MS = CONFIG_YALE_SCAN_MS;
constexpr int DIRECT_FAILURES_BEFORE_SCAN =
    CONFIG_YALE_DIRECT_FAILURES_BEFORE_SCAN;
constexpr uint32_t LINGER_MS = CONFIG_YALE_LINGER_MS;
constexpr uint32_t COOLDOWN_MS = CONFIG_YALE_COOLDOWN_MS;
constexpr uint32_t DEDUPE_MS = CONFIG_YALE_DEDUPE_MS;
constexpr uint16_t CONN_ITVL_MIN = CONFIG_YALE_CONN_ITVL_MIN;
constexpr uint16_t CONN_ITVL_MAX = CONFIG_YALE_CONN_ITVL_MAX;
constexpr uint16_t SUPERVISION_TIMEOUT_MS = CONFIG_YALE_SUPERVISION_TIMEOUT_MS;
// The lock is a single-connection device and drops idle links only after
// ~30 s, so a busy lock needs several spaced-out attempts to catch a free
// slot. Backoff is deliberately long (see bleak-retry-connector's 4 s
// out-of-slots backoff and ESP-IDF's connection-slot release race).
constexpr int CONNECT_ATTEMPTS = CONFIG_YALE_CONNECT_ATTEMPTS;
constexpr uint32_t CONNECT_RETRY_BACKOFF_MS =
    CONFIG_YALE_CONNECT_RETRY_BACKOFF_MS;

// GATT discovery timeouts.
constexpr uint32_t GATT_MS = 10000;
// How long to wait for the lock's ack after writing a command.
constexpr uint32_t CMD_ACK_MS = 5000;
// How long to wait for the lock's result (0xBB) after the ack.
constexpr uint32_t CMD_RESULT_MS = 3000;

// The lock's address type is learned from a scan; until then we try public.
constexpr uint8_t ADDR_TYPE_PUBLIC = 0;
constexpr uint8_t ADDR_TYPE_RANDOM = 1;

const char* cmdName(YaleBleLock::Cmd cmd) {
  switch (cmd) {
    case YaleBleLock::Cmd::Status:
      return "status";
    case YaleBleLock::Cmd::Unlock:
      return "unlock";
    case YaleBleLock::Cmd::Lock:
      return "lock";
  }
  return "?";
}

}  // namespace

YaleBleLock::YaleBleLock(const nvs_config::YaleCreds& creds) {
  s_instance = this;
  m_slot = creds.slot;
  if (!creds.macValid || !creds.keyValid) {
    ESP_LOGW(TAG, "Yale BLE disabled: missing MAC or offline key");
    return;
  }
  m_mac = creds.mac;
  m_offlineKey = creds.key;
  m_enabled = true;
}

YaleBleLock::~YaleBleLock() {
  m_offlineKey.fill(0);
  s_instance = nullptr;
}

void YaleBleLock::begin() {
  if (!m_enabled) return;
  esp_log_level_set(TAG,
                    ESP_LOG_DEBUG);  // show advertisements during the spike
  m_events = xQueueCreate(24, sizeof(Ev));
  m_commands = xQueueCreate(4, sizeof(Cmd));
  loadCache();

  // Bring up the NimBLE host. Without this the GAP/GATT calls fail (the host
  // is unsynced). The host task runs the NimBLE event loop; our worker task
  // consumes the events it posts.
  ESP_ERROR_CHECK(nimble_port_init());
  ble_hs_cfg.sync_cb = onSync;
  ble_hs_cfg.reset_cb = onReset;
  nimble_port_freertos_init(hostTask);

  xTaskCreatePinnedToCore(taskEntry, "yale_ble", 4096, this, 5, &m_task, 0);
}

void YaleBleLock::request(Cmd cmd) {
  if (!m_enabled) return;
  Cmd c = cmd;
  xQueueSend(m_commands, &c, 0);
  // Wake the worker (it blocks on m_events with a 100 ms timeout).
  Ev ev{};
  ev.type = EvType::Synced;  // harmless no-op event to wake the loop
  post(ev);
}

void YaleBleLock::setResultCallback(void (*cb)(const Result&, void*),
                                    void* arg) {
  m_resultCb = cb;
  m_resultCbArg = arg;
}

void YaleBleLock::post(const Ev& ev) {
  if (m_events) xQueueSend(m_events, &ev, 0);
}

// ------------------------------------------------------------------ worker

void YaleBleLock::taskEntry(void* arg) {
  static_cast<YaleBleLock*>(arg)->run();
}

void YaleBleLock::run() {
  ESP_LOGI(TAG, "worker started");
  while (true) {
    // Commands take priority: check the command queue first.
    Cmd cmd;
    if (xQueueReceive(m_commands, &cmd, 0) == pdTRUE) {
      performCommand(cmd);
      continue;
    }

    Ev ev{};
    if (xQueueReceive(m_events, &ev, pdMS_TO_TICKS(100)) != pdTRUE) {
      continue;  // idle
    }

    switch (ev.type) {
      case EvType::Synced:
        ESP_LOGI(TAG, "NimBLE host synced");
        m_synced = true;
        break;
      case EvType::DiscFound:
        ESP_LOGI(TAG, "lock found: %02x:%02x:%02x:%02x:%02x:%02x rssi=%d",
                 ev.addr[5], ev.addr[4], ev.addr[3], ev.addr[2], ev.addr[1],
                 ev.addr[0], ev.status);
        m_scanMatched = true;
        m_peerAddrType = ev.addrType;
        m_addrKnown = true;
        break;
      case EvType::DiscSeen:
        // A scan report for the lock; remember its address type.
        m_peerAddrType = ev.addrType;
        m_addrKnown = true;
        break;
      case EvType::DiscDone:
        // Scan finished; handled by scanAndConnect() via waitFor().
        break;
      case EvType::Connected:
        ESP_LOGI(TAG, "connected");
        m_conn = static_cast<uint16_t>(ev.status);
        m_directFailures = 0;
        break;
      case EvType::ConnectFailed:
        ESP_LOGW(TAG, "connect failed (rc=%d)", ev.status);
        m_conn = 0xFFFF;
        break;
      case EvType::Disconnected:
        ESP_LOGI(TAG, "disconnected (reason 0x%x)", ev.status);
        m_conn = 0xFFFF;
        m_sessionReady = false;
        m_lastDisconnectUs = esp_timer_get_time();
        break;
      case EvType::GattDone:
        // Discovery finished; handled by discover() via waitFor().
        break;
      case EvType::NotifySecure: {
        // A secure-channel notification: decrypt and handle.
        Frame f = ev.frame;
        yale::decryptSecure(f, m_ecb);
        // The handshake's secureExchange() waits for the response via
        // waitFor(NotifySecure); nothing to do here beyond posting.
        break;
      }
      case EvType::NotifyCmd: {
        Frame f = ev.frame;
        yale::decryptCommand(f, m_cbc);
        m_lastRxUs = esp_timer_get_time();
        if (f[0] == 0xAA || f[0] == 0xBB) {
          m_lastCmdRxUs = esp_timer_get_time();
          handleCommandFrame(f);
        }
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ NimBLE

void YaleBleLock::onSync() {
  // Ensure we have a usable identity address before any GAP procedure.
  int rc = ble_hs_util_ensure_addr(0);
  if (rc != 0) {
    ESP_LOGE(TAG, "ble_hs_util_ensure_addr failed (rc=%d)", rc);
  }
  // Log our own address so a bad/zero identity is visible.
  uint8_t own[6];
  if (ble_hs_id_copy_addr(BLE_ADDR_PUBLIC, own, nullptr) == 0) {
    ESP_LOGI(TAG, "own public addr %02x:%02x:%02x:%02x:%02x:%02x", own[5],
             own[4], own[3], own[2], own[1], own[0]);
  } else {
    ESP_LOGW(TAG, "no public own address");
  }
  if (s_instance) s_instance->post(Ev{EvType::Synced});
}

void YaleBleLock::onReset(int reason) {
  ESP_LOGI(TAG, "NimBLE host reset (reason %d)", reason);
}

void YaleBleLock::hostTask(void* param) {
  nimble_port_run();
  nimble_port_freertos_deinit();
}

int YaleBleLock::gapEvent(ble_gap_event* event, void* arg) {
  YaleBleLock* self = static_cast<YaleBleLock*>(arg);
  if (!self) return 0;

  switch (event->type) {
    case BLE_GAP_EVENT_DISC: {
      const ble_gap_disc_desc* desc = &event->disc;
      // desc->addr.val is little-endian (LSB first); our m_mac is MSB first.
      const uint8_t* a = desc->addr.val;
      ble_hs_adv_fields fields;
      const int prc =
          ble_hs_adv_parse_fields(&fields, desc->data, desc->length_data);
      uint16_t company = 0xFFFF;
      if (prc == 0 && fields.mfg_data && fields.mfg_data_len >= 2) {
        company = fields.mfg_data[0] | (fields.mfg_data[1] << 8);
      }
      // Log name + 16-bit service UUIDs so we can spot the lock even if it
      // advertises under a random address.
      char name[32] = {0};
      if (prc == 0 && fields.name && fields.name_len) {
        const int n = fields.name_len < 31 ? fields.name_len : 31;
        std::memcpy(name, fields.name, n);
      }
      uint16_t svc = 0;
      if (prc == 0 && fields.num_uuids16 > 0 && fields.uuids16) {
        svc = fields.uuids16[0].value;
      }
      ESP_LOGD(TAG,
               "adv %02x:%02x:%02x:%02x:%02x:%02x rssi=%d type=%d evt=%d "
               "len=%d mfg=%04x svc=%04x name='%s'",
               a[5], a[4], a[3], a[2], a[1], a[0], desc->rssi, desc->addr.type,
               desc->event_type, desc->length_data, company, svc, name);

      // Primary match: the configured lock MAC.
      bool match = false;
      if (self->m_mac[0] == a[5] && self->m_mac[1] == a[4] &&
          self->m_mac[2] == a[3] && self->m_mac[3] == a[2] &&
          self->m_mac[4] == a[1] && self->m_mac[5] == a[0]) {
        match = true;
      }

      // Fallback: Yale/August manufacturer data (company 465 / 0x01D1), an
      // Apple HomeKit-over-BLE advert (company 76, type 0x06), or the Yale
      // Access BLE service 0xFE24.
      if (!match && prc == 0) {
        if (fields.mfg_data && fields.mfg_data_len >= 2) {
          if (company == 465) match = true;
          if (company == 76 && fields.mfg_data_len >= 3 &&
              fields.mfg_data[2] == 0x06)
            match = true;
        }
        if (svc == 0xFE24) match = true;
      }
      if (!match) break;

      Ev ev{};
      ev.type = EvType::DiscFound;
      ev.status = desc->rssi;
      ev.addrType = desc->addr.type;
      std::memcpy(ev.addr.data(), desc->addr.val, 6);
      self->post(ev);
      break;
    }
    case BLE_GAP_EVENT_CONNECT:
      if (event->connect.status == 0) {
        // Record the handle here, not only via the event: waitFor(Connected)
        // returns on the matching event before its inline handler runs, so
        // relying on that would leave m_conn at 0xFFFF and every GATT call
        // would fail with BLE_HS_ENOTCONN.
        self->m_conn = event->connect.conn_handle;
        Ev ev{};
        ev.type = EvType::Connected;
        ev.status = event->connect.conn_handle;
        self->post(ev);
      } else {
        ESP_LOGW(TAG, "connect failed: status=%d", event->connect.status);
        Ev ev{};
        ev.type = EvType::ConnectFailed;
        ev.status = event->connect.status;
        self->post(ev);
      }
      break;
    case BLE_GAP_EVENT_DISCONNECT: {
      self->m_conn = 0xFFFF;
      self->m_lastDisconnectUs = esp_timer_get_time();
      Ev ev{};
      ev.type = EvType::Disconnected;
      ev.status = event->disconnect.reason;
      self->post(ev);
      break;
    }
    case BLE_GAP_EVENT_DISC_COMPLETE: {
      Ev ev{};
      ev.type = EvType::DiscDone;
      self->post(ev);
      break;
    }
    case BLE_GAP_EVENT_NOTIFY_RX: {
      const uint16_t handle = event->notify_rx.attr_handle;
      Ev ev{};
      if (handle == self->m_hSecRead) {
        ev.type = EvType::NotifySecure;
      } else if (handle == self->m_hRead) {
        ev.type = EvType::NotifyCmd;
      } else {
        break;  // unknown handle; ignore
      }
      const size_t len = event->notify_rx.om->om_len;
      size_t n = len > FRAME_LEN ? FRAME_LEN : len;
      std::memcpy(ev.frame.data(), event->notify_rx.om->om_data, n);
      self->post(ev);
      break;
    }
    default:
      break;
  }
  return 0;
}

int YaleBleLock::onSvc(uint16_t conn, const ble_gatt_error* error,
                       const ble_gatt_svc* svc, void* arg) {
  YaleBleLock* self = static_cast<YaleBleLock*>(arg);
  if (!self) return 0;
  if (error->status == BLE_HS_EDONE) {
    // Discovery complete.
    Ev ev{};
    ev.type = EvType::GattDone;
    self->post(ev);
    return 0;
  }
  if (error->status == 0 && svc && svc->uuid.u.type == BLE_UUID_TYPE_16 &&
      svc->uuid.u16.value == SVC_YALE) {
    self->m_svcStart = svc->start_handle;
    self->m_svcEnd = svc->end_handle;
  }
  return 0;
}

int YaleBleLock::onChr(uint16_t conn, const ble_gatt_error* error,
                       const ble_gatt_chr* chr, void* arg) {
  YaleBleLock* self = static_cast<YaleBleLock*>(arg);
  if (!self) return 0;
  if (error->status == BLE_HS_EDONE) {
    Ev ev{};
    ev.type = EvType::GattDone;
    self->post(ev);
    return 0;
  }
  if (error->status != 0 || !chr) return 0;
  // The Yale characteristics are 128-bit (vendor base bd4ac6xx-…), so match
  // with ble_uuid_cmp. All four use the value handle for reads/writes; the
  // declaration handle bounds descriptor discovery.
  if (ble_uuid_cmp(&chr->uuid.u, &UUID_CMD_WRITE.u) == 0) {
    self->m_hWrite = chr->val_handle;
    self->m_defWrite = chr->def_handle;
  } else if (ble_uuid_cmp(&chr->uuid.u, &UUID_CMD_NOTIFY.u) == 0) {
    self->m_hRead = chr->val_handle;
    self->m_defRead = chr->def_handle;
    self->m_readProps = chr->properties;
  } else if (ble_uuid_cmp(&chr->uuid.u, &UUID_SEC_WRITE.u) == 0) {
    self->m_hSecWrite = chr->val_handle;
    self->m_defSecWrite = chr->def_handle;
  } else if (ble_uuid_cmp(&chr->uuid.u, &UUID_SEC_NOTIFY.u) == 0) {
    self->m_hSecRead = chr->val_handle;
    self->m_defSecRead = chr->def_handle;
    self->m_secReadProps = chr->properties;
  }
  return 0;
}

int YaleBleLock::onDsc(uint16_t conn, const ble_gatt_error* error,
                       uint16_t chr_val_handle, const ble_gatt_dsc* dsc,
                       void* arg) {
  YaleBleLock* self = static_cast<YaleBleLock*>(arg);
  if (!self) return 0;
  if (error->status == BLE_HS_EDONE) {
    Ev ev{};
    ev.type = EvType::GattDone;
    self->post(ev);
    return 0;
  }
  if (error->status != 0 || !dsc) return 0;
  ESP_LOGD(TAG, "dsc chr_val=%u handle=%u uuid16=%04x", chr_val_handle,
           dsc->handle,
           dsc->uuid.u.type == BLE_UUID_TYPE_16 ? dsc->uuid.u16.value : 0);
  if (dsc->uuid.u.type == BLE_UUID_TYPE_16 &&
      dsc->uuid.u16.value == 0x2902) {  // CCCD
    if (chr_val_handle == self->m_hRead)
      self->m_hReadCccd = dsc->handle;
    else if (chr_val_handle == self->m_hSecRead)
      self->m_hSecReadCccd = dsc->handle;
  }
  return 0;
}

int YaleBleLock::onWrite(uint16_t conn, const ble_gatt_error* error,
                         ble_gatt_attr* attr, void* arg) {
  YaleBleLock* self = static_cast<YaleBleLock*>(arg);
  if (!self) return 0;
  Ev ev{};
  ev.type = EvType::GattDone;
  ev.status = error ? error->status : 0;
  self->post(ev);
  return 0;
}

// ------------------------------------------------------------------ connect

bool YaleBleLock::ensureConnected() {
  if (m_conn != 0xFFFF && m_sessionReady) return true;

  // Wait for the NimBLE host to sync before any GAP call.
  if (!m_synced) {
    const int64_t deadline = esp_timer_get_time() + 3000000;  // 3 s
    while (!m_synced && esp_timer_get_time() < deadline) {
      Ev ev{};
      if (xQueueReceive(m_events, &ev, pdMS_TO_TICKS(50)) == pdTRUE &&
          ev.type == EvType::Synced) {
        m_synced = true;
      }
    }
    if (!m_synced) {
      ESP_LOGE(TAG, "NimBLE host did not sync");
      return false;
    }
  }

  // If we have a cached address, try a direct connect first.
  if (m_addrKnown) {
    if (connectDirect(DIRECT_CONNECT_MS)) {
      if (establishSession()) return true;
      disconnect();
      return false;
    }
    ++m_directFailures;
    if (m_directFailures < DIRECT_FAILURES_BEFORE_SCAN) return false;
  }

  // Scan for the lock.
  if (!scanAndConnect()) return false;
  if (establishSession()) return true;
  disconnect();
  return false;
}

// Discovery, then the session setup in the order yalexs-ble uses: enable the
// secure-notify CCCD, run the handshake, then enable the command-notify CCCD.
// The lock drops the link if the command channel is armed before the secure
// channel is up.
bool YaleBleLock::establishSession() {
  if (!discover()) return false;
  if (!writeCccd(m_hSecReadCccd, m_secReadProps, "secure")) return false;
  if (!handshake()) return false;
  if (!writeCccd(m_hReadCccd, m_readProps, "command")) return false;
  m_sessionReady = true;
  return true;
}

bool YaleBleLock::connectDirect(uint32_t timeoutMs) {
  ble_addr_t addr{};
  addr.type = m_peerAddrType;
  // ble_addr_t.val is least-significant byte first (on-air order); m_mac is
  // MSB-first, so reverse it. Getting this wrong connects to a non-existent
  // address: the controller never gets a response, the connect times out and
  // we cancel it (surfacing as status=9 / BLE_HS_EAPP).
  for (int i = 0; i < 6; ++i) addr.val[i] = m_mac[5 - i];

  const ble_gap_conn_params params = {
      .scan_itvl = 0x0010,
      .scan_window = 0x0010,
      .itvl_min = CONN_ITVL_MIN,
      .itvl_max = CONN_ITVL_MAX,
      .latency = 0,
      .supervision_timeout = SUPERVISION_TIMEOUT_MS / 10,
      .min_ce_len = 0,
      .max_ce_len = 0,
  };

  int rc = ble_gap_connect(BLE_OWN_ADDR_PUBLIC, &addr, timeoutMs, &params,
                           gapEvent, this);
  if (rc != 0) {
    ESP_LOGE(TAG, "ble_gap_connect failed (rc=%d)", rc);
    return false;
  }

  Ev ev{};
  if (!waitFor(EvType::Connected, timeoutMs, ev)) {
    ESP_LOGW(TAG, "direct connect timed out");
    ble_gap_conn_cancel();
    return false;
  }
  return true;
}

bool YaleBleLock::scanAndConnect() {
  ESP_LOGI(TAG, "scanning for the lock (%u ms)", (unsigned)SCAN_MS);
  m_scanMatched = false;
  m_addrKnown = false;

  const ble_gap_disc_params disc_params = {
      .itvl = 0x0010,
      .window = 0x0010,
      .filter_policy = 0,
      .limited = 0,
      .passive = 0,
      .filter_duplicates = 1,
  };
  int rc =
      ble_gap_disc(BLE_OWN_ADDR_PUBLIC, SCAN_MS, &disc_params, gapEvent, this);
  if (rc != 0) {
    ESP_LOGE(TAG, "ble_gap_disc failed (rc=%d)", rc);
    return false;
  }

  // Connect as soon as the lock is seen — do NOT wait for the scan to finish.
  // The lock advertises briefly and won't accept a connection long after; a
  // full-window wait meant connecting ~30 s after the advert and timing out.
  Ev ev{};
  if (!waitFor(EvType::DiscFound, SCAN_MS, ev)) {
    ble_gap_disc_cancel();
    ESP_LOGW(TAG, "lock not found in scan");
    return false;
  }
  const int rssi = ev.status;
  // Cancel the scan and WAIT for it to actually stop before connecting: the
  // controller rejects a connect issued while a scan is still active with
  // BLE_ERR_CONN_LIMIT (0x09).
  ble_gap_disc_cancel();
  waitFor(EvType::DiscDone, 2000, ev);
  ESP_LOGI(TAG, "lock seen (rssi=%d), connecting", rssi);

  // Connect to the address we saw. The lock is a single-connection device:
  // while the Yale bridge / app / Apple Home holds its one slot it rejects us
  // with BLE_ERR_CONN_LIMIT (0x09) or BLE_ERR_CONN_REJ_RESOURCES (0x0d), and
  // it drops idle connections only after ~30 s. A failed attempt can also
  // leave the lock briefly thinking it is still connected, so retry with a
  // generous backoff rather than hammering it.
  ble_addr_t addr{};
  addr.type = m_peerAddrType;
  // ble_addr_t.val is least-significant byte first (on-air order); m_mac is
  // MSB-first, so reverse it (see connectDirect).
  for (int i = 0; i < 6; ++i) addr.val[i] = m_mac[5 - i];
  const ble_gap_conn_params params = {
      .scan_itvl = 0x0010,
      .scan_window = 0x0010,
      .itvl_min = CONN_ITVL_MIN,
      .itvl_max = CONN_ITVL_MAX,
      .latency = 0,
      .supervision_timeout = SUPERVISION_TIMEOUT_MS / 10,
      .min_ce_len = 0,
      .max_ce_len = 0,
  };
  for (int attempt = 1; attempt <= CONNECT_ATTEMPTS; ++attempt) {
    rc = ble_gap_connect(BLE_OWN_ADDR_PUBLIC, &addr, DIRECT_CONNECT_MS, &params,
                         gapEvent, this);
    if (rc != 0) {
      ESP_LOGE(TAG, "ble_gap_connect failed (rc=%d)", rc);
      return false;
    }
    if (waitFor(EvType::Connected, DIRECT_CONNECT_MS, ev)) return true;
    ble_gap_conn_cancel();
    ESP_LOGW(TAG, "connect attempt %d/%d failed (lock busy or out of range)",
             attempt, CONNECT_ATTEMPTS);
    if (attempt < CONNECT_ATTEMPTS) {
      vTaskDelay(pdMS_TO_TICKS(CONNECT_RETRY_BACKOFF_MS));
    }
  }
  return false;
}

bool YaleBleLock::discover() {
  if (m_gattCached) return true;  // handles from a previous discovery

  m_svcStart = m_svcEnd = 0;
  m_hWrite = m_hRead = m_hSecWrite = m_hSecRead = 0;
  m_hReadCccd = m_hSecReadCccd = 0;

  ble_uuid_any_t svc_uuid;
  svc_uuid.u.type = BLE_UUID_TYPE_16;
  svc_uuid.u16.value = SVC_YALE;
  int rc = ble_gattc_disc_svc_by_uuid(m_conn, &svc_uuid.u, onSvc, this);
  if (rc != 0) {
    ESP_LOGE(TAG, "disc_svc_by_uuid failed (rc=%d, conn=%u)", rc, m_conn);
    return false;
  }
  Ev ev{};
  if (!waitFor(EvType::GattDone, GATT_MS, ev)) {
    ESP_LOGE(TAG, "service discovery timed out");
    return false;
  }
  if (m_svcStart == 0) {
    ESP_LOGE(TAG, "service 0xFE24 not found (status=%d)", ev.status);
    return false;
  }

  rc = ble_gattc_disc_all_chrs(m_conn, m_svcStart, m_svcEnd, onChr, this);
  if (rc != 0) {
    ESP_LOGE(TAG, "disc_all_chrs failed (rc=%d)", rc);
    return false;
  }
  if (!waitFor(EvType::GattDone, GATT_MS, ev)) {
    ESP_LOGE(TAG, "characteristic discovery timed out");
    return false;
  }
  if (m_hWrite == 0 || m_hRead == 0 || m_hSecWrite == 0 || m_hSecRead == 0) {
    ESP_LOGE(TAG, "incomplete characteristic discovery (w=%u r=%u sw=%u sr=%u)",
             m_hWrite, m_hRead, m_hSecWrite, m_hSecRead);
    return false;
  }

  // CCCDs: both notify characteristics are INDICATE-only (props 0x20), so we
  // must write 0x0002, not 0x0001. A descriptor range runs from the value
  // handle to just before the next characteristic declaration; passing the
  // value handle as both start and end yields an empty range and finds
  // nothing. The command-notify CCCD sits before the secure-write
  // declaration; the secure-notify CCCD is last, so it runs to the service
  // end.
  const uint16_t readEnd = m_defSecWrite ? m_defSecWrite - 1 : m_svcEnd;
  rc = ble_gattc_disc_all_dscs(m_conn, m_hRead, readEnd, onDsc, this);
  if (rc != 0) {
    ESP_LOGE(TAG, "disc_all_dscs (command) failed (rc=%d)", rc);
    return false;
  }
  if (!waitFor(EvType::GattDone, GATT_MS, ev)) {
    ESP_LOGE(TAG, "command descriptor discovery timed out");
    return false;
  }
  rc = ble_gattc_disc_all_dscs(m_conn, m_hSecRead, m_svcEnd, onDsc, this);
  if (rc != 0) {
    ESP_LOGE(TAG, "disc_all_dscs (secure) failed (rc=%d)", rc);
    return false;
  }
  if (!waitFor(EvType::GattDone, GATT_MS, ev)) {
    ESP_LOGE(TAG, "secure descriptor discovery timed out");
    return false;
  }
  ESP_LOGI(TAG,
           "gatt: svc %u-%u write=%u read=%u cccd=%u secWrite=%u secRead=%u "
           "cccd=%u",
           m_svcStart, m_svcEnd, m_hWrite, m_hRead, m_hReadCccd, m_hSecWrite,
           m_hSecRead, m_hSecReadCccd);

  m_gattCached = true;
  saveCache();
  return true;
}

bool YaleBleLock::writeCccd(uint16_t cccdHandle, uint8_t props,
                            const char* what) {
  if (cccdHandle == 0) {
    ESP_LOGE(TAG, "no CCCD for %s notify", what);
    return false;
  }
  // INDICATE-only: write 0x0002. Writing 0x0001 is rejected with ATT error
  // 0x80.
  const uint8_t val[2] = {0x02, 0x00};
  int rc =
      ble_gattc_write_flat(m_conn, cccdHandle, val, sizeof(val), onWrite, this);
  if (rc != 0) return false;
  Ev ev{};
  if (!waitFor(EvType::GattDone, GATT_MS, ev) || ev.status != 0) {
    ESP_LOGE(TAG, "CCCD write for %s failed (status=%d)", what, ev.status);
    return false;
  }
  ESP_LOGI(TAG, "CCCD enabled for %s notify", what);
  return true;
}

bool YaleBleLock::writeFrame(uint16_t handle, const Frame& frame) {
  int rc = ble_gattc_write_flat(m_conn, handle, frame.data(), FRAME_LEN,
                                onWrite, this);
  if (rc != 0) return false;
  Ev ev{};
  if (!waitFor(EvType::GattDone, GATT_MS, ev) || ev.status != 0) {
    ESP_LOGE(TAG, "write failed (rc=%d status=%d)", rc, ev.status);
    return false;
  }
  return true;
}

void YaleBleLock::cooldown() {
  const int64_t now = esp_timer_get_time();
  const int64_t since = now - m_lastCmdRxUs;
  if (since < static_cast<int64_t>(COOLDOWN_MS) * 1000) {
    vTaskDelay(
        pdMS_TO_TICKS(COOLDOWN_MS - static_cast<uint32_t>(since / 1000)));
  }
}

// ------------------------------------------------------------------ handshake

bool YaleBleLock::secureExchange(uint8_t opcode, const uint8_t payload8[8],
                                 Frame& response) {
  Frame f;
  yale::buildSecure(f, opcode, payload8, m_slot, m_ecb);
  if (!writeFrame(m_hSecWrite, f)) return false;

  Ev ev{};
  if (!waitFor(EvType::NotifySecure, GATT_MS, ev)) return false;
  response = ev.frame;
  // The secure-channel response is ECB-encrypted; decrypt it.
  yale::decryptSecure(response, m_ecb);
  return true;
}

bool YaleBleLock::handshake() {
  uint8_t rnd[16];
  esp_fill_random(rnd, sizeof(rnd));
  m_ecb.setKey(m_offlineKey.data());

  Frame resp{};
  if (!secureExchange(0x01, rnd, resp) || resp[0] != 0x02) {
    ESP_LOGE(TAG, "key exchange rejected: offline key or slot is incorrect");
    std::memset(rnd, 0, sizeof(rnd));
    return false;
  }
  uint8_t session[16];
  std::memcpy(session, rnd, 8);
  std::memcpy(session + 8, &resp[0x04], 8);
  m_ecb.setKey(session);

  if (!secureExchange(0x03, rnd + 8, resp) || resp[0] != 0x04) {
    ESP_LOGE(TAG, "session initialisation rejected");
    std::memset(rnd, 0, sizeof(rnd));
    std::memset(session, 0, sizeof(session));
    return false;
  }

  m_cbc.setKey(session);
  std::memset(rnd, 0, sizeof(rnd));
  std::memset(session, 0, sizeof(session));
  m_sessionReady = true;
  ESP_LOGI(TAG, "secure session established");
  return true;
}

// ------------------------------------------------------------------ commands

bool YaleBleLock::sendCommand(uint8_t opcode, uint8_t subtype,
                              uint8_t expectFlag, uint8_t expectOpcode,
                              int expectSubtype, uint32_t timeoutMs,
                              Frame& response) {
  Frame cmd;
  yale::buildCommand(cmd, opcode, subtype, m_cbc);

  cooldown();
  if (!writeFrame(m_hWrite, cmd)) {
    // The encrypt chain has advanced past a frame the lock never saw.
    disconnect();
    return false;
  }

  const int64_t deadline =
      esp_timer_get_time() + static_cast<int64_t>(timeoutMs) * 1000;
  while (true) {
    const int64_t remainMs = (deadline - esp_timer_get_time()) / 1000;
    if (remainMs <= 0) {
      ESP_LOGW(TAG, "command timed out waiting for reply");
      return false;
    }
    Ev ev{};
    if (!waitFor(EvType::NotifyCmd, static_cast<uint32_t>(remainMs), ev))
      return false;
    const Frame& f = ev.frame;
    if (f[0] != expectFlag) continue;
    if (expectOpcode != 0 && f[1] != expectOpcode) continue;
    if (expectSubtype >= 0 && f[4] != static_cast<uint8_t>(expectSubtype))
      continue;
    response = f;
    return true;
  }
}

void YaleBleLock::handleCommandFrame(const Frame& f) {
  if (f[0] == 0xAA) {
    // Ack: the lock accepted the command and is moving. The result (0xBB)
    // arrives when the motor stops (~1.8 s later).
    ESP_LOGI(TAG, "lock acked (opcode 0x%02x)", f[1]);
  } else if (f[0] == 0xBB) {
    // Result.
    const bool unlock = f[1] == OP_UNLOCK;
    if (f[yale::OFF_RESULT] == 0x00) {
      ESP_LOGI(TAG, "lock reports %s done", unlock ? "unlock" : "lock");
      m_state.lock = unlock ? yale::LOCK_UNLOCKED : yale::LOCK_LOCKED;
    } else {
      ESP_LOGE(TAG, "lock reports %s failed: error 0x%02X",
               unlock ? "unlock" : "lock", f[yale::OFF_RESULT]);
    }
  }
}

void YaleBleLock::performCommand(Cmd cmd) {
  ESP_LOGI(TAG, "%s requested", cmdName(cmd));
  const int64_t t0 = esp_timer_get_time();

  if (!ensureConnected()) {
    ESP_LOGE(TAG, "%s failed: could not establish a session with the lock",
             cmdName(cmd));
    reportResult(cmd, false, 0, (esp_timer_get_time() - t0) / 1000);
    return;
  }

  Frame resp{};
  bool ok = false;
  uint8_t error = 0;

  switch (cmd) {
    case Cmd::Unlock:
    case Cmd::Lock: {
      // Dedupe: a repeat of the same command within DEDUPE_MS is coalesced.
      const int64_t now = esp_timer_get_time();
      if (cmd == m_lastOwnOp &&
          now - m_lastOwnOpUs < static_cast<int64_t>(DEDUPE_MS) * 1000) {
        ESP_LOGI(TAG, "%s deduped", cmdName(cmd));
        reportResult(cmd, true, 0, 0);
        return;
      }
      m_lastOwnOp = cmd;
      m_lastOwnOpUs = now;

      const uint8_t opcode = (cmd == Cmd::Unlock) ? OP_UNLOCK : OP_LOCK;
      // Return on the ack (0xAA); the result (0xBB) arrives during the linger.
      ok = sendCommand(opcode, 0, 0xAA, opcode, -1, CMD_ACK_MS, resp);
      if (!ok) {
        ESP_LOGE(TAG, "%s failed: no ack", cmdName(cmd));
      }
      break;
    }
    case Cmd::Status: {
      // Read lock + door + battery.
      ok = sendCommand(OP_GETSTATUS, SUB_LOCK, 0xBB, OP_GETSTATUS, SUB_LOCK,
                       CMD_RESULT_MS, resp);
      if (ok) {
        m_state.lock = resp[0x08];
        ESP_LOGI(TAG, "lock status: 0x%02x", m_state.lock);
      }
      if (ok) {
        ok = sendCommand(OP_GETSTATUS, SUB_DOOR, 0xBB, OP_GETSTATUS, SUB_DOOR,
                         CMD_RESULT_MS, resp);
        if (ok) {
          m_state.door = resp[0x08];
          ESP_LOGI(TAG, "door status: 0x%02x", m_state.door);
        }
      }
      if (ok) {
        ok = sendCommand(OP_GETSTATUS, SUB_BATTERY, 0xBB, OP_GETSTATUS,
                         SUB_BATTERY, CMD_RESULT_MS, resp);
        if (ok) {
          m_state.batteryMv =
              static_cast<uint16_t>(resp[0x08] | (resp[0x09] << 8));
          ESP_LOGI(TAG, "battery: %u mV", (unsigned)m_state.batteryMv);
        }
      }
      break;
    }
  }

  reportResult(cmd, ok, error, (esp_timer_get_time() - t0) / 1000);

  // Linger: hold the session so a second command rides it.
  if (ok) {
    const int64_t lingerUntil =
        esp_timer_get_time() + static_cast<int64_t>(LINGER_MS) * 1000;
    while (esp_timer_get_time() < lingerUntil) {
      Ev ev{};
      if (xQueueReceive(m_events, &ev, pdMS_TO_TICKS(50)) == pdTRUE) {
        if (ev.type == EvType::NotifyCmd) {
          // Handle the result (0xBB) if it arrives during the linger.
          Frame f = ev.frame;
          yale::decryptCommand(f, m_cbc);
          m_lastRxUs = esp_timer_get_time();
          if (f[0] == 0xAA || f[0] == 0xBB) {
            m_lastCmdRxUs = esp_timer_get_time();
            handleCommandFrame(f);
          }
        } else {
          // Re-queue anything else (e.g. a new Command) for the main loop.
          xQueueSend(m_events, &ev, 0);
        }
      }
    }
    disconnect();
  }
}

void YaleBleLock::disconnect() {
  if (m_conn != 0xFFFF) {
    ble_gap_terminate(m_conn, BLE_ERR_REM_USER_CONN_TERM);
    // Wait for the disconnect event so the connection is fully torn down.
    Ev ev{};
    waitFor(EvType::Disconnected, 2000, ev);
  }
  m_sessionReady = false;
}

void YaleBleLock::reportResult(Cmd cmd, bool ok, uint8_t error,
                               int64_t elapsedMs) {
  if (m_resultCb) {
    Result r{cmd, ok, error, elapsedMs};
    m_resultCb(r, m_resultCbArg);
  }
}

// ------------------------------------------------------------------ cache

void YaleBleLock::loadCache() {
  const nvs_config::GattCache c = nvs_config::loadGattCache();
  if (!c.valid) return;
  m_gattCached = true;
  m_addrKnown = true;
  m_peerAddrType = c.addrType;
  m_svcStart = c.svcStart;
  m_svcEnd = c.svcEnd;
  m_hWrite = c.hWrite;
  m_hRead = c.hRead;
  m_hSecWrite = c.hSecWrite;
  m_hSecRead = c.hSecRead;
  m_hReadCccd = c.hReadCccd;
  m_hSecReadCccd = c.hSecReadCccd;
  m_readProps = c.readProps;
  m_secReadProps = c.secReadProps;
  ESP_LOGI(TAG, "GATT cache loaded");
}

void YaleBleLock::saveCache() {
  nvs_config::GattCache c{};
  c.valid = true;
  c.addrType = m_peerAddrType;
  c.svcStart = m_svcStart;
  c.svcEnd = m_svcEnd;
  c.hWrite = m_hWrite;
  c.hRead = m_hRead;
  c.hSecWrite = m_hSecWrite;
  c.hSecRead = m_hSecRead;
  c.hReadCccd = m_hReadCccd;
  c.hSecReadCccd = m_hSecReadCccd;
  c.readProps = m_readProps;
  c.secReadProps = m_secReadProps;
  nvs_config::saveGattCache(c);
}

void YaleBleLock::clearCache() {
  m_gattCached = false;
  m_addrKnown = false;
  nvs_config::clearGattCache();
}

// ------------------------------------------------------------------ waitFor

bool YaleBleLock::waitFor(EvType type, uint32_t timeoutMs, Ev& out) {
  const int64_t deadline =
      esp_timer_get_time() + static_cast<int64_t>(timeoutMs) * 1000;
  while (true) {
    const int64_t remainMs = (deadline - esp_timer_get_time()) / 1000;
    if (remainMs <= 0) return false;
    Ev ev{};
    if (xQueueReceive(m_events, &ev, pdMS_TO_TICKS(50)) != pdTRUE) continue;
    if (ev.type == type) {
      // Decrypt command frames before returning them to the caller.
      if (type == EvType::NotifyCmd) {
        yale::decryptCommand(ev.frame, m_cbc);
        m_lastRxUs = esp_timer_get_time();
        if (ev.frame[0] == 0xAA || ev.frame[0] == 0xBB) {
          m_lastCmdRxUs = esp_timer_get_time();
        }
      }
      out = ev;
      return true;
    }
    // Not the event we're waiting for: handle it inline. Never re-queue —
    // that would spin forever on the same event.
    switch (ev.type) {
      case EvType::NotifyCmd: {
        Frame f = ev.frame;
        yale::decryptCommand(f, m_cbc);
        m_lastRxUs = esp_timer_get_time();
        if (f[0] == 0xAA || f[0] == 0xBB) {
          m_lastCmdRxUs = esp_timer_get_time();
          handleCommandFrame(f);
        }
        break;
      }
      case EvType::Disconnected:
        m_conn = 0xFFFF;
        m_sessionReady = false;
        m_lastDisconnectUs = esp_timer_get_time();
        if (type == EvType::Disconnected) {
          out = ev;
          return true;
        }
        break;
      case EvType::ConnectFailed:
        m_conn = 0xFFFF;
        // A rejected connect (e.g. the lock is at its connection limit) is
        // final for this attempt — return at once so the caller can back off
        // and retry instead of blocking for the whole connect timeout.
        if (type == EvType::Connected) {
          out = ev;
          return false;
        }
        break;
      case EvType::Connected:
        m_conn = static_cast<uint16_t>(ev.status);
        m_directFailures = 0;
        break;
      case EvType::DiscFound:
        // The lock answered the scan; remember it so scanAndConnect() can
        // connect. (waitFor(DiscDone) consumes this event, so it must be
        // handled here, not only in run().)
        m_scanMatched = true;
        m_peerAddrType = ev.addrType;
        m_addrKnown = true;
        break;
      case EvType::Synced:
        m_synced = true;
        break;
      default:
        break;  // ignore (DiscDone, GattDone, NotifySecure)
    }
  }
}