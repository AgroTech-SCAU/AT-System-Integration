/** Labels are presentation-only; registration IDs are never rewritten. */
const names:Record<string,string>={
 'IsTrue':'判断真值',
 'Sequence':'顺序执行', 'Fallback':'失败时尝试备选', 'ReactiveSequence':'响应式顺序',
 'ReactiveFallback':'响应式选择', 'Parallel':'并行执行', 'RetryUntilSuccessful':'失败重试',
 'Repeat':'重复执行', 'Inverter':'结果反转', 'ForceSuccess':'强制成功', 'ForceFailure':'强制失败',
 'SubTree':'调用子树', 'AlwaysSuccess':'始终成功', 'AlwaysFailure':'始终失败',
}
const englishNames:Record<string,string>={IsTrue:'Check true',Sequence:'Sequence',Fallback:'Fallback',ReactiveSequence:'Reactive sequence',ReactiveFallback:'Reactive fallback',Parallel:'Parallel',RetryUntilSuccessful:'Retry on failure',Repeat:'Repeat',Inverter:'Invert result',ForceSuccess:'Force success',ForceFailure:'Force failure',SubTree:'Call subtree',AlwaysSuccess:'Always succeed',AlwaysFailure:'Always fail'}
export function nodeLabel(id:string, language:'zh'|'en'='zh'){
  const encoded=id.startsWith('Capability_')?id.slice('Capability_'.length):id
  const found=Object.keys(names).find(key=>key.replace(/\./g,'_')===encoded)
  if(language==='en')return englishNames[found||id]||encoded.replace(/_/g,' ')
  return found?names[found]:(names[id]||encoded.replace(/_/g,' '))
}
