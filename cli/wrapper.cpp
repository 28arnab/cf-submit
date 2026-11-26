/**
 * Small native launcher for CP Editor. It starts the adjacent Node.js CLI while
 * presenting CP Editor with a conventional executable file.
 */

#include <cerrno>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <unistd.h>
#include <vector>

#ifndef NODE_EXECUTABLE
#define NODE_EXECUTABLE "node"
#endif

namespace fs = std::filesystem;

int main(int argc, char *argv[]) {
  fs::path executable_path;
  try {
    executable_path = fs::canonical("/proc/self/exe");
  } catch (const fs::filesystem_error &error) {
    std::cerr << "Could not locate cf executable: " << error.what() << '\n';
    return 1;
  }

  const fs::path script_path = executable_path.parent_path() / "main.js";
  if (!fs::is_regular_file(script_path)) {
    std::cerr << "Could not find CLI script: " << script_path << '\n';
    return 1;
  }

  std::string node = NODE_EXECUTABLE;
  std::string script = script_path.string();
  std::vector<char *> arguments;
  arguments.reserve(static_cast<std::size_t>(argc) + 2);
  arguments.push_back(node.data());
  arguments.push_back(script.data());
  for (int i = 1; i < argc; ++i) {
    arguments.push_back(argv[i]);
  }
  arguments.push_back(nullptr);

  execv(node.c_str(), arguments.data());
  std::cerr << "Could not start Node.js at " << node << ": "
            << std::strerror(errno) << '\n';
  return 1;
}
