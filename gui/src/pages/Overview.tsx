import { Panel } from '../components/Foundation'
import type { Observation, Workspace, Language } from '../types'

const systems = [
  { id:'vision', title:'视觉系统', detail:'目标识别、位姿估计、作业检查', match:['perception', 'vision'] },
  { id:'navigation', title:'导航系统', detail:'定位、到达作业点、底盘运动', match:['navigation', 'nav'] },
  { id:'arm', title:'机械臂系统', detail:'坐标转换、可达性、运动规划', match:['manipulation', 'geometry', 'arm'] },
  { id:'control', title:'电控与末端', detail:'末端夹持、设备 IO、记录反馈', match:['end_effector', 'job', 'control'] },
]
export default function Overview({ observation, navigate, language, robotName }: {observation: Observation, navigate:(target:Workspace)=>void, language:Language, robotName:string}) {
  const ready = observation.system.state === 'READY'
  const modules = Object.entries(observation.system.modules || {})
  const activeTasks = observation.tasks.tasks.filter(task=>['RUNNING','ACCEPTED','CANCELING'].includes(task.state))
  const isEnglish = language === 'en'
  return <>
    <div className="overview-banner"><div><span className="eyebrow">ROBOT WORKSPACE</span><h2>{robotName || (isEnglish?'Current robot':'当前机器人')}</h2><p>{isEnglish?'View backend status and manage robot tasks.':'查看当前系统的模块、任务和运行状态'}</p></div><span className={'overview-state '+(ready?'good':'')}>{ready?'● READY':`● ${observation.system.state}`}</span></div>
    <div className="overview-stats"><div><small>{isEnglish?'Backend modules':'已配置后端'}</small><strong>{modules.length}</strong></div><div><small>{isEnglish?'Ready modules':'已就绪后端'}</small><strong>{modules.filter(([,m])=>m.process&&m.interface).length}</strong></div><div><small>{isEnglish?'Active tasks':'正在执行'}</small><strong>{activeTasks.length}</strong></div></div>
    <div className="overview-section-title"><div><h3>{isEnglish?'Robot systems':'系统组成'}</h3><p>{isEnglish?'Configure vision, navigation, arm and controller backends.':'配置视觉、导航、机械臂和电控后端'}</p></div><button onClick={()=>navigate('system')}>{isEnglish?'Configure systems':'配置机器人 →'}</button></div>
    <div className="robot-system-grid">{systems.map(system=> <button key={system.id} className="robot-system-card" onClick={()=>navigate('system')}><span className="robot-system-symbol">{system.id==='vision'?'◉':system.id==='navigation'?'◇':system.id==='arm'?'⌁':'▤'}</span><strong>{system.title}</strong><p>{system.detail}</p><small>配置后端与能力 <span>→</span></small></button>)}</div>
    <div className="overview-section-title"><div><h3>{isEnglish?'Your workflow':'常用操作'}</h3><p>{isEnglish?'Choose a workspace to continue.':'选择需要的功能'}</p></div></div>
    <div className="overview-steps">
      <button onClick={()=>navigate('system')}><span>01</span><strong>搭建机器人</strong><small>选择视觉、导航、机械臂、电控后端</small><b>→</b></button>
      <button onClick={()=>navigate('editor')}><span>02</span><strong>编排机器人任务</strong><small>设置模板参数，编辑行为树，检查绑定</small><b>→</b></button>
      <button onClick={()=>navigate('runtime')}><span>03</span><strong>模拟运行与调试</strong><small>启动模拟模块，观察执行，取消和停止</small><b>→</b></button>
    </div>
    <Panel title="当前模块状态" subtitle="各后端的运行状态" icon="runtime"><div className="overview-modules">{modules.length?modules.map(([name, status])=><div key={name}><strong>{name}</strong><span className={status.process&&status.interface?'state-ready':'state-idle'}>{status.process&&status.interface?'● 已就绪':`○ ${status.state||'未运行'}`}</span></div>):<p className="muted">暂无后端模块</p>}</div></Panel>
  </>
}
