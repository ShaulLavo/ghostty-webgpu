#!/usr/bin/env python3
"""Print raw Kitty keyboard protocol bytes for the Phase 3 manual gate."""

from __future__ import annotations

import os
import select
import signal
import sys
import termios
import tty
from collections.abc import Callable
from types import FrameType

ENABLE_KITTY_KEYS = b"\x1b[>11u"
RESTORE_KITTY_KEYS = b"\x1b[<u"
CTRL_C_PRESS = (b"\x03", b"\x1b[99;5u", b"\x1b[99;5:1u")
HANDLED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGTERM)


class SignalExit(Exception):
    def __init__(self, signal_number: int) -> None:
        super().__init__(signal_number)
        self.signal_number = signal_number


class RawKittySession:
    def __init__(self, input_fd: int, output_fd: int) -> None:
        self.input_fd = input_fd
        self.output_fd = output_fd
        self.original = termios.tcgetattr(input_fd)
        self.active = False

    def start(self) -> None:
        tty.setraw(self.input_fd, termios.TCSANOW)
        self.active = True
        os.write(self.output_fd, ENABLE_KITTY_KEYS)

    def restore(self) -> None:
        if not self.active:
            return
        self.active = False
        try:
            os.write(self.output_fd, RESTORE_KITTY_KEYS)
        except OSError:
            pass
        termios.tcsetattr(self.input_fd, termios.TCSANOW, self.original)


class QuitDetector:
    def __init__(self) -> None:
        self.tail = b""

    def received(self, data: bytes) -> bool:
        sample = self.tail + data
        self.tail = sample[-32:]
        return any(sequence in sample for sequence in CTRL_C_PRESS)


SignalHandler = Callable[[int, FrameType | None], None]


def escaped(data: bytes) -> str:
    return "".join(f"\\x{value:02x}" for value in data)


def write_line(output_fd: int, text: str) -> None:
    os.write(output_fd, text.encode("utf-8") + b"\r\n")


def read_packet(input_fd: int) -> bytes:
    packet = bytearray(os.read(input_fd, 4096))
    while packet:
        readable, _, _ = select.select([input_fd], [], [], 0)
        if not readable:
            return bytes(packet)
        chunk = os.read(input_fd, 4096)
        if not chunk:
            return bytes(packet)
        packet.extend(chunk)
    return bytes(packet)


def signal_handler(session: RawKittySession) -> SignalHandler:
    def handle(signal_number: int, _frame: FrameType | None) -> None:
        session.restore()
        raise SignalExit(signal_number)

    return handle


def install_signal_handlers(session: RawKittySession) -> dict[int, signal.Handlers]:
    previous: dict[int, signal.Handlers] = {}
    handler = signal_handler(session)
    for signal_number in HANDLED_SIGNALS:
        previous[signal_number] = signal.getsignal(signal_number)
        signal.signal(signal_number, handler)
    return previous


def restore_signal_handlers(previous: dict[int, signal.Handlers]) -> None:
    for signal_number, handler in previous.items():
        signal.signal(signal_number, handler)


def run_check(session: RawKittySession) -> None:
    detector = QuitDetector()
    write_line(session.output_fd, "Kitty keyboard flags 11 enabled: disambiguate + events + all keys")
    write_line(session.output_fd, "event suffixes: press=:1 (usually omitted), repeat=:2, release=:3")
    write_line(session.output_fd, "test modifiers, arrows, function keys, and holds; Ctrl-C exits")
    while True:
        data = read_packet(session.input_fd)
        if not data:
            return
        write_line(session.output_fd, f"{len(data):04d} bytes  {escaped(data)}")
        if detector.received(data):
            return


def main() -> int:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("kitty-keyboard-check.py requires a TTY on stdin and stdout", file=sys.stderr)
        return 2
    session = RawKittySession(sys.stdin.fileno(), sys.stdout.fileno())
    previous = install_signal_handlers(session)
    exit_code = 0
    try:
        session.start()
        run_check(session)
    except SignalExit as interrupted:
        exit_code = 128 + interrupted.signal_number
    finally:
        session.restore()
        restore_signal_handlers(previous)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
