#include "agro_bt/bridge.hpp"
#include <atomic>
#include <behaviortree_cpp/xml_parsing.h>
#include <cmath>
#include <regex>
#include <set>
#include <stdexcept>
namespace agro_bt {
namespace {
void require(bool okay, const std::string &reason) {
  if (!okay)
    throw std::runtime_error(reason);
}
bool is_identifier(const std::string &value) {
  return std::regex_match(value, std::regex("[a-z][a-z0-9_]*"));
}
std::string registration(const std::string &capability) {
  auto result = "Capability_" + capability;
  std::replace(result.begin(), result.end(), '.', '_');
  return result;
}
void pose_shape(const Json &value) {
  require(value.is_object() &&
              (value.size() == 7 ||
               (value.size() == 8 && value.contains("extensions") &&
                value["extensions"].is_object())),
          "invalid_pose");
  for (const auto &key : {"target_id", "frame_id", "clock_domain", "timestamp",
                          "position", "position_unit", "orientation"})
    require(value.contains(key), std::string("pose_field_missing:") + key);
  require(value.at("target_id").is_string() &&
              is_identifier(value.at("target_id")),
          "invalid_target_id");
  require(value.at("frame_id").is_string() &&
              value.at("clock_domain").is_string(),
          "invalid_pose_frame_clock");
  require(value.at("timestamp").is_number() &&
              value.at("timestamp").get<double>() >= 0 &&
              std::isfinite(value.at("timestamp").get<double>()),
          "invalid_pose_timestamp");
  require(value.at("position_unit") == "m", "unit_mismatch");
  require(value.at("position").is_array() && value.at("position").size() == 3,
          "invalid_position");
  require(value.at("orientation").is_array() &&
              value.at("orientation").size() == 4,
          "invalid_orientation");
  for (const auto &item : value.at("position"))
    require(item.is_number() && std::isfinite(item.get<double>()),
            "invalid_position");
  double norm = 0;
  for (const auto &item : value.at("orientation")) {
    require(item.is_number() && std::isfinite(item.get<double>()),
            "invalid_orientation");
    norm += item.get<double>() * item.get<double>();
  }
  require(std::abs(norm - 1) <= 1e-6, "invalid_orientation");
}
BT::PortInfo port(const Json &spec, BT::PortDirection direction) {
  std::string type = spec.at("type");
  if (type == "string")
    return BT::CreatePort<std::string>(direction, "value").second;
  if (type == "boolean")
    return BT::CreatePort<bool>(direction, "value").second;
  if (type == "number")
    return BT::CreatePort<Quantity>(direction, "value").second;
  if (type == "integer")
    return BT::CreatePort<IntegerQuantity>(direction, "value").second;
  if (type == "stamped_pose")
    return BT::CreatePort<StampedPose>(direction, "value").second;
  if (type == "target_list")
    return BT::CreatePort<TargetList>(direction, "value").second;
  if (type == "pick_result")
    return BT::CreatePort<PickResult>(direction, "value").second;
  throw std::runtime_error("unsupported_contract_type:" + type);
}
template <class T> T input(BT::TreeNode &node, const std::string &key) {
  auto result = node.getInput<T>(key);
  if (!result)
    throw std::runtime_error("port:" + key + ":" + result.error());
  return result.value();
}
Json read_port(BT::TreeNode &node, const std::string &key, const Json &spec) {
  std::string type = spec.at("type");
  Json value;
  if (type == "string")
    value = input<std::string>(node, key);
  else if (type == "boolean")
    value = input<bool>(node, key);
  else if (type == "number") {
    auto number = input<Quantity>(node, key);
    require(number.unit == spec.at("unit"), "unit_mismatch:" + key);
    value = number.value;
  } else if (type == "integer") {
    auto number = input<IntegerQuantity>(node, key);
    require(number.unit == spec.at("unit"), "unit_mismatch:" + key);
    value = number.value;
  } else if (type == "stamped_pose")
    value = input<StampedPose>(node, key).value;
  else if (type == "target_list") {
    value = Json::array();
    for (const auto &p : input<TargetList>(node, key).targets)
      value.push_back(p.value);
  } else if (type == "pick_result")
    value = input<PickResult>(node, key).value;
  else
    throw std::runtime_error("unsupported_contract_type");
  validate_value(spec, value);
  return value;
}
void write_port(BT::TreeNode &node, const std::string &key, const Json &spec,
                const Json &value) {
  validate_value(spec, value);
  if (!static_cast<const BT::TreeNode &>(node).config().output_ports.count(key))
    return;
  std::string type = spec.at("type");
  BT::Result result;
  if (type == "string")
    result = node.setOutput(key, value.get<std::string>());
  else if (type == "boolean")
    result = node.setOutput(key, value.get<bool>());
  else if (type == "number")
    result =
        node.setOutput(key, Quantity{value.get<double>(), spec.at("unit")});
  else if (type == "integer")
    result = node.setOutput(
        key, IntegerQuantity{value.get<int64_t>(), spec.at("unit")});
  else if (type == "stamped_pose")
    result = node.setOutput(key, StampedPose{value});
  else if (type == "target_list") {
    TargetList targets;
    for (const auto &p : value)
      targets.targets.push_back({p});
    result = node.setOutput(key, targets);
  } else if (type == "pick_result")
    result = node.setOutput(key, PickResult{value});
  if (!result)
    throw std::runtime_error("output_port:" + key + ":" + result.error());
}
class Capability : public BT::StatefulActionNode {
  Json cap_, control_, role_parameters_ = Json::object();
  std::string backend_, node_id_, task_id_;
  std::shared_ptr<Broker> broker_;
  Broker::Handle operation_;
  static std::atomic<uint64_t> counter_;

public:
  Capability(const std::string &name, const BT::NodeConfig &config, Json cap,
             Json system, std::shared_ptr<Broker> broker, Json control,
             std::string task, bool instance_ids)
      : BT::StatefulActionNode(name, config), cap_(std::move(cap)),
        control_(std::move(control)), task_id_(std::move(task)),
        broker_(std::move(broker)) {
    node_id_ = input<std::string>(*this, "node_id");
    require(is_identifier(node_id_), "invalid_node_id");
    if (instance_ids) {
      node_id_ = "instance_";
      for (char c : config.path)
        node_id_ += (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ? c : '_';
    }
    auto role = config.input_ports.find("role"),
         backend = config.input_ports.find("backend_instance");
    require((role != config.input_ports.end()) !=
                (backend != config.input_ports.end()),
            "binding_required: specify exactly one role or backend_instance");
    if (role != config.input_ports.end()) {
      auto name = input<std::string>(*this, "role");
      require(system.at("roles").contains(name), "unknown_role:" + name);
      const auto &bound = system.at("roles").at(name);
      require(bound.at("capability_id") == cap_.at("capability_id"),
              "role_capability_mismatch");
      backend_ = bound.at("backend_instance");
      role_parameters_ = bound.value("parameters", Json::object());
    } else
      backend_ = input<std::string>(*this, "backend_instance");
    bool provided = false;
    for (const auto &candidate : system.at("backends"))
      if (candidate.at("instance_id") == backend_ &&
          candidate.at("package_id") == cap_.at("package_id"))
        provided = true;
    require(provided, "backend_capability_missing:" + backend_);
    for (const auto &kind : {"input", "parameters"})
      for (auto item = cap_.at(kind).begin(); item != cap_.at(kind).end();
           ++item) {
        auto key = std::string(kind) == "parameters"
                       ? "param_" + item.key()
                       : (std::string(kind) == "output" ? "out_" + item.key()
                                                        : item.key());
        auto found = config.input_ports.find(key);
        if (found == config.input_ports.end()) {
          require(std::string(kind) == "parameters" &&
                      (!item.value().value("required", false) ||
                       item.value().contains("default") ||
                       role_parameters_.contains(item.key())),
                  "required_port:" + key);
          continue;
        }
        require(!found->second.empty(), "empty_port:" + key);
        if (!BT::TreeNode::isBlackboardPointer(found->second))
          read_port(*this, key, item.value());
      }
  }
  const Json &capability() const { return cap_; }
  const std::string &node_id() const { return node_id_; }
  BT::NodeStatus onStart() override {
    try {
      require(!broker_->dispatch_stopped(), "task_dispatch_stopped");
      Json inputs = Json::object(), parameters = Json::object();
      for (const auto &kind : {"input", "parameters"})
        for (auto item = cap_.at(kind).begin(); item != cap_.at(kind).end();
             ++item) {
          auto key = std::string(kind) == "parameters"
                         ? "param_" + item.key()
                         : (std::string(kind) == "output" ? "out_" + item.key()
                                                          : item.key());
          if (config().input_ports.count(key))
            (std::string(kind) == "input" ? inputs : parameters)[item.key()] =
                read_port(*this, key, item.value());
          else if (std::string(kind) == "parameters" &&
                   role_parameters_.contains(item.key())) {
            validate_value(item.value(), role_parameters_.at(item.key()));
            parameters[item.key()] = role_parameters_.at(item.key());
          } else if (item.value().contains("default"))
            parameters[item.key()] = item.value().at("default");
        }
      auto request_id =
          task_id_ + "_" + node_id_ + "_" + std::to_string(counter_++);
      operation_ = broker_->submit(node_id_,
                                   {{"capability_id", cap_.at("capability_id")},
                                    {"backend_instance", backend_},
                                    {"input", inputs},
                                    {"parameters", parameters},
                                    {"request_id", request_id},
                                    {"task_run_id", task_id_},
                                    {"node_id", node_id_},
                                    {"control", control_}});
      return BT::NodeStatus::RUNNING;
    } catch (const std::exception &e) {
      throw BT::RuntimeError("dispatch_validation_failed:", e.what());
    }
  }
  BT::NodeStatus onRunning() override {
    auto s = broker_->snapshot(operation_);
    std::string state = s.at("state");
    if (state == "SUCCEEDED") {
      const auto &output = s.at("result").at("output");
      for (auto item = cap_.at("output").begin();
           item != cap_.at("output").end(); ++item)
        write_port(*this, "out_" + item.key(), item.value(),
                   output.at(item.key()));
      return BT::NodeStatus::SUCCESS;
    }
    if (state == "FAILED" || state == "CANCELED" || state == "UNKNOWN")
      return BT::NodeStatus::FAILURE;
    return BT::NodeStatus::RUNNING;
  }
  void onHalted() override { broker_->stop(); }
};
std::atomic<uint64_t> Capability::counter_{1};
class ForEachTarget : public BT::DecoratorNode {
  TargetList targets_;
  size_t index_ = 0;
  bool supplied_ = false;

public:
  ForEachTarget(const std::string &name, const BT::NodeConfig &config)
      : BT::DecoratorNode(name, config) {}
  static BT::PortsList providedPorts() {
    return {BT::InputPort<TargetList>("targets"),
            BT::OutputPort<StampedPose>("target"),
            BT::OutputPort<std::string>("target_id"),
            BT::InputPort<int>("max_targets", 8, "Finite candidate bound")};
  }
  BT::NodeStatus tick() override {
    if (status() == BT::NodeStatus::IDLE) {
      targets_ = input<TargetList>(*this, "targets");
      index_ = 0;
      supplied_ = false;
      auto bound = input<int>(*this, "max_targets");
      require(bound > 0 && bound <= 8 &&
                  targets_.targets.size() <= static_cast<size_t>(bound),
              "candidate_limit_exceeded");
      std::set<std::string> ids;
      for (const auto &target : targets_.targets) {
        pose_shape(target.value);
        require(ids.insert(target.value.at("target_id")).second,
                "duplicate_target_id");
      }
    }
    if (index_ == targets_.targets.size())
      return BT::NodeStatus::SUCCESS;
    setStatus(BT::NodeStatus::RUNNING);
    if (!supplied_) {
      require(bool(setOutput("target", targets_.targets[index_])),
              "output_port_invalid");
      require(bool(setOutput("target_id", targets_.targets[index_]
                                              .value.at("target_id")
                                              .get<std::string>())),
              "output_port_invalid");
      supplied_ = true;
    }
    auto state = child_node_->executeTick();
    if (state == BT::NodeStatus::SUCCESS) {
      resetChild();
      index_++;
      supplied_ = false;
      return index_ == targets_.targets.size() ? BT::NodeStatus::SUCCESS
                                               : BT::NodeStatus::RUNNING;
    }
    return state;
  }
  void halt() override {
    targets_.targets.clear();
    index_ = 0;
    supplied_ = false;
    BT::DecoratorNode::halt();
  }
};

} // namespace
void validate_value(const Json &spec, const Json &value) {
  std::string type = spec.at("type");
  if (type == "string")
    require(value.is_string(), "invalid_string");
  else if (type == "boolean")
    require(value.is_boolean(), "invalid_boolean");
  else if (type == "number" || type == "integer") {
    require(type == "integer" ? value.is_number_integer() : value.is_number(),
            "invalid_numeric_type");
    require(std::isfinite(value.get<double>()), "invalid_number");
    if (type == "integer" && value.is_number_unsigned())
      require(value.get<uint64_t>() <= static_cast<uint64_t>(INT64_MAX),
              "integer_out_of_range");
    if (spec.contains("minimum") && !spec["minimum"].is_null())
      require(value.get<double>() >= spec["minimum"].get<double>(),
              "out_of_range");
    if (spec.contains("maximum") && !spec["maximum"].is_null())
      require(value.get<double>() <= spec["maximum"].get<double>(),
              "out_of_range");
  } else if (type == "stamped_pose" || type == "target_list") {
    if (type == "target_list")
      require(value.is_array(), "invalid_target_list");
    std::vector<Json> poses;
    if (type == "stamped_pose")
      poses.push_back(value);
    else
      for (const auto &p : value)
        poses.push_back(p);
    for (const auto &p : poses) {
      pose_shape(p);
      require(p.at("frame_id") == spec.at("frame_id"), "frame_mismatch");
      require(p.at("clock_domain") == spec.at("clock_domain"),
              "clock_mismatch");
      require(p.at("position_unit") == spec.at("unit"), "unit_mismatch");
    }
  } else if (type == "pick_result") {
    require(value.is_object() && value.at("target_id").is_string() &&
                is_identifier(value.at("target_id")),
            "invalid_pick_result");
    require(value.size() <= 4, "unknown_pick_field");
    for (auto it = value.begin(); it != value.end(); ++it)
      require(it.key() == "target_id" || it.key() == "outcome" ||
                  it.key() == "reason" || it.key() == "extensions",
              "unknown_pick_field");
    if (value.contains("reason") && !value["reason"].is_null())
      require(value["reason"].is_string() &&
                  !value["reason"].get<std::string>().empty(),
              "invalid_pick_reason");
    if (value.contains("extensions"))
      require(value["extensions"].is_object(), "invalid_extensions");
    const auto outcome = value.at("outcome");
    require(outcome == "picked" || outcome == "skipped" ||
                outcome == "failed" || outcome == "unknown",
            "invalid_pick_outcome");
    if (outcome == "unknown" || outcome == "failed")
      require(value.contains("reason") && value.at("reason").is_string() &&
                  !value.at("reason").get<std::string>().empty(),
              "pick_reason_required");
  } else
    throw std::runtime_error("unsupported_contract_type:" + type);
  if (spec.contains("choices") && !spec["choices"].is_null()) {
    bool found = false;
    for (const auto &choice : spec["choices"])
      if (choice == value)
        found = true;
    require(found, "invalid_choice");
  }
}
Executor::Executor(Json registry, std::shared_ptr<Broker> broker, Json control,
                   std::string task, bool instance_ids)
    : registry_(std::move(registry)), control_(std::move(control)),
      task_id_(std::move(task)), broker_(std::move(broker)), instance_ids_(instance_ids) {
  require(is_identifier(task_id_), "invalid_task_run_id");
  for (auto package = registry_.at("packages").begin();
       package != registry_.at("packages").end(); ++package)
    for (Json cap : package.value().at("capabilities")) {
      cap["package_id"] = package.key();
      BT::PortsList ports;
      ports.insert(BT::InputPort<std::string>("node_id"));
      ports.insert(BT::InputPort<std::string>("role"));
      ports.insert(BT::InputPort<std::string>("backend_instance"));
      for (const auto &kind : {"input", "output", "parameters"})
        for (auto item = cap.at(kind).begin(); item != cap.at(kind).end();
             ++item) {
          auto key = std::string(kind) == "parameters"
                         ? "param_" + item.key()
                         : (std::string(kind) == "output" ? "out_" + item.key()
                                                          : item.key());
          require(!ports.count(key), "reserved_port_collision:" + key);
          ports.insert(
              {key, port(item.value(), std::string(kind) == "output"
                                           ? BT::PortDirection::OUTPUT
                                           : BT::PortDirection::INPUT)});
        }
      auto system = registry_.at("system");
      auto shared = broker_;
      auto token = control_;
      auto task_name = task_id_;
      factory_.registerBuilder(
          BT::TreeNodeManifest{BT::NodeType::ACTION,
                               registration(cap.at("capability_id")),
                               ports,
                               {}},
          [cap, system, shared, token,
           task_name, instance_ids](const std::string &name, const BT::NodeConfig &config) {
            return std::make_unique<Capability>(name, config, cap, system,
                                                shared, token, task_name, instance_ids);
          });
    }
  factory_.registerNodeType<ForEachTarget>("ForEachTarget");
  factory_.registerSimpleCondition("IsTrue",
                                   [](BT::TreeNode &node) {
                                     return input<bool>(node, "value")
                                                ? BT::NodeStatus::SUCCESS
                                                : BT::NodeStatus::FAILURE;
                                   },
                                   {BT::InputPort<bool>("value")});
  factory_.registerSimpleCondition("HasTarget",
                                   [](BT::TreeNode &node) {
                                     auto pose =
                                         input<StampedPose>(node, "target");
                                     pose_shape(pose.value);
                                     return BT::NodeStatus::SUCCESS;
                                   },
                                   {BT::InputPort<StampedPose>("target")});
  factory_.registerSimpleCondition(
      "PickSucceeded",
      [](BT::TreeNode &node) {
        auto result = input<PickResult>(node, "result");
        validate_value({{"type", "pick_result"}}, result.value);
        return result.value.at("outcome") == "picked" ? BT::NodeStatus::SUCCESS
                                                      : BT::NodeStatus::FAILURE;
      },
      {BT::InputPort<PickResult>("result")});
  factory_.registerSimpleAction(
      "TargetsFromPose",
      [](BT::TreeNode &node) {
        auto pose = input<StampedPose>(node, "target");
        pose_shape(pose.value);
        require(bool(node.setOutput("targets", TargetList{{pose}})),
                "output_port_invalid");
        return BT::NodeStatus::SUCCESS;
      },
      {BT::InputPort<StampedPose>("target"),
       BT::OutputPort<TargetList>("targets")});
  factory_.registerSimpleAction(
      "SelectTarget",
      [](BT::TreeNode &node) {
        auto targets = input<TargetList>(node, "targets");
        auto index = input<IntegerQuantity>(node, "index");
        require(index.unit == "1" && index.value >= 0, "invalid_target_index");
        if (static_cast<size_t>(index.value) >= targets.targets.size())
          return BT::NodeStatus::FAILURE;
        pose_shape(targets.targets[index.value].value);
        require(bool(node.setOutput("target", targets.targets[index.value])),
                "output_port_invalid");
        return BT::NodeStatus::SUCCESS;
      },
      {BT::InputPort<TargetList>("targets"),
       BT::InputPort<IntegerQuantity>("index"),
       BT::OutputPort<StampedPose>("target")});
  factory_.registerSimpleAction(
      "MakePickResult",
      [](BT::TreeNode &node) {
        Json result = {{"target_id", input<std::string>(node, "target_id")},
                       {"outcome", input<std::string>(node, "outcome")}};
        auto reason = input<std::string>(node, "reason");
        if (!reason.empty())
          result["reason"] = reason;
        validate_value({{"type", "pick_result"}}, result);
        require(bool(node.setOutput("result", PickResult{result})),
                "output_port_invalid");
        return BT::NodeStatus::SUCCESS;
      },
      {BT::InputPort<std::string>("target_id"),
       BT::InputPort<std::string>("outcome"),
       BT::InputPort<std::string>("reason", std::string(""),
                                  "Optional business reason"),
       BT::OutputPort<PickResult>("result")});
}
void Executor::load_xml(const std::string &xml, const Json &initial) {
  auto blackboard = BT::Blackboard::create();
  for (auto item = initial.begin(); item != initial.end(); ++item) {
    const auto type = item.value().at("type").get<std::string>();
    const auto &value = item.value().at("value");
    if (type == "integer" || type == "number" || type == "string" ||
        type == "boolean")
      validate_value({{"type", type}}, value);
    if (type == "string")
      blackboard->set(item.key(), value.get<std::string>());
    else if (type == "boolean")
      blackboard->set(item.key(), value.get<bool>());
    else if (type == "number")
      blackboard->set(item.key(),
                      Quantity{value.get<double>(), item.value().at("unit")});
    else if (type == "integer")
      blackboard->set(item.key(), IntegerQuantity{value.get<int64_t>(),
                                                  item.value().at("unit")});
    else if (type == "stamped_pose") {
      pose_shape(value);
      blackboard->set(item.key(), StampedPose{value});
    } else if (type == "target_list") {
      require(value.is_array(), "invalid_target_list");
      TargetList targets;
      for (const auto &p : value) {
        pose_shape(p);
        targets.targets.push_back({p});
      }
      blackboard->set(item.key(), targets);
    } else if (type == "pick_result") {
      validate_value({{"type", "pick_result"}}, value);
      blackboard->set(item.key(), PickResult{value});
    } else
      throw std::runtime_error("unsupported_blackboard_type");
  }
  tree_ =
      std::make_unique<BT::Tree>(factory_.createTreeFromText(xml, blackboard));
  std::set<const void *> producers;
  for (const auto &subtree : tree_->subtrees)
    for (const auto &node : subtree->nodes)
      for (const auto &mapping :
           static_cast<const BT::TreeNode &>(*node).config().output_ports) {
        if (BT::TreeNode::isBlackboardPointer(mapping.second)) {
          auto entry =
              static_cast<const BT::TreeNode &>(*node)
                  .config()
                  .blackboard->getEntry(std::string(
                      BT::TreeNode::stripBlackboardPointer(mapping.second)));
          if (entry)
            producers.insert(entry.get());
        }
      }
  for (const auto &subtree : tree_->subtrees)
    for (const auto &node : subtree->nodes)
      for (const auto &mapping :
           static_cast<const BT::TreeNode &>(*node).config().input_ports) {
        if (BT::TreeNode::isBlackboardPointer(mapping.second)) {
          auto bb =
              static_cast<const BT::TreeNode &>(*node).config().blackboard;
          auto key =
              std::string(BT::TreeNode::stripBlackboardPointer(mapping.second));
          auto entry = bb->getEntry(key);
          auto value = bb->getAnyLocked(key);
          require(entry && ((value && !value->empty()) ||
                            producers.count(entry.get())),
                  "unbound_input:" + key);
        }
      }
  subscriptions_.clear();
  for (const auto &subtree : tree_->subtrees)
    for (const auto &node : subtree->nodes) {
      auto ptr = node.get();
      subscriptions_.push_back(ptr->subscribeToStatusChange(
          [this, ptr](BT::TimePoint, const BT::TreeNode &, BT::NodeStatus previous, BT::NodeStatus current) {
            events_.push_back({{"sequence", ++event_sequence_}, {"editor_id", ptr->name()},
              {"path", ptr->fullPath()}, {"uid", ptr->UID()},
              {"previous", BT::toStr(previous)}, {"state", BT::toStr(current)}});
            if (events_.size() > 512) events_.erase(events_.begin());
          }));
    }
  std::set<std::string> ids;
  std::map<const void *, Json> specs;
  for (const auto &subtree : tree_->subtrees)
    for (const auto &node : subtree->nodes)
      if (auto *capability = dynamic_cast<Capability *>(node.get())) {
        require(ids.insert(capability->node_id()).second,
                "duplicate_node_id:" + capability->node_id());
        for (const auto &kind : {"input", "output", "parameters"})
          for (auto item = capability->capability().at(kind).begin();
               item != capability->capability().at(kind).end(); ++item) {
            auto key =
                std::string(kind) == "parameters"
                    ? "param_" + item.key()
                    : (std::string(kind) == "output" ? "out_" + item.key()
                                                     : item.key());
            const auto &ports = std::string(kind) == "output"
                                    ? static_cast<const BT::TreeNode &>(*node)
                                          .config()
                                          .output_ports
                                    : static_cast<const BT::TreeNode &>(*node)
                                          .config()
                                          .input_ports;
            auto mapped = ports.find(key);
            if (mapped == ports.end() ||
                !BT::TreeNode::isBlackboardPointer(mapped->second))
              continue;
            auto entry =
                static_cast<const BT::TreeNode &>(*node)
                    .config()
                    .blackboard->getEntry(std::string(
                        BT::TreeNode::stripBlackboardPointer(mapped->second)));
            if (!entry)
              continue;
            auto found = specs.find(entry.get());
            if (found != specs.end())
              for (const auto &field :
                   {"type", "unit", "frame_id", "clock_domain"})
                require(found->second.value(field, Json()) ==
                            item.value().value(field, Json()),
                        std::string("port_contract_mismatch:") + field);
            else
              specs.emplace(entry.get(), item.value());
            if (std::string(kind) != "output") {
              bool populated = false;
              {
                auto value = static_cast<const BT::TreeNode &>(*node)
                                 .config()
                                 .blackboard->getAnyLocked(std::string(
                                     BT::TreeNode::stripBlackboardPointer(
                                         mapped->second)));
                populated = value && !value->empty();
              }
              if (populated)
                read_port(*node, key, item.value());
            }
          }
      }
}
BT::NodeStatus Executor::tick() {
  require(bool(tree_), "tree_not_loaded");
  if (broker_->dispatch_stopped()) {
    tree_->haltTree();
    status_ = BT::NodeStatus::FAILURE;
    return status_;
  }
  status_ = tree_->tickExactlyOnce();
  return status_;
}
void Executor::halt() {
  broker_->stop();
  if (tree_)
    tree_->haltTree();
  status_ = BT::NodeStatus::IDLE;
}
Json Executor::report() const {
  Json nodes = Json::array();
  if (tree_)
    for (const auto &subtree : tree_->subtrees)
      for (const auto &node : subtree->nodes)
        {
          Json item = {{"name", node->name()}, {"path", node->fullPath()},
            {"uid", node->UID()}, {"state", BT::toStr(node->status())}};
          if (auto *cap = dynamic_cast<Capability *>(node.get()))
            item["operation_node_id"] = cap->node_id();
          nodes.push_back(item);
        }
  return {{"task_run_id", task_id_},
          {"tree_state", BT::toStr(status_)},
          {"dispatch_stopped", broker_->dispatch_stopped()},
          {"stop_confirmed", broker_->settled()},
          {"nodes", nodes},
          {"event_sequence", event_sequence_}, {"node_events", events_},
          {"operations", broker_->report()}};
}
std::string Executor::models() const {
  return BT::writeTreeNodesModelXML(factory_);
}
} // namespace agro_bt

namespace agro_bt {
Json Executor::describe() const {
  Json nodes = Json::object();
  const std::set<std::string> editable = {"AlwaysSuccess", "AlwaysFailure", "Sequence", "Fallback", "Parallel", "Inverter",
    "RetryUntilSuccessful", "Repeat", "ReactiveSequence", "ReactiveFallback",
    "ForEachTarget", "IsTrue", "HasTarget", "PickSucceeded", "TargetsFromPose",
    "SelectTarget", "MakePickResult", "SubTree"};
  for (const auto &entry : factory_.manifests()) {
    const auto &model = entry.second;
    Json ports = Json::object();
    for (const auto &item : model.ports) {
      const auto &p = item.second;
      std::string type = "unsupported";
      if (p.type() == typeid(std::string)) type = "string";
      else if (p.type() == typeid(bool)) type = "boolean";
      else if (p.type() == typeid(int) || p.type() == typeid(IntegerQuantity)) type = "integer";
      else if (p.type() == typeid(Quantity)) type = "number";
      else if (p.type() == typeid(StampedPose)) type = "stamped_pose";
      else if (p.type() == typeid(TargetList)) type = "target_list";
      else if (p.type() == typeid(PickResult)) type = "pick_result";
      ports[item.first] = {{"direction", BT::toStr(p.direction())}, {"type", type},
        {"required", p.defaultValue().empty()}, {"default_xml", p.defaultValueString()},
        {"quantity", p.type() == typeid(Quantity) || p.type() == typeid(IntegerQuantity)}};
    }
    int minimum = model.type == BT::NodeType::CONTROL || model.type == BT::NodeType::DECORATOR ? 1 : 0;
    int maximum = model.type == BT::NodeType::CONTROL ? -1 : minimum;
    nodes[entry.first] = {{"registration_id", entry.first}, {"category", BT::toStr(model.type)},
      {"minimum_children", minimum}, {"maximum_children", maximum}, {"ports", ports},
      {"editable", editable.count(entry.first) != 0 || entry.first.rfind("Capability_", 0) == 0}};
  }
  return {{"nodes", nodes}};
}
}
