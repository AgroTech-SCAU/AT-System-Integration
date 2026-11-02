// 系统分类只用于工作台呈现，不限制接入包和能力的实际类型
export const systemCategories = [
  {id:'vision', name:'视觉系统', icon:'eye', caption:'相机、目标识别与环境感知', prefix:['perception.','vision.'], keywords:['vision','camera','perception']},
  {id:'navigation', name:'导航系统', icon:'navigation', caption:'定位、建图与底盘导航', prefix:['navigation.','nav.'], keywords:['navigation','nav','chassis']},
  {id:'arm', name:'机械臂系统', icon:'bot', caption:'机械臂控制、轨迹与坐标变换', prefix:['manipulation.','geometry.'], keywords:['arm','manipulation','robot_arm']},
  {id:'control', name:'电控系统', icon:'cpu', caption:'通信、IO 与末端执行器', prefix:['end_effector.','job.','control.'], keywords:['control','end_effector','mcu','io']},
  {id:'custom', name:'自定义系统', icon:'boxes', caption:'其他设备与软件服务', prefix:[], keywords:[]},
] as const
