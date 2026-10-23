cmake_minimum_required(VERSION 3.16)
project(test_crypto C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(test_crypto test_crypto.cpp ../main/yale/yale_crypto.cpp)
target_include_directories(test_crypto PRIVATE ../main)
target_compile_options(test_crypto PRIVATE -Wall -Wextra)

# Build the mbedTLS bundled with ESP-IDF (v3.x) from source so the host tests
# exercise the exact same crypto the firmware uses. The system lib is 2.x and
# has a different ABI (mbedtls_aes_crypt_cbc iv param const-ness).
set(MBEDTLS_SRC "$ENV{HOME}/esp/esp-idf/components/mbedtls/mbedtls")
if(NOT EXISTS "${MBEDTLS_SRC}/library/aes.c")
  message(FATAL_ERROR "ESP-IDF mbedTLS not found at ${MBEDTLS_SRC} — set MBEDTLS_SRC")
endif()

add_library(mbedtls_host STATIC
  ${MBEDTLS_SRC}/library/aes.c
  ${MBEDTLS_SRC}/library/aesni.c
  ${MBEDTLS_SRC}/library/cipher.c
  ${MBEDTLS_SRC}/library/cipher_wrap.c
  ${MBEDTLS_SRC}/library/platform.c
  ${MBEDTLS_SRC}/library/platform_util.c
  ${MBEDTLS_SRC}/library/constant_time.c
)
target_include_directories(mbedtls_host PUBLIC ${MBEDTLS_SRC}/include)
# Use mbedTLS's own default config (AES enabled) rather than ESP-IDF's
# esp_config.h, which needs sdkconfig.h.
target_compile_definitions(mbedtls_host PRIVATE MBEDTLS_CONFIG_FILE="mbedtls/mbedtls_config.h")

target_link_libraries(test_crypto PRIVATE mbedtls_host)