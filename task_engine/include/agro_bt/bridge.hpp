#pragma once
#include <behaviortree_cpp/bt_factory.h>
#include <behaviortree_cpp/contrib/json.hpp>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
namespace agro_bt {
using Json = nlohmann::json;
struct Quantity {
  double value;
  std::string unit;
};
struct IntegerQuantity {
  int64_t value;
  std::string unit;
};
struct StampedPose {
  Json value;
};
struct TargetList {
  std::vector<StampedPose> targets;
};
struct PickResult {
  Json value;
};
Json read_json(const std::string &path);
void validate_value(const Json &spec, const Json &value);
std::ostream &operator<<(std::ostream &, const Quantity &);
std::ostream &operator<<(std::ostream &, const IntegerQuantity &);
std::ostream &operator<<(std::ostream &, const StampedPose &);
std::ostream &operator<<(std::ostream &, const TargetList &);
std::ostream &operator<<(std::ostream &, const PickResult &);
struct Transport {
  virtual ~Transport() = default;
  virtual Json request(const std::string &method, const std::string &path,
                       const Json &body = Json()) = 0;
};
class HttpTransport : public Transport {
  std::string endpoint_, secret_;
  long timeout_ms_;

public:
  HttpTransport(std::string endpoint, std::string secret,
                long timeout_ms = 500);
  Json request(const std::string &, const std::string &,
               const Json &body = Json()) override;
};
class Broker {
public:
  struct Operation {
    std::string node_id, request_id, operation_id;
    Json request, snapshot;
    bool submitted = false, in_flight = false, cancel_requested = false,
         cancel_sent = false;
    std::chrono::steady_clock::time_point next = {}, cancel_deadline = {};
  };
  using Handle = std::shared_ptr<Operation>;
  Broker(std::shared_ptr<Transport>, size_t workers = 2, size_t capacity = 32,
         std::chrono::milliseconds cancel_timeout =
             std::chrono::milliseconds(2000));
  ~Broker();
  Handle submit(const std::string &node_id, Json request);
  Json snapshot(const Handle &) const;
  void stop();
  bool dispatch_stopped() const;
  bool settled() const;
  Json report() const;

private:
  std::shared_ptr<Transport> transport_;
  size_t capacity_;
  std::chrono::milliseconds cancel_timeout_;
  mutable std::mutex mutex_;
  std::condition_variable wake_;
  std::vector<Handle> operations_;
  std::vector<std::thread> threads_;
  bool stopping_ = false, closing_ = false;
  void work();
};
class Executor {
  Json registry_, control_;
  std::string task_id_;
  std::shared_ptr<Broker> broker_;
  BT::BehaviorTreeFactory factory_;
  std::unique_ptr<BT::Tree> tree_;
  BT::NodeStatus status_ = BT::NodeStatus::IDLE;
  bool instance_ids_;
  uint64_t event_sequence_ = 0;
  Json events_ = Json::array();
  std::vector<BT::TreeNode::StatusChangeSubscriber> subscriptions_;

public:
  Executor(Json registry, std::shared_ptr<Broker>, Json control,
           std::string task_id, bool instance_ids = false);
  void load_xml(const std::string &, const Json &blackboard = Json::object());
  BT::NodeStatus tick();
  void halt();
  Json report() const;
  std::string models() const;
  Json describe() const;
};
} // namespace agro_bt
namespace BT {
template <> agro_bt::Quantity convertFromString<agro_bt::Quantity>(StringView);
template <>
agro_bt::IntegerQuantity
    convertFromString<agro_bt::IntegerQuantity>(StringView);
template <>
agro_bt::StampedPose convertFromString<agro_bt::StampedPose>(StringView);
template <>
agro_bt::TargetList convertFromString<agro_bt::TargetList>(StringView);
template <>
agro_bt::PickResult convertFromString<agro_bt::PickResult>(StringView);
} // namespace BT
