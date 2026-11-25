/**
 * @file wrapper.cpp
 * @brief Lightweight native executable wrapper around cli/main.py.
 *
 * CP Editor's QProcess executable validator expects a native binary on PATH.
 * This wrapper resolves the sibling main.py script relative to /proc/self/exe
 * and replaces the process image via execv().
 */

#include <filesystem>
#include <iostream>
#include <string>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;

int main(int argc, char *argv[]) {
  // Resolve the directory containing the compiled binary (following symlinks)
  fs::path exe_path = fs::canonical("/proc/self/exe");
  fs::path script_path = exe_path.parent_path() / "main.py";
  if (!fs::exists(script_path)) {
    script_path = exe_path.parent_path() / "main";
  }
  std::string script_str = script_path.string();

  // Build argv array: ["/usr/bin/python3", "<path>/main.py", ...original_args,
  // nullptr]
  std::vector<char *> new_argv;
  std::string py = "/usr/bin/python3";
  new_argv.push_back(const_cast<char *>(py.c_str()));
  new_argv.push_back(const_cast<char *>(script_str.c_str()));

  for (int i = 1; i < argc; ++i) {
    new_argv.push_back(argv[i]);
  }
  new_argv.push_back(nullptr);

  // Replace current process with Python interpreter
  execv(py.c_str(), new_argv.data());
  std::cerr << "Failed to execute Python bridge at: " << script_str << "\n";
  return 1;
}
