#define _POSIX_C_SOURCE 200809L
#include <ghostty/vt/terminal.h>
#include <ghostty/vt/grid_ref_tracked.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static GhosttyTerminal terminal;
static GhosttyTrackedGridRef tracked[2];

static void check(GhosttyResult result) {
    if (result == GHOSTTY_SUCCESS) return;
    fprintf(stderr, "public C API returned %d\n", (int)result);
    exit(2);
}

static GhosttyPoint point(uint16_t x, uint32_t y) {
    GhosttyPoint value = {0};
    value.tag = GHOSTTY_POINT_TAG_ACTIVE;
    value.value.coordinate.x = x;
    value.value.coordinate.y = y;
    return value;
}

static void cursor(uint16_t *x, uint16_t *y, bool *wrap) {
    check(ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_X, x));
    check(ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_Y, y));
    check(ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP, wrap));
}

static void cell(uint16_t x, uint16_t y) {
    GhosttyGridRef ref = {.size = sizeof(GhosttyGridRef)};
    check(ghostty_terminal_grid_ref(terminal, point(x, y), &ref));
    GhosttyCell value;
    check(ghostty_grid_ref_cell(&ref, &value));
    GhosttyCellWide wide;
    check(ghostty_cell_get(value, GHOSTTY_CELL_DATA_WIDE, &wide));
    size_t count = 0;
    GhosttyResult result = ghostty_grid_ref_graphemes(&ref, NULL, 0, &count);
    if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE) check(result);
    uint32_t *codepoints = malloc((count + 1) * sizeof(uint32_t));
    if (!codepoints) {
        fprintf(stderr, "proof cell allocation failed for %zu codepoints\n", count);
        exit(2);
    }
    check(ghostty_grid_ref_graphemes(&ref, codepoints, count, &count));
    GhosttyStyle style = {.size = sizeof(GhosttyStyle)};
    check(ghostty_grid_ref_style(&ref, &style));
    printf("{\"cp\":[");
    for (size_t index = 0; index < count; index++) printf("%s%u", index ? "," : "", codepoints[index]);
    printf("],\"wide\":%d,\"fg\":[%d,%u],\"bold\":%s}",
           (int)wide, (int)style.fg_color.tag, style.fg_color.value.palette,
           style.bold ? "true" : "false");
    free(codepoints);
}

static void snapshot(void) {
    uint16_t cols, rows, x, y;
    bool wrap;
    GhosttyTerminalScreen screen;
    check(ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_COLS, &cols));
    check(ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_ROWS, &rows));
    check(ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen));
    cursor(&x, &y, &wrap);
    printf("{\"cols\":%u,\"rows\":%u,\"screen\":%d,\"cursor\":[%u,%u,%s],\"grid\":[", cols, rows, (int)screen, x, y, wrap ? "true" : "false");
    for (uint16_t row = 0; row < rows; row++) {
        GhosttyGridRef ref = {.size = sizeof(GhosttyGridRef)};
        GhosttyRow value;
        bool row_wrap, continuation;
        check(ghostty_terminal_grid_ref(terminal, point(0, row), &ref));
        check(ghostty_grid_ref_row(&ref, &value));
        check(ghostty_row_get(value, GHOSTTY_ROW_DATA_WRAP, &row_wrap));
        check(ghostty_row_get(value, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, &continuation));
        printf("%s{\"wrap\":%s,\"continuation\":%s,\"cells\":[", row ? "," : "", row_wrap ? "true" : "false", continuation ? "true" : "false");
        for (uint16_t col = 0; col < cols; col++) {
            if (col) printf(",");
            cell(col, row);
        }
        printf("]}");
    }
    printf("]}\n");
}

static void clear(void) {
    for (size_t index = 0; index < 2; index++) {
        ghostty_tracked_grid_ref_free(tracked[index]);
        tracked[index] = NULL;
    }
    ghostty_terminal_free(terminal);
    terminal = NULL;
}

static unsigned hex(char value) {
    if (value >= '0' && value <= '9') return (unsigned)(value - '0');
    if (value >= 'a' && value <= 'f') return (unsigned)(value - 'a' + 10);
    exit(2);
}

static void write_bytes(const char *line) {
    size_t size = strcspn(line, "\r\n");
    if (size % 2) exit(2);
    unsigned char *bytes = malloc(size / 2 + 1);
    if (!bytes) exit(2);
    for (size_t index = 0; index < size; index += 2) bytes[index / 2] = (unsigned char)(hex(line[index]) * 16 + hex(line[index + 1]));
    ghostty_terminal_vt_write(terminal, bytes, size / 2);
    free(bytes);
}

static void track(unsigned slot) {
    if (slot >= 2) exit(2);
    uint16_t x, y;
    bool wrap;
    cursor(&x, &y, &wrap);
    ghostty_tracked_grid_ref_free(tracked[slot]);
    tracked[slot] = NULL;
    check(ghostty_terminal_grid_ref_track(terminal, point(x, y), &tracked[slot]));
}

static void position(unsigned slot) {
    if (slot >= 2 || !tracked[slot]) exit(2);
    GhosttyPointCoordinate coordinate;
    GhosttyResult result = ghostty_tracked_grid_ref_point(tracked[slot], GHOSTTY_POINT_TAG_ACTIVE, &coordinate);
    if (result == GHOSTTY_NO_VALUE) {
        printf("{\"point\":null}\n");
        return;
    }
    check(result);
    printf("{\"point\":[%u,%u]}\n", coordinate.x, coordinate.y);
}

static void command(const char *line) {
    unsigned first, second;
    if (line[0] == 'S') { snapshot(); return; }
    if (line[0] == 'P' && sscanf(line + 1, "%u", &first) == 1) { position(first); return; }
    if (line[0] == 'N' && sscanf(line + 1, "%u %u", &first, &second) == 2) {
        clear();
        check(ghostty_terminal_new(NULL, &terminal, (uint16_t)first, (uint16_t)second));
    } else if (line[0] == 'R' && sscanf(line + 1, "%u %u", &first, &second) == 2) {
        check(ghostty_terminal_resize(terminal, (uint16_t)first, (uint16_t)second, 8, 16));
    } else if (line[0] == 'T' && sscanf(line + 1, "%u", &first) == 1) {
        track(first);
    } else if (line[0] == 'W') {
        write_bytes(line + 2);
    } else {
        fprintf(stderr, "invalid proof protocol command\n");
        exit(2);
    }
    printf("{\"ok\":true}\n");
}

int main(void) {
    char *line = NULL;
    size_t capacity = 0;
    while (getline(&line, &capacity, stdin) >= 0) {
        command(line);
        fflush(stdout);
    }
    free(line);
    clear();
    return 0;
}
