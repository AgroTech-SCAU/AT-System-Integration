#include "agro_bt/bridge.hpp"
#include <atomic>
#include <csignal>
#include <fstream>
#include <iostream>
#include <sstream>
namespace {
volatile std::sig_atomic_t stopped = 0;
void stop(int) { stopped = 1; }
void save_state(const std::string &path, const agro_bt::Json &report) {
  if (path.empty())
    return;
  const auto temporary = path + ".tmp";
  {
    std::ofstream stream(temporary);
    if (!stream)
      throw std::runtime_error("state_file_unwritable");
    stream << report.dump(2) << '\n';
    stream.flush();
    if (!stream)
      throw std::runtime_error("state_file_write_failed");
  }
  if (std::rename(temporary.c_str(), path.c_str()) != 0)
    throw std::runtime_error("state_file_replace_failed");
}
std::string text(const std::string &path) {
  std::ifstream stream(path);
  if (!stream)
    throw std::runtime_error("file_unreadable:" + path);
  return {std::istreambuf_iterator<char>(stream),
          std::istreambuf_iterator<char>()};
}
} // namespace
int main(int argc, char **argv) {
  std::ostream output(std::cout.rdbuf());
  std::cout.rdbuf(std::cerr.rdbuf());
  using namespace agro_bt;
  Json report;
  std::unique_ptr<Executor> executor;
  std::shared_ptr<Broker> broker;
  std::string state_file;
  bool executing = false;
  try {
    std::map<std::string, std::string> options;
    bool validate = false;
    for (int i = 1; i < argc; i++) {
      std::string key = argv[i];
      if (key == "--help") {
        output << "agro-bt --xml tree.xml [--registry snapshot.json "
                  "--validate-only] [--endpoint http://127.0.0.1:8765 "
                  "--session-file path --control-file path --task-run-id id "
                  "--state-file path --timeout-ms n --cancel-after-ms n "
                  "--blackboard path --models path]\n";
        return 0;
      }
      if (key == "--validate-only") {
        validate = true;
        continue;
      }
      if (key.rfind("--", 0) != 0 || i + 1 >= argc)
        throw std::runtime_error("invalid_argument");
      options[key] = argv[++i];
    }
    state_file = options.count("--state-file") ? options["--state-file"] : "";
    std::shared_ptr<Transport> transport;
    Json registry, control;
    if (validate) {
      registry = read_json(options.at("--registry"));
      control = Json::object();
    } else {
      auto secret = text(options.at("--session-file"));
      while (!secret.empty() &&
             (secret.back() == '\n' || secret.back() == '\r'))
        secret.pop_back();
      transport = std::make_shared<HttpTransport>(options.count("--endpoint")
                                                      ? options["--endpoint"]
                                                      : "http://127.0.0.1:8765",
                                                  secret);
      registry = transport->request("GET", "/system/snapshot");
      if (options.count("--registry") &&
          registry != read_json(options["--registry"]))
        throw std::runtime_error("snapshot_mismatch");
      control = read_json(options.at("--control-file"));
    }
    // 离线校验不派发网络，工作线程保持空队列
    broker = std::make_shared<Broker>(
        transport ? transport
                  : std::make_shared<HttpTransport>("http://127.0.0.1:8765",
                                                    "validation_only"));
    executor = std::make_unique<Executor>(
        registry, broker, control,
        options.count("--task-run-id") ? options["--task-run-id"] : "task_bt");
    executor->load_xml(text(options.at("--xml")),
                       options.count("--blackboard")
                           ? read_json(options["--blackboard"])
                           : Json::object());
    if (options.count("--models")) {
      std::ofstream stream(options["--models"]);
      stream << executor->models();
    }
    if (validate) {
      output << Json{{"valid", true}}.dump() << '\n';
      return 0;
    }
    executing = true;
    std::signal(SIGTERM, stop);
    std::signal(SIGINT, stop);
    long timeout = options.count("--timeout-ms")
                       ? std::stol(options["--timeout-ms"])
                       : 30000;
    long cancel_after = options.count("--cancel-after-ms")
                            ? std::stol(options["--cancel-after-ms"])
                            : -1;
    auto begin = std::chrono::steady_clock::now();
    BT::NodeStatus state = BT::NodeStatus::RUNNING;
    double max_tick = 0;
    while (state == BT::NodeStatus::RUNNING) {
      auto now = std::chrono::steady_clock::now();
      auto elapsed =
          std::chrono::duration_cast<std::chrono::milliseconds>(now - begin)
              .count();
      if (stopped || elapsed >= timeout ||
          (cancel_after >= 0 && elapsed >= cancel_after)) {
        executor->halt();
        break;
      }
      auto before = std::chrono::steady_clock::now();
      state = executor->tick();
      max_tick =
          std::max(max_tick, std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - before)
                                 .count());
      save_state(state_file, executor->report());
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    if (state != BT::NodeStatus::SUCCESS)
      broker->stop();
    auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(2600);
    while (!broker->settled() && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    report = executor->report();
    report["max_tick_ms"] = max_tick;
    save_state(state_file, report);
    output << report.dump() << '\n';
    return state == BT::NodeStatus::SUCCESS && broker->settled() ? 0 : 1;
  } catch (const std::exception &exc) {
    if (executor) {
      executor->halt();
      auto deadline =
          std::chrono::steady_clock::now() + std::chrono::milliseconds(2600);
      while (!broker->settled() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      report = executor->report();
    } else
      report = Json::object();
    report["error"] = {{"code", executing ? "tree_execution_failed"
                                          : "tree_validation_failed"},
                       {"reason", exc.what()}};
    save_state(state_file, report);
    output << report.dump() << '\n';
    return 1;
  }
}
