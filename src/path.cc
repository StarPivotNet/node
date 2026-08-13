#include "path.h"
#include <string>
#include <vector>
#include "ada.h"
#include "env-inl.h"
#include "node_internals.h"
#include "node_url.h"

namespace node {

#ifdef _WIN32
constexpr bool IsPathSeparator(const char c) noexcept {
  return c == '\\' || c == '/';
}
#else   // POSIX
constexpr bool IsPathSeparator(const char c) noexcept {
  return c == '/';
}
#endif  // _WIN32

std::string NormalizeString(const std::string_view path,
                            bool allowAboveRoot,
                            const std::string_view separator) {
  std::string res;
  int lastSegmentLength = 0;
  int lastSlash = -1;
  int dots = 0;
  char code = 0;
  for (size_t i = 0; i <= path.size(); ++i) {
    if (i < path.size()) {
      code = path[i];
    } else if (IsPathSeparator(code)) {
      break;
    } else {
      code = '/';
    }

    if (IsPathSeparator(code)) {
      if (lastSlash == static_cast<int>(i - 1) || dots == 1) {
        // NOOP
      } else if (dots == 2) {
        int len = res.length();
        if (len < 2 || lastSegmentLength != 2 || res[len - 1] != '.' ||
            res[len - 2] != '.') {
          if (len > 2) {
            auto lastSlashIndex = res.find_last_of(separator);
            if (lastSlashIndex == std::string::npos) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.substr(0, lastSlashIndex);
              len = res.length();
              lastSegmentLength = len - 1 - res.find_last_of(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (len != 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }

        if (allowAboveRoot) {
          res += res.length() > 0 ? std::string(separator) + ".." : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (!res.empty()) {
          res += std::string(separator) +
                 std::string(path.substr(lastSlash + 1, i - (lastSlash + 1)));
        } else {
          res = path.substr(lastSlash + 1, i - (lastSlash + 1));
        }
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code == '.' && dots != -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }

  return res;
}

#ifdef _WIN32
constexpr bool IsWindowsDriveLetter(const std::string_view path) noexcept {
  return path.size() > 2 && IsWindowsDeviceRoot(path[0]) &&
         (path[1] == ':' && (path[2] == '/' || path[2] == '\\'));
}
constexpr bool IsWindowsDeviceRoot(const char c) noexcept {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

void NormalizeExtendedWindowsExecPath(std::string* path) {
  if (path == nullptr || !path->starts_with("\\\\?\\") || path->size() < 7 ||
      !IsWindowsDeviceRoot((*path)[4]) || (*path)[5] != ':' ||
      (*path)[6] != '\\') {
    return;
  }

  const std::string candidate = path->substr(4);
  const ssize_t utf16_length = uv_wtf8_length_as_utf16(candidate.c_str());
  // uv_wtf8_length_as_utf16() includes the terminating NUL. Windows' MAX_PATH
  // limit is likewise defined in UTF-16 characters including that terminator.
  if (utf16_length < 0 || utf16_length > MAX_PATH) return;

  auto is_reserved_name = [](std::string_view component) {
    const size_t dot = component.find('.');
    const std::string_view base = component.substr(0, dot);
    auto equals_ascii_case_insensitive = [](std::string_view value,
                                            std::string_view expected) {
      if (value.size() != expected.size()) return false;
      for (size_t i = 0; i < value.size(); i++) {
        const char lower = value[i] >= 'A' && value[i] <= 'Z'
            ? value[i] + ('a' - 'A')
            : value[i];
        if (lower != expected[i]) return false;
      }
      return true;
    };
    if (equals_ascii_case_insensitive(base, "con") ||
        equals_ascii_case_insensitive(base, "conin$") ||
        equals_ascii_case_insensitive(base, "conout$") ||
        equals_ascii_case_insensitive(base, "prn") ||
        equals_ascii_case_insensitive(base, "aux") ||
        equals_ascii_case_insensitive(base, "nul") ||
        equals_ascii_case_insensitive(base, "clock$")) {
      return true;
    }
    const bool com_or_lpt =
        ((base[0] == 'C' || base[0] == 'c') &&
         (base[1] == 'O' || base[1] == 'o') &&
         (base[2] == 'M' || base[2] == 'm')) ||
        ((base[0] == 'L' || base[0] == 'l') &&
         (base[1] == 'P' || base[1] == 'p') &&
         (base[2] == 'T' || base[2] == 't'));
    const bool ascii_device_number =
        base.size() == 4 && base[3] >= '1' && base[3] <= '9';
    const bool superscript_device_number =
        base.size() == 5 && base[3] == static_cast<char>(0xC2) &&
        (base[4] == static_cast<char>(0xB2) ||
         base[4] == static_cast<char>(0xB3) ||
         base[4] == static_cast<char>(0xB9));
    if (com_or_lpt && (ascii_device_number || superscript_device_number)) {
      return true;
    }
    return false;
  };

  size_t component_start = 3;
  while (component_start < candidate.size()) {
    const size_t separator = candidate.find('\\', component_start);
    const size_t component_end = separator == std::string::npos
        ? candidate.size()
        : separator;
    const std::string_view component(candidate.data() + component_start,
                                     component_end - component_start);
    if (component.empty() || component == "." || component == ".." ||
        component.back() == '.' || component.back() == ' ' ||
        is_reserved_name(component)) {
      return;
    }
    for (const char c : component) {
      if (c == '/' || c == ':' || c == '*' || c == '?' || c == '"' ||
          c == '<' || c == '>' || c == '|' ||
          static_cast<unsigned char>(c) < 0x20) {
        return;
      }
    }
    if (separator == std::string::npos) break;
    component_start = separator + 1;
  }

  *path = candidate;
}

std::string PathResolve(Environment* env,
                        const std::vector<std::string_view>& paths) {
  std::string resolvedDevice = "";
  std::string resolvedTail = "";
  bool resolvedAbsolute = false;
  bool resolvedExtendedRootHasSeparator = false;
  const size_t numArgs = paths.size();
  auto cwd = env->GetCwd(env->exec_path());

  for (int i = numArgs - 1; i >= -1; i--) {
    std::string path;
    if (i >= 0) {
      path = std::string(paths[i]);
    } else if (resolvedDevice.empty()) {
      path = cwd;
    } else {
      // Windows has the concept of drive-specific current working
      // directories. If we've resolved a drive letter but not yet an
      // absolute path, get cwd for that drive, or the process cwd if
      // the drive cwd is not available. We're sure the device is not
      // a UNC path at this points, because UNC paths are always absolute.
      std::string resolvedDevicePath;
      const std::string envvar = "=" + resolvedDevice;
      credentials::SafeGetenv(envvar.c_str(), &resolvedDevicePath, env);
      path = resolvedDevicePath.empty() ? cwd : resolvedDevicePath;

      // Verify that a cwd was found and that it actually points
      // to our drive. If not, default to the drive's root.
      if (path.empty() ||
          (ToLower(path.substr(0, 2)) != ToLower(resolvedDevice) &&
           path[2] == '/')) {
        path = resolvedDevice + "\\";
      }
    }

    const size_t len = path.length();
    int rootEnd = 0;
    std::string device = "";
    bool isAbsolute = false;
    const char code = path[0];

    // Try to match a root
    if (len == 1) {
      if (IsPathSeparator(code)) {
        // `path` contains just a path separator
        rootEnd = 1;
        isAbsolute = true;
      }
    } else if (IsPathSeparator(code)) {
      // Possible UNC root

      // If we started with a separator, we know we at least have an
      // absolute path of some kind (UNC or otherwise)
      isAbsolute = true;

      if (IsPathSeparator(path[1])) {
        // Matched double path separator at beginning
        size_t j = 2;
        size_t last = j;
        // Match 1 or more non-path separators
        while (j < len && !IsPathSeparator(path[j])) {
          j++;
        }
        if (j < len && j != last) {
          const std::string firstPart = path.substr(last, j - last);
          // Matched!
          last = j;
          // Match 1 or more path separators
          while (j < len && IsPathSeparator(path[j])) {
            j++;
          }
          if (j < len && j != last) {
            // Matched!
            last = j;
            // Match 1 or more non-path separators
            while (j < len && !IsPathSeparator(path[j])) {
              j++;
            }
            if (j == len || j != last) {
              const std::string secondPart = path.substr(last, j - last);
              if (firstPart == "?" &&
                  secondPart.size() == 2 &&
                  IsWindowsDeviceRoot(secondPart[0]) &&
                  secondPart[1] == ':') {
                // Extended drive paths (e.g. \\?\C:\foo) include the
                // drive in the device root. Keeping it in resolvedDevice
                // prevents NormalizeString from dropping the root slash.
                device = "\\\\?\\" + secondPart;
                rootEnd = j;
                if (j < len && IsPathSeparator(path[j])) {
                  rootEnd = ++j;
                }
              } else if (firstPart == "?" &&
                         ToLower(secondPart) == "unc") {
                // Extended UNC paths (e.g. \\?\UNC\server\share\foo)
                // have two additional root components.
                size_t serverStart = j;
                while (serverStart < len &&
                       IsPathSeparator(path[serverStart])) {
                  serverStart++;
                }
                size_t serverEnd = serverStart;
                while (serverEnd < len &&
                       !IsPathSeparator(path[serverEnd])) {
                  serverEnd++;
                }
                size_t shareStart = serverEnd;
                while (shareStart < len &&
                       IsPathSeparator(path[shareStart])) {
                  shareStart++;
                }
                size_t shareEnd = shareStart;
                while (shareEnd < len &&
                       !IsPathSeparator(path[shareEnd])) {
                  shareEnd++;
                }
                if (serverEnd != serverStart && shareEnd != shareStart) {
                  device = "\\\\?\\" + secondPart + "\\" +
                           path.substr(serverStart, serverEnd - serverStart) +
                           "\\" +
                           path.substr(shareStart, shareEnd - shareStart);
                  rootEnd = shareEnd;
                  if (shareEnd < len && IsPathSeparator(path[shareEnd])) {
                    rootEnd = shareEnd + 1;
                  }
                } else {
                  // Preserve the generic device-path behavior for incomplete
                  // extended UNC paths such as \\?\UNC\server.
                  device = "\\\\?";
                  rootEnd = 4;
                }
              } else if (firstPart != "." && firstPart != "?") {
                // We matched a UNC root
                device =
                    "\\\\" + firstPart + "\\" + path.substr(last, j - last);
                rootEnd = j;
              } else {
                // We matched a device root (e.g. \\\\.\\PHYSICALDRIVE0)
                device = "\\\\" + firstPart;
                rootEnd = 4;
              }
            }
          }
        }
      }
    } else if (IsWindowsDeviceRoot(code) && path[1] == ':') {
      // Possible device root
      device = path.substr(0, 2);
      rootEnd = 2;
      if (len > 2 && IsPathSeparator(path[2])) {
        // Treat separator following drive name as an absolute path
        // indicator
        isAbsolute = true;
        rootEnd = 3;
      }
    }

    if (!device.empty()) {
      if (!resolvedDevice.empty()) {
        if (ToLower(device) != ToLower(resolvedDevice)) {
          // This path points to another device so it is not applicable
          continue;
        }
      } else {
        resolvedDevice = device;
      }
    }

    resolvedExtendedRootHasSeparator =
        resolvedExtendedRootHasSeparator ||
        (isAbsolute && rootEnd > 0 &&
         IsPathSeparator(path[rootEnd - 1]));

    if (resolvedAbsolute) {
      if (!resolvedDevice.empty()) {
        break;
      }
    } else {
      resolvedTail = path.substr(rootEnd) + "\\" + resolvedTail;
      resolvedAbsolute = isAbsolute;
      if (isAbsolute && !resolvedDevice.empty()) {
        break;
      }
    }
  }

  // At this point the path should be resolved to a full absolute path,
  // but handle relative paths to be safe (might happen when process.cwd()
  // fails)

  // Normalize the tail path
  resolvedTail = NormalizeString(resolvedTail, !resolvedAbsolute, "\\");

  if (resolvedAbsolute) {
    if (resolvedTail.empty() &&
        resolvedDevice.starts_with("\\\\?\\") &&
        !resolvedExtendedRootHasSeparator) {
      return resolvedDevice;
    }
    return resolvedDevice + "\\" + resolvedTail;
  }

  if (!resolvedDevice.empty() || !resolvedTail.empty()) {
    return resolvedDevice + resolvedTail;
  }

  return ".";
}
#else   // _WIN32
std::string PathResolve(Environment* env,
                        const std::vector<std::string_view>& paths) {
  std::string resolvedPath;
  bool resolvedAbsolute = false;
  auto cwd = env->GetCwd(env->exec_path());
  const size_t numArgs = paths.size();

  for (int i = numArgs - 1; i >= -1 && !resolvedAbsolute; i--) {
    const std::string& path = (i >= 0) ? std::string(paths[i]) : cwd;

    if (!path.empty()) {
      resolvedPath = std::string(path) + "/" + resolvedPath;

      if (path.front() == '/') {
        resolvedAbsolute = true;
        break;
      }
    }
  }

  // Normalize the path
  auto normalizedPath = NormalizeString(resolvedPath, !resolvedAbsolute, "/");

  if (resolvedAbsolute) {
    return "/" + normalizedPath;
  }

  if (normalizedPath.empty()) {
    return ".";
  }

  return normalizedPath;
}
#endif  // _WIN32

void ToNamespacedPath(Environment* env, BufferValue* path) {
#ifdef _WIN32
  if (path->length() == 0) return;
  std::string resolved_path = node::PathResolve(env, {path->ToStringView()});
  if (resolved_path.size() <= 2) {
    return;
  }

  // SAFETY: We know that resolved_path.size() > 2, therefore accessing [0],
  // [1], and [2] is safe.
  if (resolved_path[0] == '\\') {
    // Possible UNC root
    if (resolved_path[1] == '\\') {
      if (resolved_path[2] != '?' && resolved_path[2] != '.') {
        // Matched non-long UNC root, convert the path to a long UNC path
        std::string_view unc_prefix = R"(\\?\UNC\)";
        size_t new_length = unc_prefix.size() + resolved_path.size() - 2;
        path->AllocateSufficientStorage(new_length + 1);
        path->SetLength(new_length);
        memcpy(path->out(), unc_prefix.data(), unc_prefix.size());
        memcpy(path->out() + unc_prefix.size(),
               resolved_path.c_str() + 2,
               resolved_path.size() - 2 + 1);
        return;
      }
    }
  } else if (IsWindowsDeviceRoot(resolved_path[0]) && resolved_path[1] == ':' &&
             resolved_path[2] == '\\') {
    // Matched device root, convert the path to a long UNC path
    std::string_view new_prefix = R"(\\?\)";
    size_t new_length = new_prefix.size() + resolved_path.size();
    path->AllocateSufficientStorage(new_length + 1);
    path->SetLength(new_length);
    memcpy(path->out(), new_prefix.data(), new_prefix.size());
    memcpy(path->out() + new_prefix.size(),
           resolved_path.c_str(),
           resolved_path.size() + 1);
    return;
  }

  size_t new_length = resolved_path.size();
  path->AllocateSufficientStorage(new_length + 1);
  path->SetLength(new_length);
  memcpy(path->out(), resolved_path.c_str(), resolved_path.size() + 1);
#endif
}

// Reverse the logic applied by path.toNamespacedPath() to create a
// namespace-prefixed path.
void FromNamespacedPath(std::string* path) {
#ifdef _WIN32
  if (path->starts_with("\\\\?\\UNC\\")) {
    *path = path->substr(8);
    path->insert(0, "\\\\");
  } else if (path->starts_with("\\\\?\\")) {
    *path = path->substr(4);
  }
#endif
}

// Check if a path looks like an absolute path or file URL.
bool IsAbsoluteFilePath(std::string_view path) {
  if (path.starts_with("file://")) {
    return true;
  }
#ifdef _WIN32
  if (path.size() > 0 && path[0] == '\\') return true;
  if (IsWindowsDriveLetter(path)) return true;
#endif
  if (path.size() > 0 && path[0] == '/') return true;
  return false;
}

// Normalizes paths by resolving file URLs and converting to a consistent
// format with forward slashes.
std::string NormalizeFileURLOrPath(Environment* env, std::string_view path) {
  std::string normalized_string(path);
  constexpr std::string_view file_scheme = "file://";
  if (normalized_string.starts_with(file_scheme)) {
    auto out = ada::parse<ada::url_aggregator>(normalized_string);
    auto file_path = url::FileURLToPath(env, *out);
    if (!file_path.has_value()) {
      return std::string();
    }
    normalized_string = file_path.value();
  }
  normalized_string = NormalizeString(normalized_string, false, "/");
#ifdef _WIN32
  if (IsWindowsDriveLetter(normalized_string)) {
    normalized_string[0] = ToLower(normalized_string[0]);
  }
  for (char& c : normalized_string) {
    if (c == '\\') {
      c = '/';
    }
  }
#endif
  return normalized_string;
}

}  // namespace node
