# Firefox worker paste fixtures

Firefox's untrusted synthetic ClipboardEvent does not retain constructor-supplied
DataTransfer contents. The remaining scroll-to-bottom and worker paste tests sent
empty input, so their original scroll and encoded-byte assertions failed.

Both fixtures now expose their actual DataTransfer through an own clipboardData
property, matching the already reviewed hotkeys fixture. Preconditions verify the
intended text before dispatch. Product input handling, original scroll, byte,
ownership and cancellation assertions, deadlines and capability exclusions are unchanged.

The hosted Firefox shard at e5c1ebb8 reports all three failures. Focused Firefox
validation passes them after this fixture correction. The existing intentional
inputModes getter read is marked void to preserve its throwing assertion without
an unused-expression lint warning. No native stage maps this original worker file.
