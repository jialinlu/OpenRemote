// Original small OS-input bridge. The network never talks to this process.
// stdin accepts only the fixed protocol described in native/README.md.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#ifdef __APPLE__
#include <ApplicationServices/ApplicationServices.h>
#elif defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#error This helper supports only macOS and Windows.
#endif

using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

static std::mutex outputMutex;
static void emit(const std::string& json) {
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << json << '\n' << std::flush;
}
static void error(const char* message) {
  // All callers provide compile-time ASCII strings, never untrusted JSON.
  emit(std::string("{\"type\":\"error\",\"message\":\"") + message + "\"}");
}

struct Key { unsigned code; bool extended = false; };
static const std::map<std::string, Key>& keys() {
#ifdef __APPLE__
  static const std::map<std::string, Key> table = {
    {"KeyA",{0}},{"KeyS",{1}},{"KeyD",{2}},{"KeyF",{3}},{"KeyH",{4}},
    {"KeyG",{5}},{"KeyZ",{6}},{"KeyX",{7}},{"KeyC",{8}},{"KeyV",{9}},
    {"KeyB",{11}},{"KeyQ",{12}},{"KeyW",{13}},{"KeyE",{14}},{"KeyR",{15}},
    {"KeyY",{16}},{"KeyT",{17}},{"Digit1",{18}},{"Digit2",{19}},{"Digit3",{20}},
    {"Digit4",{21}},{"Digit6",{22}},{"Digit5",{23}},{"Equal",{24}},{"Digit9",{25}},
    {"Digit7",{26}},{"Minus",{27}},{"Digit8",{28}},{"Digit0",{29}},{"BracketRight",{30}},
    {"KeyO",{31}},{"KeyU",{32}},{"BracketLeft",{33}},{"KeyI",{34}},{"KeyP",{35}},
    {"Enter",{36}},{"KeyL",{37}},{"KeyJ",{38}},{"Quote",{39}},{"KeyK",{40}},
    {"Semicolon",{41}},{"Backslash",{42}},{"Comma",{43}},{"Slash",{44}},
    {"KeyN",{45}},{"KeyM",{46}},{"Period",{47}},{"Tab",{48}},{"Space",{49}},
    {"Backquote",{50}},{"Backspace",{51}},{"Escape",{53}},{"MetaRight",{54}},
    {"MetaLeft",{55}},{"ShiftLeft",{56}},{"CapsLock",{57}},{"AltLeft",{58}},
    {"ControlLeft",{59}},{"ShiftRight",{60}},{"AltRight",{61}},{"ControlRight",{62}},
    {"NumpadDecimal",{65}},{"NumpadMultiply",{67}},{"NumpadAdd",{69}},
    {"NumLock",{71}},{"NumpadDivide",{75}},{"NumpadEnter",{76}},{"NumpadSubtract",{78}},
    {"NumpadEqual",{81}},{"Numpad0",{82}},{"Numpad1",{83}},{"Numpad2",{84}},
    {"Numpad3",{85}},{"Numpad4",{86}},{"Numpad5",{87}},{"Numpad6",{88}},
    {"Numpad7",{89}},{"Numpad8",{91}},{"Numpad9",{92}},
    {"F5",{96}},{"F6",{97}},{"F7",{98}},{"F3",{99}},{"F8",{100}},
    {"F9",{101}},{"F11",{103}},{"F13",{105}},{"F16",{106}},{"F14",{107}},
    {"F10",{109}},{"F12",{111}},{"F15",{113}},{"Home",{115}},{"PageUp",{116}},
    {"Delete",{117}},{"F4",{118}},{"End",{119}},{"F2",{120}},{"PageDown",{121}},
    {"F1",{122}},{"ArrowLeft",{123}},{"ArrowRight",{124}},{"ArrowDown",{125}},
    {"ArrowUp",{126}}
  };
#else
  // IBM PC set-1 scan codes encode physical key position, independent of layout.
  static const std::map<std::string, Key> table = {
    {"Escape",{0x01}},{"Digit1",{0x02}},{"Digit2",{0x03}},{"Digit3",{0x04}},
    {"Digit4",{0x05}},{"Digit5",{0x06}},{"Digit6",{0x07}},{"Digit7",{0x08}},
    {"Digit8",{0x09}},{"Digit9",{0x0a}},{"Digit0",{0x0b}},{"Minus",{0x0c}},
    {"Equal",{0x0d}},{"Backspace",{0x0e}},{"Tab",{0x0f}},{"KeyQ",{0x10}},
    {"KeyW",{0x11}},{"KeyE",{0x12}},{"KeyR",{0x13}},{"KeyT",{0x14}},
    {"KeyY",{0x15}},{"KeyU",{0x16}},{"KeyI",{0x17}},{"KeyO",{0x18}},
    {"KeyP",{0x19}},{"BracketLeft",{0x1a}},{"BracketRight",{0x1b}},
    {"Enter",{0x1c}},{"ControlLeft",{0x1d}},{"KeyA",{0x1e}},{"KeyS",{0x1f}},
    {"KeyD",{0x20}},{"KeyF",{0x21}},{"KeyG",{0x22}},{"KeyH",{0x23}},
    {"KeyJ",{0x24}},{"KeyK",{0x25}},{"KeyL",{0x26}},{"Semicolon",{0x27}},
    {"Quote",{0x28}},{"Backquote",{0x29}},{"ShiftLeft",{0x2a}},{"Backslash",{0x2b}},
    {"KeyZ",{0x2c}},{"KeyX",{0x2d}},{"KeyC",{0x2e}},{"KeyV",{0x2f}},
    {"KeyB",{0x30}},{"KeyN",{0x31}},{"KeyM",{0x32}},{"Comma",{0x33}},
    {"Period",{0x34}},{"Slash",{0x35}},{"ShiftRight",{0x36}},{"NumpadMultiply",{0x37}},
    {"AltLeft",{0x38}},{"Space",{0x39}},{"CapsLock",{0x3a}},
    {"F1",{0x3b}},{"F2",{0x3c}},{"F3",{0x3d}},{"F4",{0x3e}},{"F5",{0x3f}},
    {"F6",{0x40}},{"F7",{0x41}},{"F8",{0x42}},{"F9",{0x43}},{"F10",{0x44}},
    {"NumLock",{0x45}},{"ScrollLock",{0x46}},{"Numpad7",{0x47}},
    {"Numpad8",{0x48}},{"Numpad9",{0x49}},{"NumpadSubtract",{0x4a}},
    {"Numpad4",{0x4b}},{"Numpad5",{0x4c}},{"Numpad6",{0x4d}},{"NumpadAdd",{0x4e}},
    {"Numpad1",{0x4f}},{"Numpad2",{0x50}},{"Numpad3",{0x51}},{"Numpad0",{0x52}},
    {"NumpadDecimal",{0x53}},{"IntlBackslash",{0x56}},{"F11",{0x57}},{"F12",{0x58}},
    {"NumpadEnter",{0x1c,true}},{"ControlRight",{0x1d,true}},
    {"NumpadDivide",{0x35,true}},{"PrintScreen",{0x37,true}},{"AltRight",{0x38,true}},
    {"Home",{0x47,true}},{"ArrowUp",{0x48,true}},{"PageUp",{0x49,true}},
    {"ArrowLeft",{0x4b,true}},{"ArrowRight",{0x4d,true}},{"End",{0x4f,true}},
    {"ArrowDown",{0x50,true}},{"PageDown",{0x51,true}},{"Insert",{0x52,true}},
    {"Delete",{0x53,true}},{"MetaLeft",{0x5b,true}},{"MetaRight",{0x5c,true}},
    {"ContextMenu",{0x5d,true}}
  };
#endif
  return table;
}

static bool trusted() {
#ifdef __APPLE__
  return AXIsProcessTrusted();
#else
  return true; // SendInput can still fail when the target has higher integrity.
#endif
}
static const char* platform() {
#ifdef __APPLE__
  return "darwin";
#else
  return "win32";
#endif
}

class Input {
  bool dryRun;
  std::set<std::string> heldKeys;
  std::set<std::string> heldButtons;
#ifdef __APPLE__
  CGEventSourceRef source = nullptr;
  CGPoint remotePosition = CGPointMake(0, 0);
  bool hasRemotePosition = false;
  std::map<std::string, Clock::time_point> lastClick;
  std::map<std::string, CGPoint> lastClickPosition;
  std::map<std::string, int64_t> clickCounts;
  CGEventFlags flags() const {
    CGEventFlags result = 0;
    if (heldKeys.count("ShiftLeft") || heldKeys.count("ShiftRight")) result |= kCGEventFlagMaskShift;
    if (heldKeys.count("ControlLeft") || heldKeys.count("ControlRight")) result |= kCGEventFlagMaskControl;
    if (heldKeys.count("AltLeft") || heldKeys.count("AltRight")) result |= kCGEventFlagMaskAlternate;
    if (heldKeys.count("MetaLeft") || heldKeys.count("MetaRight")) result |= kCGEventFlagMaskCommand;
    return result;
  }
  void post(CGEventRef event) {
    if (!event) { error("Failed to create OS input event"); return; }
    CGEventSetFlags(event, flags());
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
  }
  CGPoint position() const {
    CGEventRef event = CGEventCreate(nullptr);
    CGPoint point = event ? CGEventGetLocation(event) : CGPointMake(0, 0);
    if (event) CFRelease(event);
    return point;
  }
#else
  bool post(INPUT event) {
    if (SendInput(1, &event, sizeof(INPUT)) != 1) {
      error("Windows rejected input; elevated or secure desktop may be active");
      return false;
    }
    return true;
  }
#endif
public:
  explicit Input(bool dry) : dryRun(dry) {
#ifdef __APPLE__
    if (!dryRun) source = CGEventSourceCreate(kCGEventSourceStatePrivate);
#else
    if (!dryRun) {
      // Windows 10 1703+ (and Windows 11). No windows are created by the helper.
      if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
        error("Cannot set per-monitor DPI awareness");
    }
#endif
  }
  ~Input() {
    release();
#ifdef __APPLE__
    if (source) CFRelease(source);
#endif
  }
  void move(double x, double y) {
    if (dryRun) return;
#ifdef __APPLE__
    remotePosition = CGPointMake(x, y);
    hasRemotePosition = true;
    CGEventType type = kCGEventMouseMoved;
    CGMouseButton button = kCGMouseButtonLeft;
    if (heldButtons.count("left")) type = kCGEventLeftMouseDragged;
    else if (heldButtons.count("right")) { type = kCGEventRightMouseDragged; button = kCGMouseButtonRight; }
    else if (heldButtons.count("middle")) { type = kCGEventOtherMouseDragged; button = kCGMouseButtonCenter; }
    post(CGEventCreateMouseEvent(source, type, remotePosition, button));
#else
    const int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width < 1 || height < 1) { error("No active desktop"); return; }
    INPUT event{};
    event.type = INPUT_MOUSE;
    // Map pixel centres to the absolute [0, 65535] coordinate space.
    event.mi.dx = static_cast<LONG>(std::clamp((x - left + 0.5) * 65536.0 / width, 0.0, 65535.0));
    event.mi.dy = static_cast<LONG>(std::clamp((y - top + 0.5) * 65536.0 / height, 0.0, 65535.0));
    event.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    post(event);
#endif
  }
  void button(const std::string& name, bool down) {
    if (down && heldButtons.count(name)) return;
    if (!down && !heldButtons.count(name)) return;
    if (down) heldButtons.insert(name); else heldButtons.erase(name);
    if (dryRun) return;
#ifdef __APPLE__
    // CGEventPost is asynchronous. Reading the physical cursor here could see
    // the previous location before the immediately preceding move is delivered.
    const auto point = hasRemotePosition ? remotePosition : position();
    const auto now = Clock::now();
    if (down) {
      const auto previous = lastClickPosition[name];
      const bool near = std::hypot(previous.x - point.x, previous.y - point.y) < 6;
      const bool soon = lastClick.count(name) && now - lastClick[name] < 500ms;
      clickCounts[name] = near && soon ? std::min<int64_t>(clickCounts[name] + 1, 3) : 1;
      lastClick[name] = now;
      lastClickPosition[name] = point;
    }
    const CGMouseButton button = name == "left" ? kCGMouseButtonLeft : name == "right" ? kCGMouseButtonRight : kCGMouseButtonCenter;
    const CGEventType type = name == "left" ? (down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp)
      : name == "right" ? (down ? kCGEventRightMouseDown : kCGEventRightMouseUp)
      : (down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp);
    auto event = CGEventCreateMouseEvent(source, type, point, button);
    if (event) CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickCounts[name]);
    post(event);
#else
    INPUT event{};
    event.type = INPUT_MOUSE;
    event.mi.dwFlags = name == "left" ? (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP)
      : name == "right" ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
      : (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP);
    post(event);
#endif
  }
  void key(const std::string& name, bool down) {
    if (!down && !heldKeys.count(name)) return;
    const bool repeated = down && heldKeys.count(name);
    if (down) heldKeys.insert(name); else heldKeys.erase(name);
    if (dryRun) return;
    const auto code = keys().at(name);
#ifdef __APPLE__
    auto event = CGEventCreateKeyboardEvent(source, static_cast<CGKeyCode>(code.code), down);
    if (event) CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, repeated ? 1 : 0);
    post(event);
#else
    (void)repeated;
    INPUT event{};
    event.type = INPUT_KEYBOARD;
    event.ki.wScan = static_cast<WORD>(code.code);
    event.ki.dwFlags = KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP) | (code.extended ? KEYEVENTF_EXTENDEDKEY : 0);
    post(event);
#endif
  }
  void scroll(double x, double y) {
    if (dryRun) return;
#ifdef __APPLE__
    // Browser wheel delta: positive y scrolls downward, Quartz uses the reverse.
    auto event = CGEventCreateScrollWheelEvent(source, kCGScrollEventUnitPixel, 2,
      static_cast<int32_t>(std::round(-y)), static_cast<int32_t>(std::round(-x)));
    if (event && hasRemotePosition) CGEventSetLocation(event, remotePosition);
    post(event);
#else
    // Browser pixel deltas are scaled to wheel units (roughly 100 pixels per notch).
    if (x != 0) {
      INPUT event{}; event.type = INPUT_MOUSE; event.mi.dwFlags = MOUSEEVENTF_HWHEEL;
      event.mi.mouseData = static_cast<DWORD>(static_cast<LONG>(std::round(x * WHEEL_DELTA / 100.0)));
      post(event);
    }
    if (y != 0) {
      INPUT event{}; event.type = INPUT_MOUSE; event.mi.dwFlags = MOUSEEVENTF_WHEEL;
      event.mi.mouseData = static_cast<DWORD>(static_cast<LONG>(std::round(-y * WHEEL_DELTA / 100.0)));
      post(event);
    }
#endif
  }
  void text(const std::vector<uint16_t>& value) {
    release();
    if (dryRun) return;
#ifdef __APPLE__
    // Keep each event small and never split a UTF-16 surrogate pair.
    for (size_t offset = 0; offset < value.size();) {
      size_t count = std::min<size_t>(16, value.size() - offset);
      if (offset + count < value.size() && value[offset + count - 1] >= 0xd800 && value[offset + count - 1] <= 0xdbff) --count;
      for (const bool down : {true, false}) {
        auto event = CGEventCreateKeyboardEvent(source, 0, down);
        if (event) CGEventKeyboardSetUnicodeString(event, count, value.data() + offset);
        post(event);
      }
      offset += count;
    }
#else
    for (const auto unit : value) {
      INPUT down{}; down.type = INPUT_KEYBOARD;
      down.ki.wScan = unit; down.ki.dwFlags = KEYEVENTF_UNICODE;
      if (!post(down)) break;
      down.ki.dwFlags |= KEYEVENTF_KEYUP;
      if (!post(down)) break;
    }
#endif
  }
  void release() {
    const auto oldKeys = heldKeys;
    const auto oldButtons = heldButtons;
    for (const auto& name : oldKeys) key(name, false);
    for (const auto& name : oldButtons) button(name, false);
#ifdef __APPLE__
    hasRemotePosition = false;
#endif
  }
};

static std::vector<std::string> split(const std::string& line) {
  std::vector<std::string> result;
  size_t start = 0;
  for (;;) {
    const auto end = line.find('\t', start);
    result.push_back(line.substr(start, end == std::string::npos ? end : end - start));
    if (end == std::string::npos) return result;
    start = end + 1;
  }
}
static bool number(const std::string& value, double max, double& out) {
  if (value.empty() || value.size() > 32) return false;
  // Decimal only; reject whitespace, hex, NaN, infinity, and trailing garbage.
  bool digit = false, dot = false;
  for (size_t i = 0; i < value.size(); ++i) {
    const char c = value[i];
    if (c >= '0' && c <= '9') { digit = true; continue; }
    if (i == 0 && (c == '-' || c == '+')) continue;
    if (c == '.' && !dot) { dot = true; continue; }
    return false;
  }
  if (!digit) return false;
  out = std::strtod(value.c_str(), nullptr);
  return std::isfinite(out) && std::abs(out) <= max;
}

static bool decodeText(const std::string& encoded, std::vector<uint16_t>& utf16) {
  if (encoded.empty() || encoded.size() > 21848 || encoded.size() % 4 != 0) return false;
  const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<unsigned char> bytes;
  for (size_t i = 0; i < encoded.size(); i += 4) {
    const bool final = i + 4 == encoded.size();
    const size_t a = alphabet.find(encoded[i]), b = alphabet.find(encoded[i + 1]);
    const size_t c = alphabet.find(encoded[i + 2]), d = alphabet.find(encoded[i + 3]);
    if (a == std::string::npos || b == std::string::npos) return false;
    bytes.push_back(static_cast<unsigned char>((a << 2) | (b >> 4)));
    if (encoded[i + 2] == '=') {
      if (!final || encoded[i + 3] != '=' || (b & 15) != 0) return false;
      continue;
    }
    if (c == std::string::npos) return false;
    bytes.push_back(static_cast<unsigned char>((b << 4) | (c >> 2)));
    if (encoded[i + 3] == '=') {
      if (!final || (c & 3) != 0) return false;
      continue;
    }
    if (d == std::string::npos) return false;
    bytes.push_back(static_cast<unsigned char>((c << 6) | d));
  }
  if (bytes.size() > 16384) return false;
  for (size_t i = 0; i < bytes.size();) {
    const auto first = bytes[i++];
    uint32_t codepoint = 0;
    int extra = 0;
    uint32_t minimum = 0;
    if (first < 0x80) codepoint = first;
    else if (first >= 0xc2 && first <= 0xdf) { codepoint = first & 31; extra = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { codepoint = first & 15; extra = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { codepoint = first & 7; extra = 3; minimum = 0x10000; }
    else return false;
    if (i + extra > bytes.size()) return false;
    for (int j = 0; j < extra; ++j) {
      const auto next = bytes[i++];
      if ((next & 0xc0) != 0x80) return false;
      codepoint = (codepoint << 6) | (next & 63);
    }
    if (codepoint < minimum || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    // Text can contain line breaks and tabs, but not NUL or other control codes.
    if ((codepoint < 32 && codepoint != 9 && codepoint != 10 && codepoint != 13) || codepoint == 127) return false;
    if (codepoint < 0x10000) utf16.push_back(static_cast<uint16_t>(codepoint));
    else {
      codepoint -= 0x10000;
      utf16.push_back(static_cast<uint16_t>(0xd800 | (codepoint >> 10)));
      utf16.push_back(static_cast<uint16_t>(0xdc00 | (codepoint & 1023)));
    }
  }
  return true;
}

int main(int argc, char** argv) {
  const bool dryRun = argc == 2 && std::string(argv[1]) == "--validate-only";
  if (argc > 1 && !dryRun) { error("Unknown helper argument"); return 2; }
  Input input(dryRun);
  std::mutex inputMutex;
  std::atomic<bool> stopped{false};
  auto lastActivity = Clock::now();
  emit(std::string("{\"type\":\"ready\",\"trusted\":") + (trusted() ? "true" : "false") +
    ",\"platform\":\"" + platform() + "\",\"validateOnly\":" + (dryRun ? "true}" : "false}"));
  std::thread watchdog([&] {
    while (!stopped.load()) {
      std::this_thread::sleep_for(200ms);
      std::lock_guard<std::mutex> lock(inputMutex);
      if (Clock::now() - lastActivity > 10s) {
        input.release();
        lastActivity = Clock::now();
        emit("{\"type\":\"released\",\"reason\":\"watchdog\"}");
      }
    }
  });
  // Keep memory bounded even if a buggy caller writes a line without a newline.
  for (;;) {
    std::string line;
    bool oversized = false, eof = false;
    for (;;) {
      const auto c = std::cin.get();
      if (c == std::char_traits<char>::eof()) { eof = true; break; }
      if (c == '\n') break;
      if (line.size() < 21856) line.push_back(static_cast<char>(c)); else oversized = true;
    }
    // An unterminated last line is never executed.
    if (eof) break;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (oversized || (line.size() > 512 && line.rfind("text\t", 0) != 0)) { error("Command exceeds length limit"); continue; }
    const auto fields = split(line);
    const auto& command = fields[0];
    double x = 0, y = 0;
    std::vector<uint16_t> unicode;
    bool valid = false;
    if (command == "ping" || command == "release" || command == "quit") valid = fields.size() == 1;
    else if (command == "move" || command == "scroll") valid = fields.size() == 3 &&
      number(fields[1], command == "move" ? 100000 : 2000, x) &&
      number(fields[2], command == "move" ? 100000 : 2000, y);
    else if (command == "key") valid = fields.size() == 3 && keys().count(fields[1]) && (fields[2] == "down" || fields[2] == "up");
    else if (command == "text") valid = fields.size() == 2 && decodeText(fields[1], unicode);
    else if (command == "button") valid = fields.size() == 3 &&
      (fields[1] == "left" || fields[1] == "right" || fields[1] == "middle") && (fields[2] == "down" || fields[2] == "up");
    if (!valid) { error("Invalid or unsupported input command"); continue; }
    std::lock_guard<std::mutex> lock(inputMutex);
    lastActivity = Clock::now();
    if (command == "ping") {
      emit(std::string("{\"type\":\"pong\",\"trusted\":") + (trusted() ? "true}" : "false}"));
      continue;
    }
    if (command == "quit") { input.release(); break; }
    if (command == "release") input.release();
    else if (!dryRun && !trusted()) { error("Accessibility permission is required"); continue; }
    else if (command == "move") input.move(x, y);
    else if (command == "scroll") input.scroll(x, y);
    else if (command == "key") input.key(fields[1], fields[2] == "down");
    else if (command == "button") input.button(fields[1], fields[2] == "down");
    else if (command == "text") input.text(unicode);
    if (dryRun) emit("{\"type\":\"accepted\",\"command\":\"" + command + "\"}");
  }
  stopped.store(true);
  watchdog.join();
  input.release();
  return 0;
}
