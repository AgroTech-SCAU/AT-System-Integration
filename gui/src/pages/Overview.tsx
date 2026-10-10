import {Panel} from '../components/Foundation'
import {Icon} from '../components/Icon'
import {systemCategories} from '../components/systemCategories'
import type {Observation, Workspace, Language} from '../types'

export default function Overview({observation,navigate,language,robotName}:{observation:Observation;navigate:(target:Workspace)=>void;language:Language;robotName:string}){
  const modules=Object.entries(observation.system.modules||{})
  const connected=modules.filter(([,module])=>module.process&&module.interface)
  const active=observation.tasks.tasks.filter(task=>['ACCEPTED','RUNNING','CANCELING'].includes(task.state))
  const ready=observation.system.state==='READY'
  return <section className="studio-overview">
    <div className="overview-banner"><div><span className="eyebrow">机器人概览</span><h2>{robotName}</h2><p>系统配置、任务与运行状态</p></div><span className={'overview-state '+(ready?'good':'')}>{ready?'系统已就绪':observation.system.state==='STOPPED'?'当前未启动':observation.system.state}</span></div>
    <div className="overview-stats"><div><small>已配置后端</small><strong>{modules.length}</strong></div><div><small>已连接后端</small><strong>{connected.length}</strong></div><div><small>执行中任务</small><strong>{active.length}</strong></div></div>
    <div className="overview-section-title"><div><h3>工作入口</h3><p>系统搭建、任务编排与运行调试</p></div></div>
    <div className="overview-steps"><button onClick={()=>navigate('system')}><span className="overview-step-icon"><Icon name="boxes" size="xl"/></span><strong>添加或配置系统</strong><small>接入驱动、设备和软件服务</small><b>→</b></button><button onClick={()=>navigate('editor')}><span className="overview-step-icon"><Icon name="git-branch" size="xl"/></span><strong>设计机器人任务</strong><small>编辑状态机、行为树与任务参数</small><b>→</b></button><button onClick={()=>navigate('runtime')}><span className="overview-step-icon"><Icon name="play-circle" size="xl"/></span><strong>运行与诊断</strong><small>检查就绪条件、执行任务和诊断故障</small><b>→</b></button></div>
    <div className="overview-section-title"><div><h3>功能系统</h3><p>按功能分类查看已接入后端</p></div><button onClick={()=>navigate('system')}>管理系统 →</button></div>
    <div className="robot-category-grid">{systemCategories.slice(0,4).map(group=>{const entries=modules.filter(([name])=>group.keywords.some(p=>name.toLowerCase().includes(p)));return <button key={group.name} className="robot-category" onClick={()=>navigate('system')}><span className="robot-category-icon"><Icon name={group.icon} size="xl"/></span><strong>{group.name}</strong><small>{entries.length?entries.map(([name])=>name).join(' · '):'暂无后端'}</small><span className="robot-category-number">{entries.length ? `${entries.length} 个后端` : '添加后端'} <span aria-hidden="true">→</span></span></button>})}</div>
    <Panel title="后端状态" subtitle="进程与接口状态" icon="system">
      {modules.length?<div className="studio-overview-modules">{modules.map(([name,module])=><button className="studio-overview-module" key={name} onClick={()=>navigate('system')}><span className="studio-module-icon"><Icon name="boxes" /></span><strong>{name}</strong><small>{module.process&&module.interface?'已连接':module.process?'接口未就绪':'待启动或未连接'}</small><span>查看配置 →</span></button>)}</div>:<div className="studio-empty"><h3>暂无功能后端</h3><p>添加后端以启用设备能力，或直接编排逻辑任务</p><div className="buttons"><button className="primary" onClick={()=>navigate('system')}>添加系统 →</button><button onClick={()=>navigate('editor')}>设计任务 →</button></div></div>}
    </Panel>
  </section>
}
