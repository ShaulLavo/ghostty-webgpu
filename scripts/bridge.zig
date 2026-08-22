const host = struct {
    extern "env" fn write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;
    extern "env" fn device_attributes(terminal: u32, userdata: u32, out: u32) u32;
    extern "env" fn size(terminal: u32, userdata: u32, out: u32) u32;
    extern "env" fn xtversion(out: u32, terminal: u32, userdata: u32) void;
    extern "env" fn title_changed(terminal: u32, userdata: u32) void;
    extern "env" fn decode_png(userdata: u32, allocator: u32, data: u32, len: u32, out: u32) u32;
};

export fn bridge_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void {
    host.write_pty(terminal, userdata, data, len);
}

export fn bridge_device_attributes(terminal: u32, userdata: u32, out: u32) u32 {
    return host.device_attributes(terminal, userdata, out);
}

export fn bridge_size(terminal: u32, userdata: u32, out: u32) u32 {
    return host.size(terminal, userdata, out);
}

export fn bridge_xtversion(out: u32, terminal: u32, userdata: u32) void {
    host.xtversion(out, terminal, userdata);
}

export fn bridge_title_changed(terminal: u32, userdata: u32) void {
    host.title_changed(terminal, userdata);
}

export fn bridge_decode_png(userdata: u32, allocator: u32, data: u32, len: u32, out: u32) u32 {
    return host.decode_png(userdata, allocator, data, len, out);
}

