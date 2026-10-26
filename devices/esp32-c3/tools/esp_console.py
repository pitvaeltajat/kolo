#!/usr/bin/env python3
"""Talk to the kolo door firmware console over USB-Serial-JTAG.

Usage: esp_console.py <port> <command> [command...]
Sends each command, then keeps reading for a settle period so async worker
output (BLE scan/connect/status) is captured too.
"""
import sys
import time
import serial

def main():
    port = sys.argv[1]
    cmds = sys.argv[2:]
    settle = float(sys.argv[0] and 0)  # placeholder
    # Optional: ESP_SETTLE=<seconds> env to wait after the last command.
    import os
    settle = float(os.environ.get("ESP_SETTLE", "12"))
    ser = serial.Serial(port, 115200, timeout=0.2)
    time.sleep(0.3)
    ser.reset_input_buffer()

    for i, cmd in enumerate(cmds):
        ser.write((cmd + "\r\n").encode())
        ser.flush()
        buf = b""
        # Wait for the prompt (command accepted), then keep reading.
        deadline = time.time() + 5
        while time.time() < deadline:
            chunk = ser.read(256)
            if chunk:
                buf += chunk
                if b"kolo> " in buf:
                    break
        # After the last command, keep draining for the settle period so the
        # async worker output lands.
        if i == len(cmds) - 1:
            end = time.time() + settle
            while time.time() < end:
                chunk = ser.read(256)
                if chunk:
                    buf += chunk
        sys.stdout.write(buf.decode(errors="replace"))
        sys.stdout.flush()
    ser.close()

if __name__ == "__main__":
    main()
