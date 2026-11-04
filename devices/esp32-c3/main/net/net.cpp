#include "net/net.hpp"

#include <ctime>
#include <cstring>
#include <string>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "mbedtls/md.h"
#include "mqtt_client.h"
#include "nvs_config.h"

namespace net {
namespace {

const char* TAG = "net";

// --- Fixed contract constants (see devices/README.md / kolo-door.yaml) -------
constexpr const char* DEVICE = "door";
constexpr const char* KOLO_URL = "https://kolo.pitva.fi/api/state";
constexpr const char* MQTT_USER = "kolo";
constexpr int MQTT_PORT = 8883;
constexpr const char* TOPIC_CMD = "kolo/door/cmd";
constexpr const char* TOPIC_ACK = "kolo/door/ack";
constexpr int64_t SKEW_MS = 30000;          // matches COMMAND_SKEW_MS
constexpr int64_t STATE_POLL_US = 900000000;  // 15 min status refresh

// Broker CA (private), embedded from devices/mqtt-ca.crt.
extern "C" const char mqtt_ca_pem_start[] asm("_binary_mqtt_ca_crt_start");

YaleBleLock* s_lock = nullptr;
nvs_config::NetConfig s_cfg;
esp_mqtt_client_handle_t s_mqtt = nullptr;
volatile bool s_wifiUp = false;
volatile bool s_mqttUp = false;
QueueHandle_t s_reportQ = nullptr;  // trigger-only queue for the reporter task

// Pending command awaiting its BLE result, so onResult can ack the right one.
char s_pendingNonce[33] = {0};
YaleBleLock::Cmd s_pendingCmd = YaleBleLock::Cmd::Status;
bool s_pendingAck = false;

// Small replay guard: the last N accepted nonces (±30 s window bounds it).
constexpr int NONCE_RING = 16;
char s_nonces[NONCE_RING][33] = {};
int s_nonceHead = 0;

bool clockSynced() {
  time_t now = time(nullptr);
  return now > 1700000000;  // after 2023-11; i.e. SNTP has run
}
int64_t nowMs() { return (int64_t)time(nullptr) * 1000; }

bool nonceSeen(const char* n) {
  for (auto& e : s_nonces)
    if (e[0] && std::strncmp(e, n, 32) == 0) return true;
  return false;
}
void nonceRemember(const char* n) {
  std::strncpy(s_nonces[s_nonceHead], n, 32);
  s_nonces[s_nonceHead][32] = 0;
  s_nonceHead = (s_nonceHead + 1) % NONCE_RING;
}

// HMAC-SHA256(key, msg) as lowercase hex (64 chars). Matches kolo_crypto.h.
std::string hmacHex(const std::string& key, const char* msg, size_t len) {
  uint8_t out[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, (const uint8_t*)key.data(), key.size(),
                  (const uint8_t*)msg, len, out);
  static const char* H = "0123456789abcdef";
  std::string hex(64, '0');
  for (int i = 0; i < 32; i++) {
    hex[i * 2] = H[out[i] >> 4];
    hex[i * 2 + 1] = H[out[i] & 0xf];
  }
  return hex;
}

bool sigEqual(const std::string& a, const char* b) {
  if (a.size() != std::strlen(b)) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.size(); i++) diff |= (uint8_t)a[i] ^ (uint8_t)b[i];
  return diff == 0;
}

std::string randomNonce() {
  static const char* H = "0123456789abcdef";
  std::string s(32, '0');
  for (int i = 0; i < 16; i++) {
    uint8_t b = (uint8_t)esp_random();
    s[i * 2] = H[b >> 4];
    s[i * 2 + 1] = H[b & 0xf];
  }
  return s;
}

// Wrap a finished payload-object (cJSON) in a signed envelope string. Adds ts +
// nonce to the payload first; signs the exact payload bytes we emit. Caller owns
// `payload` (deleted here).
std::string buildEnvelope(cJSON* payload) {
  cJSON_AddStringToObject(payload, "device", DEVICE);
  cJSON_AddNumberToObject(payload, "ts", (double)nowMs());
  cJSON_AddItemToObject(payload, "nonce",
                        cJSON_CreateString(randomNonce().c_str()));
  char* payStr = cJSON_PrintUnformatted(payload);
  cJSON_Delete(payload);
  std::string sig = hmacHex(s_cfg.hmacKey, payStr, std::strlen(payStr));

  cJSON* env = cJSON_CreateObject();
  cJSON_AddStringToObject(env, "device", DEVICE);
  cJSON_AddStringToObject(env, "payload", payStr);  // cJSON escapes it
  cJSON_AddStringToObject(env, "sig", sig.c_str());
  char* envStr = cJSON_PrintUnformatted(env);
  std::string out(envStr);
  cJSON_free(envStr);
  cJSON_free(payStr);
  cJSON_Delete(env);
  return out;
}

void publishAck(const char* replyNonce, bool ok, const char* detail) {
  if (!s_mqtt) return;
  cJSON* p = cJSON_CreateObject();
  cJSON_AddStringToObject(p, "reply", replyNonce);
  cJSON_AddStringToObject(p, "result", ok ? "ok" : "fail");
  if (detail) cJSON_AddStringToObject(p, "detail", detail);
  std::string env = buildEnvelope(p);
  esp_mqtt_client_publish(s_mqtt, TOPIC_ACK, env.c_str(), 0, 1, 0);
  ESP_LOGI(TAG, "ack %s for %.8s", ok ? "ok" : "fail", replyNonce);
}

// --- Inbound command ---------------------------------------------------------
void handleCmd(const char* data, int len) {
  cJSON* env = cJSON_ParseWithLength(data, len);
  if (!env) return;
  const cJSON* pay = cJSON_GetObjectItem(env, "payload");
  const cJSON* sig = cJSON_GetObjectItem(env, "sig");
  if (!cJSON_IsString(pay) || !cJSON_IsString(sig)) { cJSON_Delete(env); return; }

  std::string expect = hmacHex(s_cfg.hmacKey, pay->valuestring,
                               std::strlen(pay->valuestring));
  if (!sigEqual(expect, sig->valuestring)) {
    ESP_LOGW(TAG, "cmd: bad signature");
    cJSON_Delete(env);
    return;
  }

  cJSON* body = cJSON_Parse(pay->valuestring);
  cJSON_Delete(env);
  if (!body) return;

  const cJSON* ts = cJSON_GetObjectItem(body, "ts");
  const cJSON* nonce = cJSON_GetObjectItem(body, "nonce");
  const cJSON* action = cJSON_GetObjectItem(body, "action");
  if (!cJSON_IsNumber(ts) || !cJSON_IsString(nonce) || !cJSON_IsString(action)) {
    cJSON_Delete(body);
    return;
  }
  // Fail closed: no trusted clock → can't bound replay, so reject.
  if (!clockSynced()) {
    ESP_LOGW(TAG, "cmd: clock not synced, rejecting");
    cJSON_Delete(body);
    return;
  }
  int64_t skew = nowMs() - (int64_t)ts->valuedouble;
  if (skew < 0) skew = -skew;
  if (skew > SKEW_MS) {
    ESP_LOGW(TAG, "cmd: stale (%lld ms)", (long long)skew);
    cJSON_Delete(body);
    return;
  }
  if (nonceSeen(nonce->valuestring)) {
    ESP_LOGW(TAG, "cmd: replayed nonce");
    cJSON_Delete(body);
    return;
  }

  const char* act = action->valuestring;
  YaleBleLock::Cmd cmd;
  if (std::strcmp(act, "unlock") == 0) {
    cmd = YaleBleLock::Cmd::Unlock;
  } else if (std::strcmp(act, "lock") == 0) {
    cmd = YaleBleLock::Cmd::Lock;
  } else {
    // Unknown/unsupported (e.g. "enroll" — phase 4): ack fail so the app
    // doesn't hang for the full timeout.
    publishAck(nonce->valuestring, false, "unsupported action");
    cJSON_Delete(body);
    return;
  }

  nonceRemember(nonce->valuestring);
  std::strncpy(s_pendingNonce, nonce->valuestring, 32);
  s_pendingNonce[32] = 0;
  s_pendingCmd = cmd;
  s_pendingAck = true;
  ESP_LOGI(TAG, "cmd %s (nonce %.8s)", act, nonce->valuestring);
  if (s_lock) s_lock->request(cmd);
  cJSON_Delete(body);
}

// Called from the BLE worker task when a command finishes.
void onResult(const YaleBleLock::Result& r, void*) {
  const bool isOp =
      r.cmd == YaleBleLock::Cmd::Unlock || r.cmd == YaleBleLock::Cmd::Lock;
  if (s_pendingAck && r.cmd == s_pendingCmd && isOp) {
    s_pendingAck = false;
    publishAck(s_pendingNonce, r.ok, r.ok ? nullptr : "lock rejected");
  }
  if (isOp) {
    // An unlock/lock does NOT refresh state() (the lock's result frame lands
    // during the linger, after this callback). Reporting now would send the
    // stale pre-command lock state. Instead read authoritative state (lock +
    // door), and let that Status result post it below.
    if (r.ok && s_lock) s_lock->request(YaleBleLock::Cmd::Status);
  } else if (s_reportQ) {
    // Status completed — state() is fresh, report it.
    uint8_t t = 1;
    xQueueSend(s_reportQ, &t, 0);
  }
}

// --- State report (HTTPS POST /api/state) -----------------------------------
void postState() {
  if (!s_lock || !clockSynced()) return;
  YaleBleLock::State st = s_lock->state();
  cJSON* p = cJSON_CreateObject();
  cJSON_AddStringToObject(p, "kind", "DOOR");
  if (st.lock != 0xFF)
    cJSON_AddBoolToObject(p, "locked", st.lock == yale::LOCK_LOCKED);
  if (st.door != 0xFF)
    cJSON_AddBoolToObject(p, "doorOpen", st.door != yale::DOOR_CLOSED);
  if (st.batteryMv) cJSON_AddNumberToObject(p, "battery", st.batteryMv);
  std::string env = buildEnvelope(p);

  esp_http_client_config_t cfg = {};
  cfg.url = KOLO_URL;
  cfg.method = HTTP_METHOD_POST;
  cfg.crt_bundle_attach = esp_crt_bundle_attach;  // public CA for kolo.pitva.fi
  cfg.timeout_ms = 8000;
  esp_http_client_handle_t h = esp_http_client_init(&cfg);
  esp_http_client_set_header(h, "Content-Type", "application/json");
  esp_http_client_set_post_field(h, env.c_str(), env.size());
  esp_err_t err = esp_http_client_perform(h);
  if (err == ESP_OK)
    ESP_LOGI(TAG, "state posted (%d)", esp_http_client_get_status_code(h));
  else
    ESP_LOGW(TAG, "state post failed: %s", esp_err_to_name(err));
  esp_http_client_cleanup(h);
}

void reporterTask(void*) {
  uint8_t t;
  while (true) {
    if (xQueueReceive(s_reportQ, &t, portMAX_DELAY) == pdTRUE) postState();
  }
}

// --- MQTT --------------------------------------------------------------------
void mqttEvent(void*, esp_event_base_t, int32_t id, void* data) {
  auto* e = static_cast<esp_mqtt_event_handle_t>(data);
  switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED:
      s_mqttUp = true;
      esp_mqtt_client_subscribe(s_mqtt, TOPIC_CMD, 1);
      ESP_LOGI(TAG, "mqtt connected, subscribed %s", TOPIC_CMD);
      if (s_lock) s_lock->request(YaleBleLock::Cmd::Status);  // seed state
      break;
    case MQTT_EVENT_DISCONNECTED:
      s_mqttUp = false;
      ESP_LOGW(TAG, "mqtt disconnected");
      break;
    case MQTT_EVENT_DATA:
      if (e->topic_len && std::strncmp(e->topic, TOPIC_CMD, e->topic_len) == 0)
        handleCmd(e->data, e->data_len);
      break;
    default:
      break;
  }
}

void startMqtt() {
  if (s_mqtt) return;
  static std::string uri;  // must outlive the client
  uri = "mqtts://" + s_cfg.mqttHost + ":" + std::to_string(MQTT_PORT);
  esp_mqtt_client_config_t cfg = {};
  cfg.broker.address.uri = uri.c_str();
  cfg.broker.verification.certificate = mqtt_ca_pem_start;
  cfg.credentials.username = MQTT_USER;
  cfg.credentials.authentication.password = s_cfg.mqttPass.c_str();
  s_mqtt = esp_mqtt_client_init(&cfg);
  esp_mqtt_client_register_event(s_mqtt, MQTT_EVENT_ANY, mqttEvent, nullptr);
  esp_mqtt_client_start(s_mqtt);
  ESP_LOGI(TAG, "mqtt client → %s", uri.c_str());
}

// --- WiFi + SNTP -------------------------------------------------------------
void onGotIp() {
  s_wifiUp = true;
  esp_sntp_config_t sc = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  esp_netif_sntp_init(&sc);
  startMqtt();
}

void wifiEvent(void*, esp_event_base_t base, int32_t id, void* data) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_err_t e = esp_wifi_connect();
    ESP_LOGI(TAG, "STA_START → connect rc=%s", esp_err_to_name(e));
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    s_wifiUp = false;
    auto* d = static_cast<wifi_event_sta_disconnected_t*>(data);
    ESP_LOGW(TAG, "STA_DISCONNECTED reason=%d; retrying", d ? d->reason : -1);
    vTaskDelay(pdMS_TO_TICKS(1000));  // brief backoff so we don't spin
    esp_wifi_connect();
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ESP_LOGI(TAG, "wifi got IP");
    onGotIp();
  }
}

void periodicStatus(void*) {
  if (s_lock && s_mqttUp) s_lock->request(YaleBleLock::Cmd::Status);
}

}  // namespace

void start(YaleBleLock* lock) {
  s_lock = lock;
  s_cfg = nvs_config::loadNet();
  if (!s_cfg.valid()) {
    ESP_LOGW(TAG, "net disabled: set WiFi/MQTT/HMAC (setwifi/setmqtt/sethmac)");
    return;
  }

  s_reportQ = xQueueCreate(4, sizeof(uint8_t));
  xTaskCreate(reporterTask, "net-report", 6144, nullptr, 4, nullptr);
  if (s_lock) s_lock->addResultCallback(onResult, nullptr);

  ESP_ERROR_CHECK(esp_netif_init());
  esp_err_t le = esp_event_loop_create_default();
  if (le != ESP_OK && le != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(le);
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t wc = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&wc));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                      wifiEvent, nullptr, nullptr));
  ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                      wifiEvent, nullptr, nullptr));
  wifi_config_t wcfg = {};
  std::strncpy((char*)wcfg.sta.ssid, s_cfg.wifiSsid.c_str(), sizeof(wcfg.sta.ssid) - 1);
  std::strncpy((char*)wcfg.sta.password, s_cfg.wifiPass.c_str(),
               sizeof(wcfg.sta.password) - 1);
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wcfg));
  ESP_ERROR_CHECK(esp_wifi_start());
  ESP_LOGI(TAG, "wifi starting, ssid=%s", s_cfg.wifiSsid.c_str());

  const esp_timer_create_args_t ta = {.callback = periodicStatus,
                                      .arg = nullptr,
                                      .dispatch_method = ESP_TIMER_TASK,
                                      .name = "net-poll",
                                      .skip_unhandled_events = true};
  esp_timer_handle_t timer;
  esp_timer_create(&ta, &timer);
  esp_timer_start_periodic(timer, STATE_POLL_US);
}

void printStatus() {
  std::printf("wifi: %s  mqtt: %s  clock: %s\n", s_wifiUp ? "up" : "down",
              s_mqttUp ? "up" : "down", clockSynced() ? "synced" : "unsynced");
}

}  // namespace net
