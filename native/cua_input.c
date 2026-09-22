#include <xkbcommon/xkbcommon.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static struct xkb_context *xkb_context = NULL;
static struct xkb_keymap *xkb_keymap = NULL;
static int compositor_input_fd = -1;
static struct sockaddr_un compositor_input_addr;
static int compositor_error_reported = 0;

static int init_compositor_input(void) {
    const char *path = getenv("MCPBROWSER_CUA_INPUT_SOCKET");
    if (!path || !*path) {
        fprintf(stderr,
                "mcpbrowser-cua-input: configure nativeSystem.inputSocket (MCPBROWSER_CUA_INPUT_SOCKET)\n");
        return 0;
    }
    if (strlen(path) >= sizeof(compositor_input_addr.sun_path)) {
        fprintf(stderr, "mcpbrowser-cua-input: compositor input socket path too long\n");
        return 0;
    }
    compositor_input_fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (compositor_input_fd < 0) {
        fprintf(stderr, "mcpbrowser-cua-input: cannot create compositor input socket: %s\n",
                strerror(errno));
        return 0;
    }
    memset(&compositor_input_addr, 0, sizeof(compositor_input_addr));
    compositor_input_addr.sun_family = AF_UNIX;
    strcpy(compositor_input_addr.sun_path, path);
    return 1;
}

static int send_compositor_input(const char *line) {
    if (compositor_input_fd < 0 && !init_compositor_input())
        return 0;
    size_t len = strlen(line);
    while (len && (line[len - 1] == '\n' || line[len - 1] == '\r'))
        --len;
    if (!len)
        return 1;
    const ssize_t sent =
        sendto(compositor_input_fd, line, len, 0, (const struct sockaddr *)&compositor_input_addr,
               sizeof(compositor_input_addr));
    if (sent == (ssize_t)len) {
        compositor_error_reported = 0;
        return 1;
    }
    if (!compositor_error_reported) {
        fprintf(stderr, "mcpbrowser-cua-input: compositor input injection failed: %s\n",
                sent < 0 ? strerror(errno) : "short datagram");
        compositor_error_reported = 1;
    }
    return 0;
}

static int load_keyboard_mapping(void) {
    const struct xkb_rule_names names = {
        .rules = "evdev",
        .model = "pc105",
        .layout = "us",
        .variant = NULL,
        .options = NULL,
    };
    xkb_context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!xkb_context)
        return 0;
    xkb_keymap = xkb_keymap_new_from_names2(xkb_context, &names, XKB_KEYMAP_FORMAT_TEXT_V1,
                                            XKB_KEYMAP_COMPILE_NO_FLAGS);
    return xkb_keymap != NULL;
}

static int keycode_for_keysym(xkb_keysym_t sym, int *level_out) {
    if (!xkb_keymap || sym == XKB_KEY_NoSymbol)
        return 0;
    const xkb_keycode_t first = xkb_keymap_min_keycode(xkb_keymap);
    const xkb_keycode_t last = xkb_keymap_max_keycode(xkb_keymap);
    for (xkb_keycode_t keycode = first; keycode <= last; ++keycode) {
        const xkb_layout_index_t layouts = xkb_keymap_num_layouts_for_key(xkb_keymap, keycode);
        for (xkb_layout_index_t layout = 0; layout < layouts; ++layout) {
            const xkb_level_index_t levels =
                xkb_keymap_num_levels_for_key(xkb_keymap, keycode, layout);
            for (xkb_level_index_t level = 0; level < levels; ++level) {
                const xkb_keysym_t *syms = NULL;
                const int count =
                    xkb_keymap_key_get_syms_by_level(xkb_keymap, keycode, layout, level, &syms);
                for (int i = 0; i < count; ++i) {
                    if (syms[i] == sym) {
                        if (level_out)
                            *level_out = (int)level;
                        return (int)keycode;
                    }
                }
            }
        }
    }
    return 0;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

static size_t decode_hex(const char *hex, unsigned char *out, size_t cap) {
    size_t n = 0;
    while (hex[0] && hex[1] && n + 1 < cap) {
        const int hi = hexval(hex[0]);
        const int lo = hexval(hex[1]);
        if (hi < 0 || lo < 0)
            break;
        out[n++] = (unsigned char)((hi << 4) | lo);
        hex += 2;
    }
    out[n] = 0;
    return n;
}

static uint32_t utf8_one(const unsigned char *s, size_t n, size_t *used) {
    if (!n)
        return 0;
    if (s[0] < 0x80) {
        *used = 1;
        return s[0];
    }
    if ((s[0] & 0xe0) == 0xc0 && n >= 2) {
        *used = 2;
        return ((uint32_t)(s[0] & 0x1f) << 6) | (s[1] & 0x3f);
    }
    if ((s[0] & 0xf0) == 0xe0 && n >= 3) {
        *used = 3;
        return ((uint32_t)(s[0] & 0x0f) << 12) | ((uint32_t)(s[1] & 0x3f) << 6) | (s[2] & 0x3f);
    }
    if ((s[0] & 0xf8) == 0xf0 && n >= 4) {
        *used = 4;
        return ((uint32_t)(s[0] & 0x07) << 18) | ((uint32_t)(s[1] & 0x3f) << 12) |
               ((uint32_t)(s[2] & 0x3f) << 6) | (s[3] & 0x3f);
    }
    *used = 1;
    return 0xfffd;
}

static xkb_keysym_t named_keysym(const char *key) {
    struct pair {
        const char *js;
        const char *xkb;
    };
    static const struct pair map[] = {
        {"Enter", "Return"},
        {"Escape", "Escape"},
        {"Esc", "Escape"},
        {"Backspace", "BackSpace"},
        {"Delete", "Delete"},
        {"Tab", "Tab"},
        {"ArrowLeft", "Left"},
        {"ArrowRight", "Right"},
        {"ArrowUp", "Up"},
        {"ArrowDown", "Down"},
        {"Shift", "Shift_L"},
        {"Control", "Control_L"},
        {"Alt", "Alt_L"},
        {"Meta", "Super_L"},
        {"CapsLock", "Caps_Lock"},
        {"PageUp", "Prior"},
        {"PageDown", "Next"},
        {"Home", "Home"},
        {"End", "End"},
        {"Insert", "Insert"},
        {" ", "space"},
    };
    for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); ++i) {
        if (!strcmp(key, map[i].js))
            return xkb_keysym_from_name(map[i].xkb, XKB_KEYSYM_CASE_INSENSITIVE);
    }
    return xkb_keysym_from_name(key, XKB_KEYSYM_CASE_INSENSITIVE);
}

static xkb_keysym_t key_string_to_keysym(const unsigned char *buf, size_t n) {
    if (!n)
        return XKB_KEY_NoSymbol;
    size_t used = 0;
    const uint32_t cp = utf8_one(buf, n, &used);
    if (used == n)
        return xkb_utf32_to_keysym(cp);
    return named_keysym((const char *)buf);
}

static int evdev_code_for_keysym(xkb_keysym_t sym, int *level_out) {
    int level = 0;
    const int keycode = keycode_for_keysym(sym, &level);
    if (!keycode || keycode < 8)
        return 0;
    if (level_out)
        *level_out = level;
    return keycode - 8;
}

static void send_key(int down, xkb_keysym_t sym) {
    int level = 0;
    const int evdev = evdev_code_for_keysym(sym, &level);
    if (!evdev)
        return;
    char line[64];
    snprintf(line, sizeof(line), "k %c %d\n", down ? 'd' : 'u', evdev);
    send_compositor_input(line);
}

static int type_keysym(xkb_keysym_t sym) {
    int level = 0;
    const int evdev = evdev_code_for_keysym(sym, &level);
    if (!evdev)
        return 0;
    int shift_level = 0;
    const int shift = evdev_code_for_keysym(
        xkb_keysym_from_name("Shift_L", XKB_KEYSYM_CASE_INSENSITIVE), &shift_level);
    const int need_shift = (level & 1) != 0;
    char line[64];
    if (need_shift && shift) {
        snprintf(line, sizeof(line), "k d %d\n", shift);
        send_compositor_input(line);
    }
    snprintf(line, sizeof(line), "k d %d\n", evdev);
    send_compositor_input(line);
    snprintf(line, sizeof(line), "k u %d\n", evdev);
    send_compositor_input(line);
    if (need_shift && shift) {
        snprintf(line, sizeof(line), "k u %d\n", shift);
        send_compositor_input(line);
    }
    return 1;
}

static void send_text_fallback(const unsigned char *bytes, size_t n) {
    if (!n)
        return;
    static const char hex[] = "0123456789abcdef";
    char line[16384];
    if (2 + n * 2 >= sizeof(line))
        return;
    size_t pos = 0;
    line[pos++] = 't';
    line[pos++] = ' ';
    for (size_t i = 0; i < n; ++i) {
        line[pos++] = hex[bytes[i] >> 4];
        line[pos++] = hex[bytes[i] & 0x0f];
    }
    line[pos] = 0;
    send_compositor_input(line);
}

int main(void) {
    if (!load_keyboard_mapping()) {
        fprintf(stderr, "mcpbrowser-cua-input: xkb keyboard mapping unavailable\n");
        return 3;
    }
    init_compositor_input();

    char line[8192];
    while (fgets(line, sizeof(line), stdin)) {
        char op = 0;
        if (sscanf(line, " %c", &op) != 1)
            continue;

        if (op == 'm' || op == 'c' || op == 'd' || op == 'u' || op == 'w') {
            send_compositor_input(line);
        } else if (op == 'k') {
            char direction = 0;
            char hex[4096] = {0};
            if (sscanf(line, " %c %c %4095s", &op, &direction, hex) == 3) {
                unsigned char decoded[2048];
                const size_t n = decode_hex(hex, decoded, sizeof(decoded));
                const xkb_keysym_t sym = key_string_to_keysym(decoded, n);
                if (sym != XKB_KEY_NoSymbol)
                    send_key(direction == 'd', sym);
            }
        } else if (op == 't') {
            char hex[8192] = {0};
            if (sscanf(line, " %c %8191s", &op, hex) == 2) {
                unsigned char decoded[4096];
                const size_t n = decode_hex(hex, decoded, sizeof(decoded));
                size_t off = 0;
                size_t fallback_start = 0;
                size_t fallback_len = 0;
                while (off < n) {
                    size_t used = 0;
                    const uint32_t cp = utf8_one(decoded + off, n - off, &used);
                    if (!used)
                        break;
                    const xkb_keysym_t sym = xkb_utf32_to_keysym(cp);
                    int mapped_level = 0;
                    const int mapped =
                        sym != XKB_KEY_NoSymbol && evdev_code_for_keysym(sym, &mapped_level);
                    if (mapped) {
                        if (fallback_len) {
                            send_text_fallback(decoded + fallback_start, fallback_len);
                            fallback_len = 0;
                        }
                        type_keysym(sym);
                    } else {
                        if (!fallback_len)
                            fallback_start = off;
                        fallback_len += used;
                    }
                    off += used;
                }
                if (fallback_len)
                    send_text_fallback(decoded + fallback_start, fallback_len);
            }
        }
    }

    if (compositor_input_fd >= 0)
        close(compositor_input_fd);
    if (xkb_keymap)
        xkb_keymap_unref(xkb_keymap);
    if (xkb_context)
        xkb_context_unref(xkb_context);
    return 0;
}
