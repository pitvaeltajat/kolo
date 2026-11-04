idf_component_register(
    SRCS
        "main.cpp"
        "nvs_config.cpp"
        "cli.cpp"
        "yale/yale_crypto.cpp"
        "yale/YaleBleLock.cpp"
        "net/net.cpp"
    INCLUDE_DIRS
        "."
        "yale"
        "net"
    REQUIRES
        nvs_flash
        bt
        mbedtls
        esp_timer
        console
        vfs
        driver
        esp_wifi
        esp_event
        esp_netif
        esp-tls
        mqtt
        esp_http_client
        json
        lwip
    EMBED_TXTFILES
        "../../mqtt-ca.crt"
)

# Host-side unit tests for the protocol crypto (no ESP-IDF needed).
# Build with: cmake -S test -B build-test && cmake --build build-test && ./build-test/test_crypto
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_executable(test_crypto test/test_crypto.cpp yale/yale_crypto.cpp)
    target_include_directories(test_crypto PRIVATE yale)
    target_compile_options(test_crypto PRIVATE -Wall -Wextra)
    find_package(MbedTLS REQUIRED)
    target_link_libraries(test_crypto PRIVATE MbedTLS::mbedtls)
endif()