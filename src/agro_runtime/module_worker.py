"""Launch ROS modules in their own workspace environment, never in the Studio interpreter."""
import json
import sys
from pathlib import Path


def resolve(value):
    if isinstance(value, list): return [resolve(v) for v in value]
    if not isinstance(value, dict): return value
    if '$package' in value:
        from ament_index_python.packages import get_package_share_directory
        return str(Path(get_package_share_directory(value['$package'])) / value.get('path', ''))
    if '$file' in value:
        return Path(resolve(value['$file'])).read_text()
    if '$yaml' in value:
        import yaml
        return yaml.safe_load(Path(resolve(value['$yaml'])).read_text())
    if '$xacro' in value:
        import xacro
        return xacro.process_file(resolve(value['$xacro']), mappings={k:str(resolve(v)) for k,v in value.get('mappings',{}).items()}).toxml()
    if '$moveit' in value:
        from moveit_configs_utils import MoveItConfigsBuilder
        config=value['$moveit']
        return MoveItConfigsBuilder(config['robot'],package_name=config['package']).to_moveit_configs().to_dict()
    if '$merge' in value:
        result={}
        for item in value['$merge']:result.update(resolve(item))
        return result
    return {k:resolve(v) for k,v in value.items()}


def parameter_values(value):
    from launch_ros.parameter_descriptions import ParameterValue
    if isinstance(value,dict):return {k:parameter_values(v) for k,v in value.items()}
    if isinstance(value,str):return ParameterValue(value,value_type=str)
    return value


def description(module, outcome=None):
    from launch import LaunchDescription
    from launch.actions import ExecuteProcess, IncludeLaunchDescription
    from launch.launch_description_sources import AnyLaunchDescriptionSource
    from launch_ros.actions import Node, ComposableNodeContainer
    from launch_ros.descriptions import ComposableNode
    from ament_index_python.packages import get_package_share_directory
    kind = module['kind']
    if kind == 'process':
        action = ExecuteProcess(cmd=module['argv'], output='screen')
    elif kind == 'launch':
        path = Path(get_package_share_directory(module['package'])) / 'launch' / module['executable']
        action = IncludeLaunchDescription(AnyLaunchDescriptionSource(str(path)), launch_arguments={k:str(resolve(v)) for k,v in module.get('launch_arguments',{}).items()}.items())
    else:
        parameters = [resolve(v) for v in module.get('parameter_files', [])]
        parameters += [parameter_values(resolve(module.get('parameters', {})))]
        common = dict(package=module['package'], name=module.get('node_name') or module['id'],
                      namespace=module.get('namespace', ''), parameters=parameters,
                      remappings=[tuple(v) for v in module.get('remappings', [])])
        if kind == 'component':
            component = ComposableNode(plugin=module['plugin'], **common)
            action = ComposableNodeContainer(name=module['id']+'_container', namespace='', package='rclcpp_components', executable='component_container_mt', composable_node_descriptions=[component], output='screen')
        else:
            prefix = None
            from ament_index_python.packages import get_package_prefix
            executable=Path(get_package_prefix(module['package']))/'lib'/module['package']/module['executable']
            if module.get('python') and executable.is_file():
                with executable.open('rb') as stream:first=stream.readline(256)
                if first.startswith(b'#!') and b'python' in first:prefix=[module['python']]
            action = Node(executable=module['executable'], prefix=prefix, arguments=module.get('arguments', []), output='screen', **common)
    # A module owns one action and its children, exiting it stops this launch service
    from launch.actions import RegisterEventHandler, EmitEvent
    from launch.event_handlers import OnProcessExit
    from launch.events import Shutdown
    def exited(event, context):
        if outcome is not None:outcome['returncode']=event.returncode
        return [EmitEvent(event=Shutdown(reason='module exited'))]
    events = [] if kind == 'launch' else [RegisterEventHandler(OnProcessExit(target_action=action,on_exit=exited))]
    return LaunchDescription([*events, action])


def inspect(module):
    from ament_index_python.packages import get_package_prefix, get_package_share_directory
    kind = module['kind']
    if kind == 'process':
        import shutil
        if not module['argv'] or not shutil.which(module['argv'][0]): raise ValueError('找不到启动程序')
    elif kind == 'node':
        path = Path(get_package_prefix(module['package'])) / 'lib' / module['package'] / module['executable']
        if not path.is_file(): raise ValueError('找不到已构建的节点：' + str(path))
    elif kind == 'launch':
        path = Path(get_package_share_directory(module['package'])) / 'launch' / module['executable']
        if not path.is_file(): raise ValueError('找不到 launch 文件：' + str(path))
    elif kind == 'component':
        from ament_index_python.resources import get_resource
        content, _ = get_resource('rclcpp_components',module['package'])
        if module['plugin'] not in [line.split(';')[0] for line in content.splitlines()]:
            raise ValueError('组件尚未安装：'+module['plugin'])
    for path in module.get('parameter_files', []):
        if not Path(resolve(path)).is_file(): raise ValueError('参数文件不存在：'+str(path))
    from launch import LaunchContext
    from launch_ros.utilities import normalize_parameters, evaluate_parameters
    evaluate_parameters(LaunchContext(),normalize_parameters([parameter_values(resolve(module.get('parameters',{})))]))
    return {'ready': True}


if __name__ == '__main__':
    module = json.loads(Path(sys.argv[1]).read_text())
    from launch import LaunchService
    service = LaunchService()
    outcome={}
    service.include_launch_description(description(module,outcome))
    status=service.run()
    sys.exit(outcome.get('returncode',status))
