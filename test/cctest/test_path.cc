#include "debug_utils-inl.h"
#include "env-inl.h"
#include "gtest/gtest.h"
#include "node_options.h"
#include "node_test_fixture.h"
#include "path.h"
#include "util.h"
#include "v8.h"

using node::BufferValue;
using node::PathResolve;
using node::ToNamespacedPath;

class PathTest : public EnvironmentTestFixture {};

TEST_F(PathTest, PathResolve) {
  const v8::HandleScope handle_scope(isolate_);
  Argv argv;
  Env env{handle_scope, argv, node::EnvironmentFlags::kNoBrowserGlobals};
  auto cwd = (*env)->GetCwd((*env)->exec_path());
#ifdef _WIN32
  EXPECT_EQ(PathResolve(*env, {"c:/blah\\blah", "d:/games", "c:../a"}),
            "c:\\blah\\a");
  EXPECT_EQ(PathResolve(*env, {"c:/ignore", "d:\\a/b\\c/d", "\\e.exe"}),
            "d:\\e.exe");
  EXPECT_EQ(PathResolve(*env, {"c:/ignore", "c:/some/file"}), "c:\\some\\file");
  EXPECT_EQ(PathResolve(*env, {"d:/ignore", "d:some/dir//"}),
            "d:\\ignore\\some\\dir");
  EXPECT_EQ(PathResolve(*env, {"."}), cwd);
  EXPECT_EQ(PathResolve(*env, {"//server/share", "..", "relative\\"}),
            "\\\\server\\share\\relative");
  EXPECT_EQ(PathResolve(*env, {"c:/", "//"}), "c:\\");
  EXPECT_EQ(PathResolve(*env, {"c:/", "//dir"}), "c:\\dir");
  EXPECT_EQ(PathResolve(*env, {"c:/", "//server/share"}),
            "\\\\server\\share\\");
  EXPECT_EQ(PathResolve(*env, {"c:/", "//server//share"}),
            "\\\\server\\share\\");
  EXPECT_EQ(PathResolve(*env, {"c:/", "///some//dir"}), "c:\\some\\dir");
  EXPECT_EQ(
      PathResolve(*env, {"C:\\foo\\tmp.3\\", "..\\tmp.3\\cycles\\root.js"}),
      "C:\\foo\\tmp.3\\cycles\\root.js");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\C:\\"}), "\\\\?\\C:\\");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\C:"}), "\\\\?\\C:");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\C:", "\\"}), "\\\\?\\C:\\");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\C:\\dir\\file.exe"}),
            "\\\\?\\C:\\dir\\file.exe");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\C:\\", "..\\file.exe"}),
            "\\\\?\\C:\\file.exe");
  EXPECT_EQ(PathResolve(*env,
                        {"\\\\?\\C:\\", "one", "two", "file.exe"}),
            "\\\\?\\C:\\one\\two\\file.exe");
  EXPECT_EQ(
      PathResolve(*env,
                  {"\\\\?\\C:\\", "one\\two", "..\\..\\..\\file.exe"}),
      "\\\\?\\C:\\file.exe");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\UNC\\server\\share\\"}),
            "\\\\?\\UNC\\server\\share\\");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\UNC\\server\\share"}),
            "\\\\?\\UNC\\server\\share");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\UNC\\server\\share", "\\"}),
            "\\\\?\\UNC\\server\\share\\");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\unc\\Server\\Share\\dir\\file.exe"}),
            "\\\\?\\unc\\Server\\Share\\dir\\file.exe");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\UNC\\server\\share\\dir\\file.exe"}),
            "\\\\?\\UNC\\server\\share\\dir\\file.exe");
  EXPECT_EQ(
      PathResolve(*env,
                  {"\\\\?\\UNC\\server\\share\\", "..\\file.exe"}),
      "\\\\?\\UNC\\server\\share\\file.exe");
  EXPECT_EQ(PathResolve(*env,
                        {"\\\\?\\UNC\\server\\share\\",
                         "one",
                         "two",
                         "file.exe"}),
            "\\\\?\\UNC\\server\\share\\one\\two\\file.exe");
  EXPECT_EQ(PathResolve(
                *env,
                {"\\\\?\\UNC\\server\\share\\",
                 "one\\two",
                 "..\\..\\..\\file.exe"}),
            "\\\\?\\UNC\\server\\share\\file.exe");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\UNC"}), "\\\\?\\UNC");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\UNC\\server\\"}),
            "\\\\?\\UNC\\server");
  EXPECT_EQ(PathResolve(*env, {"\\\\.\\PHYSICALDRIVE0"}),
            "\\\\.\\PHYSICALDRIVE0");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\PHYSICALDRIVE0"}),
            "\\\\?\\PHYSICALDRIVE0");
  EXPECT_EQ(PathResolve(*env, {"\\\\?\\PHYSICALDRIVE0\\tail"}),
            "\\\\?\\PHYSICALDRIVE0\\tail");
#else
  EXPECT_EQ(PathResolve(*env, {"/var/lib", "../", "file/"}), "/var/file");
  EXPECT_EQ(PathResolve(*env, {"/var/lib", "/../", "file/"}), "/file");
  EXPECT_EQ(PathResolve(*env, {"a/b/c/", "../../.."}), cwd);
  EXPECT_EQ(PathResolve(*env, {"."}), cwd);
  EXPECT_EQ(PathResolve(*env, {"/some/dir", ".", "/absolute/"}), "/absolute");
  EXPECT_EQ(PathResolve(*env, {"/foo/tmp.3/", "../tmp.3/cycles/root.js"}),
            "/foo/tmp.3/cycles/root.js");
#endif
}

TEST_F(PathTest, NormalizeExtendedWindowsExecPath) {
#ifdef _WIN32
  std::string path = "\\\\?\\C:\\node.exe";
  node::NormalizeExtendedWindowsExecPath(&path);
  EXPECT_EQ(path, "C:\\node.exe");

  const std::vector<std::string> preserved = {
    "\\\\?\\UNC\\server\\share\\node.exe",
    "\\\\?\\Volume{1234}\\node.exe",
    "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\node.exe",
    "\\\\?\\C:\\node.exe.",
    "\\\\?\\C:\\node.exe ",
    "\\\\?\\C:\\CON\\node.exe",
    "\\\\?\\C:\\COM\xC2\xB9\\node.exe",
    "\\\\?\\C:\\LPT\xC2\xB2\\node.exe",
    "\\\\?\\C:\\CONIN$\\node.exe",
    "\\\\?\\C:\\CONOUT$\\node.exe",
    "\\\\?\\C:\\node.exe:stream",
    "\\\\?\\C:\\node/child.exe",
    "\\\\?\\C:\\node\\.\\child.exe",
    "\\\\?\\C:\\node\\..\\child.exe",
  };
  for (size_t i = 0; i < preserved.size(); i++) {
    std::string value = preserved[i];
    node::NormalizeExtendedWindowsExecPath(&value);
    EXPECT_EQ(value, preserved[i]);
  }

  std::string long_path = "\\\\?\\C:\\" + std::string(MAX_PATH, 'x') +
                          ".exe";
  const std::string original = long_path;
  node::NormalizeExtendedWindowsExecPath(&long_path);
  EXPECT_EQ(long_path, original);

  std::string max_path = "\\\\?\\C:\\" +
                         std::string(MAX_PATH - 3 - 4 - 1, 'x') + ".exe";
  const std::string max_path_original = max_path;
  node::NormalizeExtendedWindowsExecPath(&max_path);
  EXPECT_EQ(max_path, max_path_original.substr(4));

  std::string over_max_path = "\\\\?\\C:\\" +
                              std::string(MAX_PATH - 3 - 4, 'x') + ".exe";
  const std::string over_max_path_original = over_max_path;
  node::NormalizeExtendedWindowsExecPath(&over_max_path);
  EXPECT_EQ(over_max_path, over_max_path_original);
#endif
}

TEST_F(PathTest, ToNamespacedPath) {
  const v8::HandleScope handle_scope(isolate_);
  Argv argv;
  Env env{handle_scope, argv, node::EnvironmentFlags::kNoBrowserGlobals};
#ifdef _WIN32
  BufferValue data(isolate_,
                   v8::String::NewFromUtf8(isolate_, "").ToLocalChecked());
  ToNamespacedPath(*env, &data);
  EXPECT_EQ(data.ToStringView(), "");  // Empty string should not be mutated
  BufferValue data_2(
      isolate_, v8::String::NewFromUtf8(isolate_, "C://").ToLocalChecked());
  ToNamespacedPath(*env, &data_2);
  EXPECT_EQ(data_2.ToStringView(), "\\\\?\\C:\\");
  BufferValue data_3(
      isolate_,
      v8::String::NewFromUtf8(
          isolate_,
          "C:\\workspace\\node-test-binary-windows-js-"
          "suites\\node\\test\\fixtures\\permission\\deny\\protected-file.md")
          .ToLocalChecked());
  ToNamespacedPath(*env, &data_3);
  EXPECT_EQ(
      data_3.ToStringView(),
      "\\\\?\\C:\\workspace\\node-test-binary-windows-js-"
      "suites\\node\\test\\fixtures\\permission\\deny\\protected-file.md");
  BufferValue data_4(
      isolate_,
      v8::String::NewFromUtf8(isolate_, "\\\\?\\c:\\Windows/System")
          .ToLocalChecked());
  ToNamespacedPath(*env, &data_4);
  EXPECT_EQ(data_4.ToStringView(), "\\\\?\\c:\\Windows\\System");
#else
  BufferValue data(
      isolate_,
      v8::String::NewFromUtf8(isolate_, "hello world").ToLocalChecked());
  ToNamespacedPath(*env, &data);
  EXPECT_EQ(data.ToStringView(), "hello world");  // Input should not be mutated
#endif
}
