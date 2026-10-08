/** Labels are presentation-only; registration IDs are never rewritten. */
const names:Record<string,string>={
 'navigation.move_to_waypoint':'导航到作业点',
 'perception.detect_tomato':'检测番茄',
 'perception.detect_targets':'检测候选目标',
 'perception.verify_pick':'验证夹持结果',
 'perception.verify_place':'验证放置结果',
 'geometry.transform_pose':'变换目标坐标',
 'geometry.offset_pose':'添加接近偏移',
 'manipulation.move_to_pose':'移动机械臂',
 'manipulation.check_reachability':'检查可达性',
 'manipulation.collection_pose':'移动至收集位',
 'end_effector.grip':'控制末端夹爪',
 'job.record_pick':'记录采摘结果',
 'Sequence':'顺序执行', 'Fallback':'失败时尝试备选', 'ReactiveSequence':'响应式顺序',
 'ReactiveFallback':'响应式选择', 'Parallel':'并行执行', 'RetryUntilSuccessful':'失败重试',
 'Repeat':'重复执行', 'Inverter':'结果反转', 'ForceSuccess':'强制成功', 'ForceFailure':'强制失败',
 'SubTree':'调用子树', 'AlwaysSuccess':'始终成功', 'AlwaysFailure':'始终失败',
}
export function nodeLabel(id:string, language:'zh'|'en'='zh'){
  const encoded=id.startsWith('Capability_')?id.slice('Capability_'.length):id
  const found=Object.keys(names).find(key=>key.replace(/\./g,'_')===encoded)
  if(language==='en')return found||encoded
  return found?names[found]:(names[id]||encoded.replace(/_/g,' '))
}
export function nodeGroup(id:string){
 if(id.startsWith('Capability_perception'))return '视觉'
 if(id.startsWith('Capability_navigation'))return '导航'
 if(id.startsWith('Capability_manipulation')||id.startsWith('Capability_geometry'))return '机械臂'
 if(id.startsWith('Capability_end_effector')||id.startsWith('Capability_job'))return '电控'
 return '流程控制'
}
