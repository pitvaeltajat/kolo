#include "cli.h"

#include <cstdio>
#include <cstring>
#include <string>

#include "esp_console.h"
#include "esp_log.h"
#include "esp_vfs_dev.h"
#include "linenoise/linenoise.h"
#include "nvs_config.h"

namespace {

YaleBleLock* g_lock = nullptr;

void printMac(const std::array<uint8_t, 6>& mac) {
  std::printf("%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3],
              mac[4], mac[5]);
}

void onResult(const YaleBleLock::Result& r, void*) {
  std::printf("\n[%s] %s (%lld ms)%s\n", r.ok ? "OK" : "FAIL",
              r.cmd == YaleBleLock::Cmd::Unlock ? "unlock"
              : r.cmd == YaleBleLock::Cmd::Lock ? "lock"
                                                : "status",
              (long long)r.elapsedMs, r.error ? " (error 0x%02x)" : "");
}

int cmd_scan(int argc, char** argv) {
  // Scan is implemented by the worker via a Status command with a flag; for
  // now, trigger a status read which connects (and scans if needed).
  if (!g_lock) return 1;
  g_lock->request(YaleBleLock::Cmd::Status);
  return 0;
}

int cmd_status(int argc, char** argv) {
  if (!g_lock) return 1;
  g_lock->request(YaleBleLock::Cmd::Status);
  return 0;
}

int cmd_unlock(int argc, char** argv) {
  if (!g_lock) return 1;
  g_lock->request(YaleBleLock::Cmd::Unlock);
  return 0;
}

int cmd_lock(int argc, char** argv) {
  if (!g_lock) return 1;
  g_lock->request(YaleBleLock::Cmd::Lock);
  return 0;
}

int cmd_setkey(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: setkey <32-hex>\n");
    return 1;
  }
  auto creds = nvs_config::loadCreds();
  if (!nvs_config::parseHex(argv[1], creds.key.data(), creds.key.size())) {
    std::printf("bad key (need 32 hex chars)\n");
    return 1;
  }
  creds.keyValid = true;
  nvs_config::saveCreds(creds);
  std::printf("key saved\n");
  return 0;
}

int cmd_setmac(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: setmac <aa:bb:cc:dd:ee:ff>\n");
    return 1;
  }
  auto creds = nvs_config::loadCreds();
  if (!nvs_config::parseMac(argv[1], creds.mac)) {
    std::printf("bad MAC\n");
    return 1;
  }
  creds.macValid = true;
  nvs_config::saveCreds(creds);
  std::printf("MAC saved: ");
  printMac(creds.mac);
  std::printf("\n");
  return 0;
}

int cmd_setslot(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: setslot <0-255>\n");
    return 1;
  }
  auto creds = nvs_config::loadCreds();
  creds.slot = static_cast<uint8_t>(std::atoi(argv[1]));
  nvs_config::saveCreds(creds);
  std::printf("slot saved: %u\n", (unsigned)creds.slot);
  return 0;
}

int cmd_info(int argc, char** argv) {
  auto creds = nvs_config::loadCreds();
  std::printf("MAC: ");
  if (creds.macValid)
    printMac(creds.mac);
  else
    std::printf("(unset)");
  std::printf("\nslot: %u\nkey: %s\n", (unsigned)creds.slot,
              creds.keyValid ? "(set, masked)" : "(unset)");
  return 0;
}

int cmd_forget(int argc, char** argv) {
  nvs_config::clearGattCache();
  std::printf("GATT cache cleared\n");
  return 0;
}

}  // namespace

namespace cli {

void init(YaleBleLock* lock) {
  g_lock = lock;
  if (g_lock) g_lock->setResultCallback(onResult, nullptr);

  esp_console_repl_t* repl = nullptr;
  esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
  repl_config.prompt = "kolo> ";
  repl_config.max_cmdline_length = 256;

  // The C3 supermini's native USB is USB-Serial-JTAG.
  esp_console_dev_usb_serial_jtag_config_t usb_config =
      ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(
      esp_console_new_repl_usb_serial_jtag(&usb_config, &repl_config, &repl));

  esp_console_cmd_t cmd{};
  cmd.command = "scan";
  cmd.help = "scan for the lock";
  cmd.func = cmd_scan;
  esp_console_cmd_register(&cmd);

  cmd.command = "status";
  cmd.help = "read lock/door/battery state";
  cmd.func = cmd_status;
  esp_console_cmd_register(&cmd);

  cmd.command = "unlock";
  cmd.help = "unlock the door";
  cmd.func = cmd_unlock;
  esp_console_cmd_register(&cmd);

  cmd.command = "lock";
  cmd.help = "lock the door";
  cmd.func = cmd_lock;
  esp_console_cmd_register(&cmd);

  cmd.command = "setkey";
  cmd.help = "set the offline key (32 hex chars)";
  cmd.func = cmd_setkey;
  esp_console_cmd_register(&cmd);

  cmd.command = "setmac";
  cmd.help = "set the lock MAC (aa:bb:cc:dd:ee:ff)";
  cmd.func = cmd_setmac;
  esp_console_cmd_register(&cmd);

  cmd.command = "setslot";
  cmd.help = "set the offline key slot (0-255)";
  cmd.func = cmd_setslot;
  esp_console_cmd_register(&cmd);

  cmd.command = "info";
  cmd.help = "show configured credentials (key masked)";
  cmd.func = cmd_info;
  esp_console_cmd_register(&cmd);

  cmd.command = "forget";
  cmd.help = "clear the GATT cache";
  cmd.func = cmd_forget;
  esp_console_cmd_register(&cmd);

  ESP_ERROR_CHECK(esp_console_start_repl(repl));
}

}  // namespace cli