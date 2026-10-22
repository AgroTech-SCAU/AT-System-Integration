import {Panel} from '../components/Foundation'
import {Icon} from '../components/Icon'
import type {Observation, Workspace, Language} from '../types'

export default function Overview({observation,navigate,robotName,configured=true}:{observation:Observation;navigate:(target:Workspace)=>void;language:Language;robotName:string;configured?:boolean}){
  const modules=Object.entries(configured?observation.system.modules||{}:{})
  const connected=modules.filter(([,module])=>module.process&&module.interface)
  const active=observation.tasks.tasks.filter(task=>['ACCEPTED','RUNNING','CANCELING'].includes(task.state))
  const ready=configured&&observation.system.state==='READY'
  return <section className="studio-overview">
    <div className="overview-banner"><div><h2>{robotName}</h2><p>{active.length?'任务正在执行，可进入运行台查看进度':ready?'设备已就绪，选择任务即可开始运行':'从连接接口到运行任务，在这里继续你的工作'}</p></div><button className="primary" onClick={()=>navigate(active.length||ready?'runtime':'editor')}>{active.length?'查看当前运行':ready?'选择任务运行':'继续编排任务'} →</button></div>
    <div className="overview-stats"><div><small>设备与服务</small><strong>{modules.length}</strong></div><div><small>接口已连接</small><strong>{connected.length} / {modules.length}</strong></div><div><small>正在执行</small><strong>{active.length}</strong></div></div>
    <div className="overview-steps"><button onClick={()=>navigate('system')}><span><Icon name="boxes" size="xl"/></span><strong>连接机器人</strong><small>选择 ROS 接口，或添加设备驱动</small><b>→</b></button><button onClick={()=>navigate('editor')}><span><Icon name="git-branch" size="xl"/></span><strong>编排任务流程</strong><small>组织状态、行为树与任务输入输出</small><b>→</b></button><button onClick={()=>navigate('runtime')}><span><Icon name="play-circle" size="xl"/></span><strong>运行与观察</strong><small>启动流程、发送事件、查看执行进度</small><b>→</b></button></div>
    <Panel title="设备连接" subtitle="查看实际接入的设备与服务" icon="system">
      {modules.length?<div className="studio-overview-modules">{modules.map(([name,module])=><button className="studio-overview-module" key={name} onClick={()=>navigate('system')}><span className="studio-module-icon"><Icon name="boxes" /></span><strong>{name}</strong><small>{module.process&&module.interface?'已连接':module.process?'进程已启动，接口尚未就绪':'尚未启动'}</small><span>配置设备 →</span></button>)}</div>:<div className="studio-empty"><h3>还没有接入设备驱动</h3><p>已有 ROS 话题、服务或 Action 时，可以直接在能力库中接入</p><button onClick={()=>navigate('system')}>选择接入方式 →</button></div>}
    </Panel>
    <button onClick={()=>navigate('records')}>查看历史运行与故障记录 →</button>
  </section>
}
