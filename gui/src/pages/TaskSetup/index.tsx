import { useEffect,useState } from 'react'
import { Panel,Field } from '../../components/Foundation'
import { Parameters,ErrorFields,useOperation,type Json,type PageProps } from '../shared'
export default function TaskSetup({client,language}:PageProps){
 const [template,setTemplate]=useState<Json|null>(null),[assets,setAssets]=useState<Json[]>([]),[plans,setPlans]=useState<Json[]>([]),[parameters,setParameters]=useState<Json>({}),[assetId,setAssetId]=useState(''),[selected,setSelected]=useState(''),[check,setCheck]=useState<Json|null>(null)
 const op=useOperation(language)
 async function load(){const [t,a,p]=await Promise.all([client.request<Json>('/templates'),client.request<Json>('/assets'),client.request<Json>('/plans')]);setTemplate(t.templates[0]);setAssets(a.assets);setPlans(p.plans)}
 useEffect(()=>{void load().catch(op.setError)},[client])
 return <><div className="workspace-grid"><Panel title="任务模板与参数" icon="templates"><h3>{template?.title}</h3><p className="callout">模拟任务 · 候选上限 {template?.manifest.max_targets} · 恢复次数 {template?.manifest.max_recovery_attempts}（只读）</p>
 <Parameters specs={template?.manifest.parameters||{}} value={parameters} onChange={setParameters}/><Field label="绑定标定资产"><select value={assetId} onChange={e=>setAssetId(e.target.value)}><option value="">内置模拟标定</option>{assets.map(a=><option key={a.id} value={a.id}>{a.filename} · {a.sha256.slice(0,12)}</option>)}</select></Field>
 <button disabled={op.busy||!template} className="primary" onClick={()=>void op.run('创建不可变任务方案',async()=>{const next=await client.request<Json>('/plans','POST',{parameters,asset_id:assetId||null});setSelected(next.id);setCheck(null);await load()})}>保存为新任务方案</button>
 <Field label="任务方案"><select value={selected} onChange={e=>{setSelected(e.target.value);setCheck(null)}}><option value="">未选择</option>{plans.map(p=><option key={p.id} value={p.id}>{p.id} · approach_dz {p.parameters.approach_dz}</option>)}</select></Field><button disabled={op.busy||!selected} onClick={()=>void op.run('预检任务与资产',async()=>setCheck(await client.request<Json>(`/plans/${selected}/preflight`)))}>预检方案</button>
 {check&&<><p role="status">{check.valid?'预检通过，尚未启动任务':'预检未通过'}</p><ErrorFields value={check.valid?null:check}/><pre>{JSON.stringify(check,null,2)}</pre></>}
 </Panel><Panel title="标定资产" subtitle="导入不等于完成真实标定" icon="plug"><label className="file-button">导入已有资产<input type="file" accept=".json" aria-label="导入标定资产" disabled={op.busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void op.run('校验资产来源与支持范围',async()=>{if(file.size>1048576)throw Error('文件过大');await client.request('/assets','POST',{filename:file.name,content:await file.text()});await load()})}}/></label><p className="muted">真实手眼标定尚未接入，当前只接受内置模拟证据，无 verified 编辑开关</p>{assets.map(a=><div className="package-row" key={a.id}><div><strong>{a.filename} · 模拟</strong><p>{a.support}</p><pre>{JSON.stringify(a.metadata,null,2)}</pre><code>{a.sha256}</code></div></div>)}</Panel></div>
 <Panel title="行为树结构预览" subtitle="模板拓扑固定，任务方案只保存参数与资产引用"><details><summary>查看模板 XML</summary><pre>{template?.xml}</pre></details><p>自由画布编辑在 P3 开放</p></Panel><ErrorFields value={op.error}/>{op.dialog()}</>
}
