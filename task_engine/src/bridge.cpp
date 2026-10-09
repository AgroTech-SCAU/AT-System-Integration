#include "agro_bt/bridge.hpp"
#include <algorithm>
#include <cmath>
#include <curl/curl.h>
#include <fstream>
#include <regex>
#include <sstream>
#include <stdexcept>
namespace agro_bt {
namespace {
Json failure(const std::string &code, const std::string &reason,
             bool unknown = true) {
  return {
      {"state", unknown ? "UNKNOWN" : "FAILED"},
      {"stop_state", unknown ? "UNCONFIRMED" : "NOT_APPLICABLE"},
      {"error", {{"code", code}, {"reason", reason}, {"retryable", false}}}};
}
bool terminal(const Json &s) {
  auto state = s.value("state", "");
  return state == "SUCCEEDED" || state == "FAILED" || state == "CANCELED" ||
         state == "UNKNOWN";
}
bool confirmed(const Json &s) {
  auto state = s.value("stop_state", "");
  return state == "CONFIRMED" || state == "NOT_APPLICABLE";
}
size_t receive(char *ptr, size_t size, size_t count, void *data) {
  auto &buffer = *static_cast<std::string *>(data);
  size_t bytes = size * count;
  if (buffer.size() + bytes > 4 * 1024 * 1024)
    return 0;
  buffer.append(ptr, bytes);
  return bytes;
}
} // namespace
Json read_json(const std::string &path) {
  std::ifstream stream(path);
  if (!stream)
    throw std::runtime_error("file_unreadable: " + path);
  Json result;
  stream >> result;
  return result;
}
HttpTransport::HttpTransport(std::string endpoint, std::string secret,
                             long timeout)
    : endpoint_(std::move(endpoint)), secret_(std::move(secret)),
      timeout_ms_(timeout) {
  static const int initialized = []() {
    return curl_global_init(CURL_GLOBAL_DEFAULT);
  }();
  if (initialized != CURLE_OK)
    throw std::runtime_error("curl_initialization_failed");
  bool local = false;
  for (const std::string host :
       {"http://127.0.0.1", "http://localhost", "http://[::1]"}) {
    if (endpoint_.compare(0, host.size(), host) == 0 &&
        (endpoint_.size() == host.size() || endpoint_[host.size()] == ':')) {
      std::string port = endpoint_.substr(host.size());
      local = port.empty() ||
              (port.size() > 1 && port[0] == ':' &&
               std::all_of(port.begin() + 1, port.end(),
                           [](char c) { return c >= '0' && c <= '9'; }));
    }
  }
  if (!local || secret_.empty() ||
      secret_.find_first_of("\r\n") != std::string::npos || timeout <= 0)
    throw std::runtime_error("loopback_session_required");
}
Json HttpTransport::request(const std::string &method, const std::string &path,
                            const Json &body) {
  auto *curl = curl_easy_init();
  if (!curl)
    throw std::runtime_error("curl_initialization_failed");
  std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> owner(curl,
                                                            curl_easy_cleanup);
  curl_slist *headers = nullptr;
  headers =
      curl_slist_append(headers, ("Authorization: Bearer " + secret_).c_str());
  headers = curl_slist_append(headers, "Content-Type: application/json");
  std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)> header_owner(
      headers, curl_slist_free_all);
  std::string response, encoded = body.is_null() ? "" : body.dump(),
                        url = endpoint_ + path;
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_PROXY, "");
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, timeout_ms_);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeout_ms_);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
  if (method == "POST") {
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, encoded.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,
                     static_cast<long>(encoded.size()));
  }
  auto code = curl_easy_perform(curl);
  if (code != CURLE_OK)
    throw std::runtime_error(std::string("transport_error: ") +
                             curl_easy_strerror(code));
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  Json parsed = Json::parse(response);
  if (status < 200 || status >= 300)
    throw std::runtime_error("http_rejected:" + std::to_string(status) + ":" +
                             parsed.dump());
  return parsed;
}
Broker::Broker(std::shared_ptr<Transport> transport, size_t workers,
               size_t capacity, std::chrono::milliseconds timeout)
    : transport_(std::move(transport)), capacity_(capacity),
      cancel_timeout_(timeout) {
  if (!transport_ || workers == 0 || workers > 8 || capacity == 0 ||
      timeout.count() <= 0)
    throw std::runtime_error("invalid_worker_bounds");
  for (size_t i = 0; i < workers; i++)
    threads_.emplace_back([this] { work(); });
}
Broker::~Broker() {
  stop();
  auto deadline = std::chrono::steady_clock::now() + cancel_timeout_ +
                  std::chrono::milliseconds(600);
  while (!settled() && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  {
    std::lock_guard<std::mutex> lock(mutex_);
    closing_ = true;
  }
  wake_.notify_all();
  for (auto &t : threads_)
    t.join();
}
Broker::Handle Broker::submit(const std::string &node, Json request) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (stopping_)
    throw std::runtime_error("task_dispatch_stopped");
  size_t pending = 0;
  for (const auto &op : operations_)
    if (!terminal(op->snapshot) || !confirmed(op->snapshot))
      pending++;
  if (pending >= capacity_)
    throw std::runtime_error("worker_capacity_exceeded");
  auto op = std::make_shared<Operation>();
  op->node_id = node;
  op->request_id = request.at("request_id");
  op->request = std::move(request);
  op->snapshot = {{"operation_id", "local_" + op->request_id},
                  {"state", "ACCEPTED"},
                  {"stop_state", "UNCONFIRMED"}};
  operations_.push_back(op);
  wake_.notify_all();
  return op;
}
Json Broker::snapshot(const Handle &handle) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return handle->snapshot;
}
void Broker::stop() {
  std::lock_guard<std::mutex> lock(mutex_);
  stopping_ = true;
  auto now = std::chrono::steady_clock::now();
  for (const auto &op : operations_)
    if (!terminal(op->snapshot) || !confirmed(op->snapshot)) {
      if (!op->cancel_requested) {
        op->cancel_requested = true;
        op->cancel_deadline = now + cancel_timeout_;
      }
      op->next = now;
    }
  wake_.notify_all();
}
bool Broker::dispatch_stopped() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return stopping_;
}
bool Broker::settled() const {
  std::lock_guard<std::mutex> lock(mutex_);
  for (const auto &op : operations_)
    if (!terminal(op->snapshot) || !confirmed(op->snapshot))
      return false;
  return true;
}
Json Broker::report() const {
  std::lock_guard<std::mutex> lock(mutex_);
  Json report = Json::array();
  for (const auto &op : operations_)
    report.push_back({{"node_id", op->node_id},
                      {"request_id", op->request_id},
                      {"operation_id", op->operation_id},
                      {"cancel_requested", op->cancel_requested},
                      {"snapshot", op->snapshot}});
  return report;
}
void Broker::work() {
  while (true) {
    Handle op;
    std::string method, path;
    Json body;
    bool submit_call = false;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      wake_.wait_for(lock, std::chrono::milliseconds(10));
      if (closing_)
        return;
      auto now = std::chrono::steady_clock::now();
      for (const auto &candidate : operations_) {
        if (candidate->in_flight)
          continue;
        if (candidate->cancel_requested && now >= candidate->cancel_deadline &&
            !confirmed(candidate->snapshot)) {
          if (candidate->snapshot.value("state", "") != "UNKNOWN") {
            candidate->snapshot = failure("cancel_stop_unconfirmed",
                                          "Cancellation deadline expired");
            candidate->snapshot["operation_id"] =
                candidate->operation_id.empty()
                    ? "local_" + candidate->request_id
                    : candidate->operation_id;
          }
          continue;
        }
        if (terminal(candidate->snapshot) && confirmed(candidate->snapshot))
          continue;
        if (candidate->next > now)
          continue;
        if (candidate->cancel_requested && !candidate->submitted) {
          candidate->snapshot = {
              {"operation_id", "local_" + candidate->request_id},
              {"state", "CANCELED"},
              {"stop_state", "NOT_APPLICABLE"}};
          continue;
        }
        if (candidate->submitted && candidate->operation_id.empty())
          continue;
        op = candidate;
        op->in_flight = true;
        if (!op->submitted) {
          op->submitted = true;
          submit_call = true;
          method = "POST";
          path = "/operations";
          body = op->request;
        } else if (op->cancel_requested && !op->cancel_sent) {
          op->cancel_sent = true;
          method = "POST";
          path = "/operations/" + op->operation_id + "/cancel";
        } else {
          method = "GET";
          path = "/operations/" + op->operation_id;
        }
        break;
      }
    }
    if (!op)
      continue;
    Json result;
    bool valid_remote = false;
    try {
      result = transport_->request(method, path, body);
      const std::string state = result.at("state");
      const std::string stop = result.at("stop_state");
      if (state != "ACCEPTED" && state != "RUNNING" && state != "CANCELING" &&
          state != "SUCCEEDED" && state != "FAILED" && state != "CANCELED" &&
          state != "UNKNOWN")
        throw std::runtime_error("invalid_operation_state");
      if (stop != "CONFIRMED" && stop != "UNCONFIRMED" &&
          stop != "NOT_APPLICABLE")
        throw std::runtime_error("invalid_stop_state");
      const auto id = result.at("operation_id").get<std::string>();
      if (result.contains("extensions") && !result["extensions"].is_object())
        throw std::runtime_error("invalid_extensions");
      if (!std::regex_match(id, std::regex("[a-z][a-z0-9_]*")))
        throw std::runtime_error("invalid_operation_id");
      if (!submit_call && id != op->operation_id)
        throw std::runtime_error("operation_identity_mismatch");
      for (auto it = result.begin(); it != result.end(); ++it)
        if (it.key() != "operation_id" && it.key() != "state" &&
            it.key() != "stop_state" && it.key() != "feedback" &&
            it.key() != "result" && it.key() != "error" &&
            it.key() != "cancel_requested" && it.key() != "cancel_accepted" &&
            it.key() != "extensions")
          throw std::runtime_error("unknown_snapshot_field");
      for (const auto key : {"cancel_requested", "cancel_accepted"})
        if (result.contains(key) && !result[key].is_boolean())
          throw std::runtime_error("invalid_cancel_flag");
      if (result.value("cancel_accepted", false) &&
          !result.value("cancel_requested", false))
        throw std::runtime_error("invalid_cancel_state");
      if (state == "CANCELED" && stop == "UNCONFIRMED")
        throw std::runtime_error("stop_unconfirmed");
      if (state == "SUCCEEDED" &&
          (!result.contains("result") || !result["result"].is_object()))
        throw std::runtime_error("result_missing");
      if (result.contains("result") && !result["result"].is_null()) {
        if (!result["result"].is_object() ||
            (result["result"].size() != 1 &&
             !(result["result"].size() == 2 &&
               result["result"].contains("extensions"))) ||
            !result["result"].at("output").is_object())
          throw std::runtime_error("invalid_result");
        if (state == "ACCEPTED" || state == "RUNNING" || state == "CANCELING")
          throw std::runtime_error("premature_result");
      }
      if (state == "FAILED" || state == "UNKNOWN") {
        const auto &error = result.at("error");
        if (!error.is_object() || !error.at("code").is_string() ||
            !std::regex_match(error.at("code").get<std::string>(),
                              std::regex("[a-z][a-z0-9_]*")) ||
            !error.at("reason").is_string() ||
            error.at("reason").get<std::string>().empty())
          throw std::runtime_error("invalid_error");
        if (error.contains("retryable") && !error["retryable"].is_boolean())
          throw std::runtime_error("invalid_retryable");
        if (state == "UNKNOWN" && error.value("retryable", false))
          throw std::runtime_error("unsafe_retry");
      }
      if (result.contains("error") && !result["error"].is_null()) {
        const auto &error = result["error"];
        if (!error.is_object() || !error.at("code").is_string() ||
            !std::regex_match(error.at("code").get<std::string>(),
                              std::regex("[a-z][a-z0-9_]*")) ||
            !error.at("reason").is_string() ||
            error.at("reason").get<std::string>().empty())
          throw std::runtime_error("invalid_error");
        for (auto it = error.begin(); it != error.end(); ++it)
          if (it.key() != "code" && it.key() != "reason" &&
              it.key() != "path" && it.key() != "retryable" &&
              it.key() != "extensions")
            throw std::runtime_error("unknown_error_field");
        if (error.contains("path") && !error["path"].is_string())
          throw std::runtime_error("invalid_error_path");
        if (error.contains("retryable") && !error["retryable"].is_boolean())
          throw std::runtime_error("invalid_retryable");
      }
      if (result.contains("feedback")) {
        const auto &f = result["feedback"];
        if (!f.is_object())
          throw std::runtime_error("invalid_feedback");
        for (auto it = f.begin(); it != f.end(); ++it) {
          const auto &key = it.key();
          const auto &v = it.value();
          if (key == "data" || key == "extensions") {
            if (!v.is_object())
              throw std::runtime_error("invalid_feedback_data");
          } else if (key == "timestamp" || key == "progress") {
            if (!v.is_null() &&
                (!v.is_number() || !std::isfinite(v.get<double>()) ||
                 v.get<double>() < 0 ||
                 (key == "progress" && v.get<double>() > 1)))
              throw std::runtime_error("invalid_feedback_number");
          } else if (key == "stage" || key == "clock_domain") {
            if (!v.is_null() &&
                (!v.is_string() || v.get<std::string>().empty()))
              throw std::runtime_error("invalid_feedback_string");
          } else
            throw std::runtime_error("unknown_feedback_field");
        }
      }
      valid_remote = true;
    } catch (const std::exception &exc) {
      auto reason = std::string(exc.what());
      bool rejected =
          submit_call && (reason.rfind("http_rejected:401:", 0) == 0 ||
                          reason.rfind("http_rejected:403:", 0) == 0 ||
                          reason.rfind("http_rejected:422:", 0) == 0);
      result = failure(rejected ? "request_rejected"
                                : (submit_call ? "submission_outcome_unknown"
                                               : "service_disconnected"),
                       reason, !rejected);
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      op->in_flight = false;
      if (submit_call && valid_remote)
        op->operation_id = result.at("operation_id");
      if (!valid_remote)
        result["operation_id"] = op->operation_id.empty()
                                     ? "local_" + op->request_id
                                     : op->operation_id;
      if (op->snapshot.value("state", "") == "UNKNOWN") {
        if (valid_remote && confirmed(result))
          op->snapshot["stop_state"] = result["stop_state"];
      } else
        op->snapshot = result;
      op->next =
          std::chrono::steady_clock::now() + std::chrono::milliseconds(20);
      if (result.value("state", "") == "UNKNOWN" ||
          (terminal(result) && !confirmed(result))) {
        stopping_ = true;
        for (const auto &pending : operations_)
          if (!terminal(pending->snapshot) || !confirmed(pending->snapshot)) {
            if (!pending->cancel_requested) {
              pending->cancel_requested = true;
              pending->cancel_deadline =
                  std::chrono::steady_clock::now() + cancel_timeout_;
            }
          }
      }
      wake_.notify_all();
    }
  }
}
std::ostream &operator<<(std::ostream &s, const Quantity &v) {
  return s << Json{{"value", v.value}, {"unit", v.unit}}.dump();
}
std::ostream &operator<<(std::ostream &s, const IntegerQuantity &v) {
  return s << Json{{"value", v.value}, {"unit", v.unit}}.dump();
}
std::ostream &operator<<(std::ostream &s, const StampedPose &v) {
  return s << v.value.dump();
}
std::ostream &operator<<(std::ostream &s, const TargetList &v) {
  Json j = Json::array();
  for (const auto &t : v.targets)
    j.push_back(t.value);
  return s << j.dump();
}
std::ostream &operator<<(std::ostream &s, const PickResult &v) {
  return s << v.value.dump();
}
} // namespace agro_bt
namespace BT {
namespace {
agro_bt::Json literal(StringView text) {
  std::string value(text.data(), text.size());
  if (value.rfind("json:", 0) == 0)
    value.erase(0, 5);
  return agro_bt::Json::parse(value);
}
} // namespace
template <>
agro_bt::Quantity convertFromString<agro_bt::Quantity>(StringView text) {
  auto j = literal(text);
  if (!j.at("value").is_number())
    throw RuntimeError("invalid_quantity");
  return {j.at("value"), j.at("unit")};
}
template <>
agro_bt::IntegerQuantity
convertFromString<agro_bt::IntegerQuantity>(StringView text) {
  auto j = literal(text);
  if (!j.at("value").is_number_integer() ||
      (j.at("value").is_number_unsigned() &&
       j.at("value").get<uint64_t>() > static_cast<uint64_t>(INT64_MAX)))
    throw RuntimeError("invalid_integer_quantity");
  return {j.at("value"), j.at("unit")};
}
template <>
agro_bt::StampedPose convertFromString<agro_bt::StampedPose>(StringView text) {
  return {literal(text)};
}
template <>
agro_bt::TargetList convertFromString<agro_bt::TargetList>(StringView text) {
  auto j = literal(text);
  if (!j.is_array())
    throw RuntimeError("invalid_target_list");
  agro_bt::TargetList result;
  for (const auto &t : j)
    result.targets.push_back({t});
  return result;
}
template <>
agro_bt::PickResult convertFromString<agro_bt::PickResult>(StringView text) {
  return {literal(text)};
}
} // namespace BT
