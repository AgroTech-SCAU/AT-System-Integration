"""实际节点注册驱动的 XML、类型流、子树与持久发布服务"""
import copy
import hashlib
import json
import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from uuid import uuid4
from .configuration import encoded,identifier
from .errors import ContractValidationError,fail,parse
from .models import TypeDescriptor,StampedPose,PickResult,scalar_error
from .tree_models import TreeDocument,LayoutDocument


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def new_id():
    return 'node_'+uuid4().hex


def compatible(source,target):
    return all(target.get(k) is None or source.get(k)==target[k] for k in ('type','unit','frame_id','clock_domain'))


def binding(value,spec):
    if re.fullmatch(r'\{[a-z][a-z0-9_]*\}',value):
        return {'kind':'blackboard_reference','key':value[1:-1],'type':{},'value':None}
    kind=spec.get('type','string')
    if kind=='string':
        decoded=value
    else:
        try:
            decoded=json.loads(value.removeprefix('json:'))
        except ValueError:
            decoded=value
    unit=spec.get('unit')
    if isinstance(decoded,dict) and kind in {'number','integer'} and set(decoded)=={'value','unit'}:
        unit=decoded['unit'];decoded=decoded['value']
    return {'kind':'typed_literal','value':decoded,'key':None,'type':{'type':kind,**({'unit':unit} if unit else {})}}


def literal(port,spec):
    if port['kind']=='blackboard_reference':
        return '{'+str(port['key'])+'}'
    value=port.get('value')
    if spec.get('quantity'):
        return 'json:'+encoded({'value':value,'unit':port.get('type',{}).get('unit',spec.get('unit','1'))})
    return value if isinstance(value,str) else ('json:' if isinstance(value,(dict,list)) else '')+encoded(value)


class TaskDocuments:
    def __init__(self,context,store,assets):
        self.context=context;self.store=store;self.assets=assets;self._models=None;self._model_key=None

    def engine(self,xml=None,blackboard=None,describe=False):
        executable=self.context.tasks.executable
        if not executable or not Path(executable).is_file() or not os.access(executable,os.X_OK):
            fail('$.task_engine','task_engine_unavailable','需要可执行的实际行为树引擎')
        with tempfile.TemporaryDirectory(prefix='agro-tree-') as directory:
            root=Path(directory);(root/'registry.json').write_text(encoded(self.context.snapshot()))
            args=[executable,'--registry',str(root/'registry.json')]
            if describe:
                args+=['--describe-nodes']
            else:
                (root/'tree.xml').write_text(xml);(root/'blackboard.json').write_text(encoded(blackboard or {}))
                args+=['--validate-only','--instance-ids','--xml',str(root/'tree.xml'),'--blackboard',str(root/'blackboard.json')]
            try:
                result=subprocess.run(args,capture_output=True,timeout=5)
            except (OSError,subprocess.TimeoutExpired):
                fail('$.task_engine','tree_validation_timeout','执行器描述或静态校验未在期限内完成')
            if result.returncode:
                fail('$.tree','engine_validation_failed',result.stdout.decode(errors='replace')[:2000])
            try:
                return json.loads(result.stdout)
            except ValueError:
                fail('$.task_engine','invalid_node_models','执行器未返回节点描述，请重新安装')

    def describe_nodes(self):
        executable=self.context.tasks.executable
        if not executable or not Path(executable).is_file():
            fail('$.task_engine','task_engine_unavailable','实际执行器不可用，请重新安装')
        key=(self.context.snapshot_id,hashlib.sha256(Path(executable).read_bytes()).hexdigest())
        if self._model_key==key:return copy.deepcopy(self._models)
        models=self.engine(describe=True)
        nodes=models['nodes']
        for model in nodes.values():
            for spec in model['ports'].values():spec['direction']=spec['direction'].upper()
        for name,model in nodes.items():
            if name.startswith('Capability_'):
                cap_id=None;cap=None
                for (_,cid),candidate in self.context.bound.capabilities.items():
                    if name=='Capability_'+cid.replace('.','_'):
                        cap_id=cid;cap=candidate;break
                if cap is None:continue
                model['capability_id']=cap_id
                model['resources']=[r.model_dump(mode='json') for r in cap.resources]
                model['backends']=[b for b,c in self.context.bound.capabilities if c==cap_id]
                model['roles']=[r for r,c in self.context.bound.roles.items() if c.capability.capability_id==cap_id]
                model['description']=cap.description
                for kind,ports in [('input',cap.input),('output',cap.output),('parameters',cap.parameters)]:
                    for port,spec in ports.items():
                        key_port=('out_' if kind=='output' else 'param_' if kind=='parameters' else '')+port
                        model['ports'][key_port].update(spec.model_dump(mode='json',exclude_none=True))
                        model['ports'][key_port]['required']=kind=='input' or kind=='parameters' and spec.required and 'default' not in spec.model_fields_set
                model['ports']['node_id']['required']=False
                model['ports']['role']['required']=False;model['ports']['backend_instance']['required']=False
            for spec in model['ports'].values():
                if spec['type'] in {'number','integer'}:spec.setdefault('unit','1')
        models['digest']=digest(nodes);models['system_snapshot_id']=self.context.snapshot_id
        self._models=copy.deepcopy(models);self._model_key=key
        return models

    def parse_xml(self,xml):
        if not isinstance(xml,str) or len(xml.encode())>1048576:
            fail('$.xml','invalid_xml_size','XML 最多 1 MiB')
        if re.search(r'<!DOCTYPE|<!ENTITY',xml,re.I):
            fail('$.xml','external_entity_forbidden','不允许实体或外部文档包含')
        try:root=ET.fromstring(xml)
        except ET.ParseError as exc:fail('$.xml','invalid_xml',str(exc))
        models=self.describe_nodes();unsupported=[];trees={};ids=set()
        if root.tag!='root' or set(root.attrib)-{'BTCPP_format','main_tree_to_execute'}:unsupported.append('unsupported_root')
        if root.get('BTCPP_format','4')!='4':unsupported.append('unsupported_format')
        for child in root:
            if child.tag not in {'BehaviorTree','TreeNodesModel'}:unsupported.append('unsupported_tag:'+child.tag)
        definitions=list(root.findall('BehaviorTree'))
        if len(definitions)>32 or sum(1 for _ in root.iter())>1200:fail('$.xml','tree_too_large','最多 32 棵树及 1000 个节点')
        declared={};declared_inputs={}
        for model in root.findall('TreeNodesModel'):
            for subtree in model:
                if subtree.tag!='SubTree' or set(subtree.attrib)!={'ID'}:unsupported.append('unsupported_model');continue
                ports={}
                for item in subtree:
                    if item.tag not in {'input_port','output_port'} or set(item.attrib)-{'name','type','default'}:unsupported.append('unsupported_subtree_port');continue
                    if 'default' in item.attrib:unsupported.append('unsupported_subtree_default')
                    contract={'type':item.get('type','string')}
                    if item.text and item.text.strip().startswith('{'):
                        try:
                            metadata=json.loads(item.text)
                            if not isinstance(metadata,dict):raise ValueError('描述必须为对象')
                            if 'agro_contract' in metadata:
                                candidate=metadata['agro_contract']
                                if isinstance(candidate,dict) and isinstance(candidate.get('type'),str):contract={k:v for k,v in candidate.items() if k in TypeDescriptor.model_fields}
                                else:unsupported.append('unsupported_port_contract')
                            if 'task_input' in metadata:declared_inputs.setdefault(subtree.get('ID'),{})[item.get('name')]=metadata['task_input']
                        except (ValueError,TypeError):unsupported.append('unsupported_port_description')
                    if item.get('name','') in ports:fail('$.ports','duplicate_port','子树声明端口重复')
                    ports[item.get('name','')]={'direction':'INPUT' if item.tag=='input_port' else 'OUTPUT','type':contract}
                declared[subtree.get('ID')]=ports
        for tree in definitions:
            tree_id=tree.get('ID','')
            if tree_id in trees:fail('$.trees','duplicate_tree_id','树标识重复')
            if len(tree)!=1:fail('$.trees','invalid_tree_root','每个定义必须恰有一个根节点')
            if set(tree.attrib)!={'ID'}:unsupported.append('unsupported_tree_attribute')
            nodes={}
            def read(element,depth=0):
                if depth>64:fail('$.tree','tree_too_deep','树深度超过 64')
                registration=element.tag
                attrs=dict(element.attrib)
                if registration in {'Action','Condition','Control','Decorator'}:registration=attrs.pop('ID','')
                model=models['nodes'].get(registration)
                if not model or not model['editable']:unsupported.append('unsupported_node:'+registration)
                identity=new_id();attributes={};ports={}
                for key,value in attrs.items():
                    if key=='name':continue
                    if key=='node_id':
                        if value in ids:fail('$.node_id','duplicate_node_id','能力节点标识重复')
                        ids.add(value);attributes[key]=value;continue
                    if key in {'role','backend_instance'} or registration=='SubTree' and key in {'ID','_autoremap'}:
                        attributes[key]=value;continue
                    spec=(model or {}).get('ports',{}).get(key)
                    if registration=='SubTree':spec=declared.get(attrs.get('ID'),{}).get(key,{}).get('type',{'type':'string'})
                    if not spec:unsupported.append('unsupported_attribute:'+registration+'.'+key);continue
                    if (spec.get('type')=='string' or value.startswith('{@')) and re.fullmatch(r'\{[^{}]+\}',value) and not re.fullmatch(r'\{[a-z][a-z0-9_]*\}',value):unsupported.append('unsupported_global_reference')
                    ports[key]=binding(value,spec)
                nodes[identity]={'editor_id':identity,'registration_id':registration,'children':[], 'ports':ports,'attributes':attributes}
                nodes[identity]['children']=[read(child,depth+1) for child in element]
                return identity
            root_id=read(tree[0]);trees[tree_id]={'tree_id':tree_id,'root_id':root_id,'nodes':nodes,'ports':declared.get(tree_id,{})}
        if not trees:fail('$.trees','missing_tree','没有可编辑的树定义')
        document={'main_tree_id':root.get('main_tree_to_execute',next(iter(trees))),'trees':trees,'revision':1,'model_digest':models['digest'], 'readonly':bool(unsupported),'original_xml':xml if unsupported else None,'unsupported':unsupported}
        for tree in trees.values():
            for key,contract in tree['ports'].items():
                for node in tree['nodes'].values():
                    for name,value in node['ports'].items():
                        spec=models['nodes'].get(node['registration_id'],{}).get('ports',{}).get(name,{})
                        if value['kind']=='blackboard_reference' and value['key']==key and spec.get('type')==contract['type'].get('type'):
                            contract['type'].update({k:spec[k] for k in ('unit','frame_id','clock_domain','max_age_s') if spec.get(k) is not None})
        document['inputs']=declared_inputs.get(document['main_tree_id'],{})
        # 固定模板的已知边界可转换为显式端口，其余自动映射保留只读
        if not unsupported:
            for tree in trees.values():
                for node in tree['nodes'].values():
                    if node['registration_id']=='SubTree' and node['attributes'].get('_autoremap')=='true':
                        target=trees.get(node['attributes'].get('ID'))
                        if target:
                            boundary=self.boundary(document,target['tree_id'],target['root_id'])
                            if node['ports']:
                                unsupported.append('unsupported_mixed_autoremap');continue
                            outputs=any(self.port_specs(n,document,models).get(k,{}).get('direction')=='OUTPUT' for n in target['nodes'].values() for k in n['ports'])
                            if outputs and xml.strip()!=self.assets.template.read_text().strip():
                                unsupported.append('unsupported_output_autoremap');continue
                            target['ports']=boundary
                            node['ports']={key:{'kind':'blackboard_reference','key':key,'type':{},'value':None} for key in boundary}
                            node['attributes'].pop('_autoremap',None)
        if unsupported:document.update(readonly=True,original_xml=xml,unsupported=unsupported)
        return parse(TreeDocument,document).model_dump(mode='json')

    def port_specs(self,node,document,models):
        if node['registration_id']=='SubTree':
            tree=document['trees'].get(node['attributes'].get('ID'))
            return {k:{**v['type'],'direction':v['direction'],'required':True} for k,v in (tree or {}).get('ports',{}).items()}
        return models['nodes'].get(node['registration_id'],{}).get('ports',{})

    def serialize_xml(self,document):
        document=parse(TreeDocument,document).model_dump(mode='json')
        if document['readonly']:fail('$.xml','readonly_xml','存在未支持内容，保留原 XML 并禁止有损导出')
        models=self.describe_nodes();root=ET.Element('root',BTCPP_format='4',main_tree_to_execute=document['main_tree_id']);mapping={}
        for tree_id,tree in document['trees'].items():
            element=ET.SubElement(root,'BehaviorTree',ID=tree_id)
            def write(identity,parent,seen):
                if identity in seen or identity not in tree['nodes']:fail('$.children','invalid_control_tree','节点缺失或控制环')
                node=tree['nodes'][identity];attrs={k:v for k,v in node['attributes'].items() if k!='node_id'}
                attrs['name']=identity
                if node['registration_id'].startswith('Capability_'):attrs['node_id']=identity
                specs=self.port_specs(node,document,models)
                attrs.update({k:literal(v,specs.get(k,{})) for k,v in node['ports'].items()})
                child=ET.SubElement(parent,node['registration_id'],attrs);mapping[identity]={'tree_id':tree_id,'editor_id':identity}
                for next_id in node['children']:write(next_id,child,seen|{identity})
            write(tree['root_id'],element,set())
        subtree_models=ET.SubElement(root,'TreeNodesModel')
        for tree_id,tree in document['trees'].items():
            ports=copy.deepcopy(tree['ports'])
            if tree_id==document['main_tree_id']:
                ports.update({k:{'direction':'INPUT','type':v} for k,v in document['inputs'].items()})
            if not ports:continue
            model=ET.SubElement(subtree_models,'SubTree',ID=tree_id)
            for name,port in ports.items():
                element=ET.SubElement(model,'input_port' if port['direction']=='INPUT' else 'output_port',name=name,type=port['type'].get('type','string'))
                metadata={'agro_contract':port['type']}
                if tree_id==document['main_tree_id'] and name in document['inputs']:metadata['task_input']=document['inputs'][name]
                element.text=encoded(metadata)
        return {'xml':ET.tostring(root,encoding='unicode'),'mapping':mapping}

    def boundary(self,document,tree_id,root_id):
        models=self.describe_nodes();tree=document['trees'][tree_id];read={};written={}
        def visit(identity,known):
            node=tree['nodes'][identity];registration=node['registration_id'];specs=self.port_specs(node,document,models);known=set(known)
            for name,value in node['ports'].items():
                if value['kind']!='blackboard_reference':continue
                spec=specs.get(name,{})
                typ={k:spec[k] for k in ('type','unit','frame_id','clock_domain','max_age_s') if spec.get(k) is not None}
                if spec.get('direction')!='OUTPUT' and value['key'] not in known:read.setdefault(value['key'],typ)
            for name,value in node['ports'].items():
                spec=specs.get(name,{})
                if value['kind']=='blackboard_reference' and spec.get('direction')=='OUTPUT':
                    written[value['key']]={k:spec[k] for k in ('type','unit','frame_id','clock_domain','max_age_s') if spec.get(k) is not None}
                    known.add(value['key'])
            if registration in {'Fallback','ReactiveFallback'}:
                branches=[visit(child,known) for child in node['children']]
                return set.intersection(*branches) if branches else known
            if registration=='Inverter':
                for child in node['children']:visit(child,known)
                return known
            for child in node['children']:known=visit(child,known)
            return known
        visit(root_id,set())
        # 保守分析跨分支中先于生产节点读取的输入
        outputs=set(written)
        inputs=read
        all_nodes=tree['nodes'];inside=set()
        def collect(identity):inside.add(identity);[collect(c) for c in all_nodes[identity]['children']]
        collect(root_id)
        outside_refs={v['key'] for n in all_nodes.values() if n['editor_id'] not in inside for v in n['ports'].values() if v['kind']=='blackboard_reference'}
        return {**{k:{'direction':'INPUT','type':v} for k,v in inputs.items()},**{k:{'direction':'OUTPUT','type':written[k]} for k in outputs&outside_refs}}

    def expanded(self,document):
        trees=document['trees'];count=0
        def visit(tree_id,identity,aliases,scope,stack,depth=0):
            if depth>128:fail('$.tree','expanded_tree_too_deep','展开后的控制与调用总深度超过 128')
            nonlocal count
            count+=1
            if count>2000:fail('$.tree','expanded_tree_too_large','展开后的实例超过 2000')
            node=copy.deepcopy(trees[tree_id]['nodes'][identity])
            for value in node['ports'].values():
                if value['kind']=='blackboard_reference':
                    key=value['key']
                    if key in aliases:value.update(copy.deepcopy(aliases[key]))
                    elif scope:value['key']=scope+'_'+key
            node['instance_path']=scope+'/'+identity if scope else identity
            node['tree_id']=tree_id
            if node['registration_id']=='SubTree':
                target=node['attributes'].get('ID')
                if target not in trees or target in stack:fail('$.subtree','recursive_subtree','子树不存在或递归')
                return visit(target,trees[target]['root_id'],node['ports'],scope+'/'+identity if scope else identity,stack+[target],depth+1)
            node['expanded_children']=[visit(tree_id,c,aliases,scope,stack,depth+1) for c in node['children']]
            return node
        main=document['main_tree_id']
        return visit(main,trees[main]['root_id'],{},'', [main])

    def canonical(self,document):
        variables={};stages=[]
        def visit(node):
            ports={}
            for name,value in sorted(node['ports'].items()):
                if value['kind']=='blackboard_reference':
                    key=value['key']
                    if key not in variables:variables[key]='variable_'+str(len(variables))
                    ports[name]=['reference',variables[key]]
                else:ports[name]=['literal',value.get('value'),value.get('type',{}).get('unit')]
            attrs={k:v for k,v in node['attributes'].items() if k in {'role','backend_instance'}}
            if node['registration_id'].startswith('Capability_'):
                stages.append(node)
            return [node['registration_id'],attrs,ports,[visit(c) for c in node['expanded_children']]]
        return visit(self.expanded(document)),stages

    def validate_tree(self,document,policy='simulation_inspection',parameters=None,engine=True):
        diagnostics=[];sources=[];models=self.describe_nodes();parameters=parameters or {}
        def error(code,reason,tree=None,node=None,port=None):
            diagnostics.append({'severity':'error','code':code,'reason':reason,'tree_id':tree,'editor_id':node,'port':port})
        try:document=parse(TreeDocument,document).model_dump(mode='json')
        except ContractValidationError as exc:
            for issue in exc.issues:error(issue.code,issue.reason,port=issue.path)
            return {'valid':False,'diagnostics':diagnostics,'sources':[]}
        if document['readonly']:error('readonly_xml','保留未支持的原始 XML，不允许发布')
        if document['model_digest']!=models['digest']:error('node_model_changed','实际系统节点契约已改变，请重新加载并核对')
        trees=document['trees']
        if document['main_tree_id'] not in trees:error('unknown_main_tree','执行根树不存在')
        if len(trees)>32 or sum(len(t['nodes']) for t in trees.values())>1000:error('tree_too_large','文档超过树或节点数量上限')
        all_ids=set()
        for tree_id,tree in trees.items():
            if tree_id!=tree['tree_id']:error('tree_id_mismatch','定义标识与索引不一致',tree_id)
            parents={};active=set();visited=set()
            def structure(identity,depth=0):
                if depth>64:error('tree_too_deep','控制树深度超过 64',tree_id,identity);return
                if identity in active:error('control_cycle','控制关系包含环',tree_id,identity);return
                node=tree['nodes'].get(identity)
                if not node:error('missing_child','控制子节点不存在',tree_id,identity);return
                if identity in visited:return
                active.add(identity);visited.add(identity)
                if node['editor_id']!=identity:error('editor_id_mismatch','节点索引不一致',tree_id,identity)
                if identity in all_ids:error('duplicate_editor_id','编辑标识必须跨树唯一',tree_id,identity)
                all_ids.add(identity)
                registration=node['registration_id'];model=models['nodes'].get(registration)
                if not model or not model['editable']:error('unregistered_node','节点未注册或没有明确编辑语义',tree_id,identity)
                elif len(node['children'])<model['minimum_children'] or model['maximum_children']>=0 and len(node['children'])>model['maximum_children']:
                    error('invalid_child_count','子节点数量不符合实际节点语义',tree_id,identity)
                attrs={'ID'} if registration=='SubTree' else {'role','backend_instance','node_id'} if registration.startswith('Capability_') else set()
                if set(node['attributes'])-attrs:error('unsupported_attribute','不允许脚本、隐式重映射或未知语义属性',tree_id,identity)
                if registration.startswith('Capability_') and model:
                    role=node['attributes'].get('role');backend=node['attributes'].get('backend_instance')
                    if bool(role)==bool(backend):error('binding_required','必须且只能选择角色或后端实例',tree_id,identity)
                    elif role and role not in model.get('roles',[]):error('role_capability_mismatch','角色与能力不兼容',tree_id,identity,'role')
                    elif backend and backend not in model.get('backends',[]):error('backend_capability_missing','后端不提供该能力',tree_id,identity,'backend_instance')
                specs=self.port_specs(node,document,models)
                for port,value in node['ports'].items():
                    spec=specs.get(port)
                    if port in {'role','backend_instance','node_id'}:error('reserved_semantic_port','绑定身份必须通过语义属性声明',tree_id,identity,port);continue
                    if not spec:error('unknown_port','端口未注册',tree_id,identity,port);continue
                    if value['kind']=='blackboard_reference':
                        if not value.get('key') or value['key'].startswith('_'):error('invalid_blackboard_reference','引用必须为当前作用域变量',tree_id,identity,port)
                    elif isinstance(value.get('value'),str) and re.fullmatch(r'\{[^{}]+\}',value['value']):error('implicit_blackboard_reference','常量不能隐藏黑板引用',tree_id,identity,port)
                    elif spec.get('direction')=='OUTPUT':error('output_not_writable','输出端口只能绑定可写变量',tree_id,identity,port)
                    else:
                        if value.get('type') and not compatible(value['type'],{k:v for k,v in spec.items() if k in {'type','unit'}}):error('literal_type_mismatch','常量类型或单位不兼容',tree_id,identity,port)
                        try:
                            typ={k:spec[k] for k in ('type','unit','minimum','maximum','choices','frame_id','clock_domain','max_age_s') if spec.get(k) is not None}
                            # 通用位姿端口从数据来源取得完整契约
                            if spec['type'] in {'stamped_pose','target_list'} and 'frame_id' not in typ:
                                if not isinstance(value.get('value'),dict if spec['type']=='stamped_pose' else list):raise ValueError('位姿常量结构错误')
                            else:
                                parsed=parse(TypeDescriptor,typ);code,reason=scalar_error(parsed,value.get('value'))
                                if code:error(code,reason,tree_id,identity,port)
                            if spec['type'] in {'stamped_pose','target_list'}:
                                poses=[value.get('value')] if spec['type']=='stamped_pose' else value.get('value')
                                if not isinstance(poses,list):raise ValueError('目标列表必须为数组')
                                for item in poses:
                                    pose=parse(StampedPose,item)
                                    for field,actual,code in [('unit',pose.position_unit,'unit_mismatch'),('frame_id',pose.frame_id,'frame_mismatch'),('clock_domain',pose.clock_domain,'clock_mismatch')]:
                                        if spec.get(field) is not None and spec[field]!=actual:error(code,'位姿常量与端口契约不兼容',tree_id,identity,port)
                            elif spec['type']=='pick_result':parse(PickResult,value.get('value'))
                        except ContractValidationError as exc:
                            for issue in exc.issues:error(issue.code,issue.reason,tree_id,identity,port)
                        except ValueError:error('invalid_literal','常量不符合端口契约',tree_id,identity,port)
                for port,spec in specs.items():
                    if spec.get('required') and port not in node['ports'] and port not in {'role','backend_instance','node_id'}:
                        # 角色参数独立提供节点未覆盖的缺省值
                        role=self.context.bound.roles.get(node['attributes'].get('role'))
                        if not role or not port.startswith('param_') or port[6:] not in role.parameters:error('required_port','缺少必填端口',tree_id,identity,port)
                for child in node['children']:
                    if child in parents:error('multiple_parents','节点只能有一个控制父节点',tree_id,child)
                    parents[child]=identity;structure(child,depth+1)
                active.remove(identity)
            structure(tree['root_id'])
            if tree['root_id'] in parents:error('root_has_parent','根节点不能有父节点',tree_id,tree['root_id'])
            for identity in set(tree['nodes'])-visited:error('orphan_node','孤立节点需要重挂或删除',tree_id,identity)
        call_done=set()
        def calls(tree_id,stack):
            if tree_id in call_done:return
            if len(stack)>64:
                error('subtree_depth','子树调用过深',tree_id);return
            for node in trees[tree_id]['nodes'].values():
                if node['registration_id']!='SubTree':continue
                target=node['attributes'].get('ID')
                if target not in trees:error('missing_subtree','被调用子树不存在',tree_id,node['editor_id'],'ID')
                elif target in stack:error('recursive_subtree','所有子树定义均禁止递归',tree_id,node['editor_id'],'ID')
                else:calls(target,stack+[target])
            call_done.add(tree_id)
        for tree_id in trees:calls(tree_id,[tree_id])
        unsafe={'recursive_subtree','missing_subtree','subtree_depth','readonly_xml','unknown_main_tree','tree_too_large','control_cycle','tree_too_deep','missing_child','editor_id_mismatch','duplicate_editor_id','unregistered_node','multiple_parents','root_has_parent','orphan_node'}
        if any(d['code'] in unsafe for d in diagnostics):return {'valid':False,'diagnostics':diagnostics,'sources':sources}
        try:self.expanded(document)
        except (ContractValidationError,RecursionError) as exc:
            error('invalid_expansion',str(exc));return {'valid':False,'diagnostics':diagnostics,'sources':sources}
        def flow(tree_id,identity,environment,stack,depth=0):
            if depth>64:error('subtree_depth','子树展开过深',tree_id,identity);return environment
            node=trees[tree_id]['nodes'][identity];registration=node['registration_id'];specs=self.port_specs(node,document,models);env=copy.deepcopy(environment)
            for port,value in node['ports'].items():
                spec=specs.get(port,{})
                if spec.get('direction')!='OUTPUT' and value['kind']=='blackboard_reference':
                    source=env.get(value['key'])
                    if not source:error('undefined_variable','变量尚未由当前执行路径保证产生',tree_id,identity,port)
                    elif not compatible(source,spec):error('port_contract_mismatch','类型、单位、坐标系或时间域不兼容',tree_id,identity,port)
                    else:sources.append({'tree_id':tree_id,'editor_id':identity,'port':port,'key':value['key'],'type':{k:v for k,v in source.items() if k!='_producers'},'producers':source.get('_producers',[])})
            def output_values():
                for port,value in node['ports'].items():
                    spec=specs.get(port,{})
                    if spec.get('direction')=='OUTPUT' and value['kind']=='blackboard_reference':
                        out={k:spec[k] for k in ('type','unit','frame_id','clock_domain','max_age_s') if spec.get(k) is not None}
                        if registration in {'ForEachTarget','SelectTarget','TargetsFromPose'}:
                            source=node['ports'].get('targets' if registration!='TargetsFromPose' else 'target')
                            if source and source['kind']=='blackboard_reference' and source['key'] in env:
                                out={**env[source['key']], 'type':spec['type']}
                        out['_producers']=[{'tree_id':tree_id,'editor_id':identity,'port':port,'kind':'node_output'}]
                        env[value['key']]=out
            if registration=='SubTree':
                target=node['attributes'].get('ID')
                if target not in trees:error('missing_subtree','被调用子树不存在',tree_id,identity,'ID');return env
                if target in stack:error('recursive_subtree','子树调用图不允许递归',tree_id,identity,'ID');return env
                local={k:{**v['type'],'_producers':[{'tree_id':target,'port':k,'kind':'subtree_input'}]} for k,v in trees[target]['ports'].items() if v['direction']=='INPUT' and k in node['ports']}
                result=flow(target,trees[target]['root_id'],local,stack+[target],depth+1)
                for key,contract in trees[target]['ports'].items():
                    if contract['direction']=='OUTPUT':
                        if key not in result:error('subtree_output_not_guaranteed','子树没有保证生成声明的输出',tree_id,identity,key)
                        elif not compatible(result[key],contract['type']):error('subtree_port_type_mismatch','子树输出类型不兼容',tree_id,identity,key)
                output_values();return env
            if registration in {'Sequence','ReactiveSequence'}:
                for child in node['children']:env=flow(tree_id,child,env,stack,depth+1)
            elif registration in {'Fallback','ReactiveFallback'}:
                branches=[flow(tree_id,c,env,stack,depth+1) for c in node['children']]
                common=set.intersection(*(set(b) for b in branches)) if branches else set(env)
                env={k:copy.deepcopy(branches[0][k]) for k in common if all(compatible(b[k],branches[0][k]) for b in branches)}
                for key in env:
                    env[key]['_producers']=list({encoded(p):p for branch in branches for p in branch[key].get('_producers',[])}.values())
            elif registration=='Parallel':
                branches=[flow(tree_id,c,env,stack,depth+1) for c in node['children']]
                writes=[];reads=[];resources=[]
                def footprint(child):
                    n=trees[tree_id]['nodes'][child];spec=self.port_specs(n,document,models);r=set();w=set();locks={}
                    for key,value in n['ports'].items():
                        if value['kind']=='blackboard_reference':(w if spec.get(key,{}).get('direction')=='OUTPUT' else r).add(value['key'])
                    model=models['nodes'][n['registration_id']]
                    for lock in model.get('resources',[]):locks[lock['name']]=lock['access']
                    if n['registration_id']=='SubTree':
                        t=n['attributes']['ID'];inner=self.expanded({'main_tree_id':t,'trees':trees});pending=[inner]
                        while pending:
                            item=pending.pop();pending+=item['expanded_children']
                            for lock in models['nodes'][item['registration_id']].get('resources',[]):locks[lock['name']]=lock['access']
                    for c in n['children']:
                        cr,cw,cl=footprint(c);r|=cr;w|=cw;locks.update(cl)
                    return r,w,locks
                for child in node['children']:
                    r,w,l=footprint(child);reads.append(r);writes.append(w);resources.append(l)
                for i in range(len(branches)):
                    for j in range(i):
                        if writes[i]&(reads[j]|writes[j]) or writes[j]&reads[i]:error('parallel_blackboard_conflict','并发分支存在未定义的变量读写顺序',tree_id,identity)
                        if any(resources[i][k]=='exclusive' or resources[j][k]=='exclusive' for k in resources[i].keys()&resources[j].keys()):error('parallel_resource_conflict','并发分支争用独占设备资源',tree_id,identity)
                threshold=node['ports'].get('success_count',{}).get('value',-1)
                if threshold in {-1,len(branches)}:
                    for branch in branches:env.update(branch)
            elif registration=='ForEachTarget':
                before=copy.deepcopy(env);output_values()
                for child in node['children']:flow(tree_id,child,env,stack,depth+1)
                env=before
            elif registration=='Inverter':
                for child in node['children']:flow(tree_id,child,env,stack,depth+1)
            elif registration=='Repeat':
                cycles=node['ports'].get('num_cycles',{})
                fixed=cycles.get('kind')=='typed_literal' and isinstance(cycles.get('value'),int) and cycles['value']>0
                for child in node['children']:
                    branch=flow(tree_id,child,env,stack,depth+1)
                    if fixed:env=branch
            else:
                for child in node['children']:env=flow(tree_id,child,env,stack,depth+1)
                output_values()
            return env
        blackboard={}
        if policy=='tomato_picker':
            manifest=parse(__import__('agro_runtime.tasks',fromlist=['TaskManifest']).TaskManifest,__import__('agro_runtime.registry',fromlist=['read_document']).read_document(self.assets.template.with_suffix('.task.json')))
            from .registry import _values
            try:effective=_values(parameters,manifest.parameters,'$.parameters',parameters=True)
            except ContractValidationError as exc:
                for issue in exc.issues:error(issue.code,issue.reason,port=issue.path)
                effective={}
            for name,value in effective.items():blackboard[name]={'type':manifest.parameters[name].type,'unit':manifest.parameters[name].unit,'value':value}
            fixture=self.assets.builtin['metadata'];blackboard['calibration_offset_x']={'type':'number','unit':'m','value':fixture['translation_m'][0]}
        elif policy=='simulation_inspection':
            from .models import ParameterDescriptor
            from .registry import _values
            specs={k:parse(ParameterDescriptor,v) for k,v in document['inputs'].items()}
            try:
                effective=_values(parameters,specs,'$.parameters',parameters=True)
                for name,value in effective.items():blackboard[name]={'type':specs[name].type,'unit':specs[name].unit,'value':value}
            except ContractValidationError as exc:
                for issue in exc.issues:error(issue.code,issue.reason,port=issue.path)
        else:error('unknown_task_policy','任务策略不支持')
        main=document['main_tree_id'];initial={k:{**{a:v[a] for a in ('type','unit') if a in v},'_producers':[{'tree_id':main,'port':k,'kind':'task_input'}]} for k,v in blackboard.items()}
        flow(main,trees[main]['root_id'],initial,[main])
        stage_by_editor={};stage_by_instance={}
        try:
            canonical,instances=self.canonical(document)
            readonly_caps={'perception.detect_tomato','perception.detect_targets','manipulation.check_reachability','geometry.transform_pose','geometry.offset_pose','perception.verify_pick','perception.verify_place','manipulation.collection_pose'}
            if policy=='simulation_inspection':
                for node in instances:
                    model=models['nodes'][node['registration_id']]
                    backend=node['attributes'].get('backend_instance')
                    role=self.context.bound.roles.get(node['attributes'].get('role'))
                    backend=backend or (role.backend_instance if role else None)
                    package=self.context.registry.packages[self.context.bound.backends[backend].package_id] if backend else None
                    if model.get('capability_id') not in readonly_caps or not package or package.adapter_entrypoint!='agro_mock:create_adapter' or any(r['access']=='exclusive' for r in model.get('resources',[])):
                        error('inspection_side_effect_forbidden','查询策略仅允许模拟只读能力',node['tree_id'],node['editor_id'])
                if any(n['registration_id'] in {'ForEachTarget','MakePickResult'} for t in trees.values() for n in t['nodes'].values()):error('inspection_policy_violation','查询策略不允许采摘循环或结果记账')
            else:
                original=self.parse_xml(self.assets.template.read_text());expected,original_instances=self.canonical(original)
                if canonical!=expected:error('tomato_policy_violation','番茄任务必须保留有限候选、变换、采摘放置验证与记账执行结构')
                else:
                    for node,reference in zip(instances,original_instances):
                        stage=reference['attributes'].get('node_id');stage_by_editor[node['editor_id']]=stage
                        stage_by_instance[node['instance_path']]=stage
            # XML 可加载不能授权物理动作重入
            physical=any(models['nodes'][n['registration_id']].get('capability_id') not in readonly_caps for n in instances)
            if physical and any(n['registration_id'] in {'RetryUntilSuccessful','Repeat','ReactiveSequence','ReactiveFallback','Parallel'} for t in trees.values() for n in t['nodes'].values()):error('physical_reentry_forbidden','含副作用能力的重试、响应式重入或并发策略未开放')
        except (ContractValidationError,KeyError,RecursionError) as exc:error('invalid_expansion','子树无法安全展开 '+str(exc))
        result={'valid':not diagnostics,'diagnostics':diagnostics,'sources':sources,'model_digest':models['digest'],'system_snapshot_id':self.context.snapshot_id,'blackboard':blackboard,'stage_by_editor':stage_by_editor,'stage_by_instance':stage_by_instance}
        if result['valid'] and engine:
            try:
                compiled=self.serialize_xml(document);checked=self.engine(compiled['xml'],blackboard)
                result['node_mapping']=[{**n,'editor_id':n['name'],'stage':stage_by_instance.get(n['path'])} for n in checked['nodes']]
                result['xml_sha256']=hashlib.sha256(compiled['xml'].encode()).hexdigest()
            except ContractValidationError as exc:
                for issue in exc.issues:error(issue.code,issue.reason)
                result['valid']=False
        return result

    def extract_subtree(self,document,tree_id,editor_id,subtree_id,ports=None):
        document=parse(TreeDocument,document).model_dump(mode='json');identifier(editor_id)
        if subtree_id in document['trees']:fail('$.subtree_id','duplicate_tree_id','子树定义已存在')
        tree=document['trees'][tree_id];selected=set()
        def collect(identity):
            if identity in selected:fail('$.children','control_cycle','片段包含控制环')
            selected.add(identity)
            for child in tree['nodes'][identity]['children']:collect(child)
        collect(editor_id)
        boundary=self.boundary(document,tree_id,editor_id)
        if ports is None:return {'proposal':boundary,'requires_confirmation':True}
        normalized=lambda entries:{k:{'direction':v['direction'],'type':parse(TypeDescriptor,v['type']).model_dump(mode='json')} for k,v in entries.items()}
        if normalized(ports)!=normalized(boundary):fail('$.ports','subtree_boundary_mismatch','需要确认实际跨边界端口，不允许漏掉或伪造')
        extracted={key:tree['nodes'].pop(key) for key in selected};call_id=new_id()
        for node in tree['nodes'].values():node['children']=[call_id if child==editor_id else child for child in node['children']]
        if tree['root_id']==editor_id:tree['root_id']=call_id
        tree['nodes'][call_id]={'editor_id':call_id,'registration_id':'SubTree','children':[], 'attributes':{'ID':subtree_id}, 'ports':{key:{'kind':'blackboard_reference','key':key,'type':{},'value':None} for key in ports}}
        document['trees'][subtree_id]={'tree_id':subtree_id,'root_id':editor_id,'nodes':extracted,'ports':ports}
        return {'document':document,'call_id':call_id,'ports':ports}

    def create(self,xml=None,template='simulation_inspection'):
        if xml is None:xml=self.assets.template.read_text() if template=='tomato_picker' else '<root BTCPP_format="4" main_tree_to_execute="Inspection"><BehaviorTree ID="Inspection"><Sequence/></BehaviorTree></root>'
        document=self.parse_xml(xml);key='draft_'+uuid4().hex
        return self.store.put('tree_draft',key,{'id':key,'revision':1,'layout_revision':1,'policy':template,'base_snapshot_id':self.context.snapshot_id,'document':document,'layout':LayoutDocument().model_dump(mode='json'),'parameters':{},'validation':None,'published':None})

    def save(self,key,revision,layout_revision,document,layout,parameters):
        draft=self.store.get('tree_draft',key)
        if draft['document']['readonly'] and digest(document)!=digest(draft['document']):fail('$.document','readonly_xml','只读导入不能覆盖执行语义，请保留原 XML')
        if revision!=draft['revision'] or layout_revision!=draft['layout_revision']:fail('$.revision','revision_conflict','树或布局已被其他页面修改，请重新加载')
        document=parse(TreeDocument,document).model_dump(mode='json');layout=parse(LayoutDocument,layout).model_dump(mode='json')
        semantic_changed=digest(document)!=digest(draft['document']) or parameters!=draft['parameters']
        if semantic_changed:document['revision']=draft['document']['revision']+1
        layout['revision']=draft['layout_revision']+1
        return self.store.put('tree_draft',key,{**draft,'revision':revision+1,'layout_revision':layout_revision+1,'document':document,'layout':layout,'parameters':parameters,'validation':None if semantic_changed else draft['validation']})

    def validate_draft(self,key):
        draft=self.store.get('tree_draft',key)
        validation=self.validate_tree(draft['document'],draft['policy'],draft['parameters'])
        validation['revision']=draft['revision'];draft['validation']=validation
        self.store.put('tree_draft',key,draft);return validation

    def publish(self,key,revision,base_snapshot_id):
        draft=self.store.get('tree_draft',key)
        if revision!=draft['revision']:fail('$.revision','revision_conflict','发布草稿已改变')
        if base_snapshot_id!=self.context.snapshot_id or draft['base_snapshot_id']!=base_snapshot_id:fail('$.base_snapshot_id','snapshot_conflict','系统配置已改变，请核对新草稿')
        checked=self.validate_draft(key)
        if not checked['valid']:fail('$.tree','tree_publish_rejected',encoded(checked['diagnostics']))
        compiled=self.serialize_xml(draft['document']);key_definition='definition_'+uuid4().hex
        root=self.store.root/'plans'/key_definition;root.mkdir(parents=True)
        xml=root/'harvest.xml';xml.write_text(compiled['xml']);xml.chmod(0o400)
        if draft['policy']=='tomato_picker':
            from .registry import read_document
            manifest=read_document(self.assets.template.with_suffix('.task.json'))
            raw=(self.assets.example/'assets/camera_to_arm.json').read_bytes();asset_path=root/'camera_to_arm.json';asset_path.write_bytes(raw);asset_path.chmod(0o400)
            manifest['assets']['camera_to_arm']['path']='camera_to_arm.json'
        else:manifest={'kind':'simulation_inspection','assets':{},'parameters':draft['document']['inputs'],'max_targets':1,'max_recovery_attempts':0,'timeout_ms':30000}
        (root/'harvest.task.json').write_text(encoded(manifest));(root/'harvest.task.json').chmod(0o400)
        definition={'id':key_definition,'draft_id':key,'revision':revision,'system_snapshot_id':self.context.snapshot_id,'model_digest':checked['model_digest'],'document':draft['document'],'layout':draft['layout'],'xml':compiled['xml'],'xml_sha256':checked['xml_sha256'],'manifest':manifest,'parameters':draft['parameters'],'node_mapping':checked['node_mapping'],'blackboard':checked['blackboard'],'task_ref':str(xml),'immutable':True}
        definition['digest']=digest({k:v for k,v in definition.items() if k not in {'id','layout','task_ref'}})
        (root/'definition.json').write_text(encoded(definition));(root/'definition.json').chmod(0o400)
        self.store.put('tree_definition',key_definition,definition);draft['published']=key_definition;self.store.put('tree_draft',key,draft)
        return definition

    def definition_request(self,key,request_id):
        from .tasks import TaskStart
        definition=self.store.get('tree_definition',key)
        if definition['system_snapshot_id']!=self.context.snapshot_id or definition['model_digest']!=self.describe_nodes()['digest']:fail('$.definition','snapshot_conflict','发布定义与当前实际系统或节点模型不一致')
        path=Path(definition['task_ref']).resolve()
        if not path.is_relative_to((self.store.root/'plans'/key).resolve()):fail('$.definition','invalid_definition_path','定义路径不在受控目录')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=definition['xml_sha256']:fail('$.definition','definition_checksum_mismatch','不可变 XML 摘要已改变')
        checked=self.validate_tree(definition['document'],definition['manifest']['kind'],definition['parameters'])
        if not checked['valid']:fail('$.definition','definition_invalid',encoded(checked['diagnostics']))
        return TaskStart(task_ref=str(path),parameters=definition['parameters'],request_id=request_id)

    def frozen_definition(self,path):
        for definition in self.store.list('tree_definition'):
            if Path(definition['task_ref']).resolve()==Path(path).resolve():
                self.definition_request(definition['id'],'freeze_validation')
                if json.loads(Path(path).with_suffix('.task.json').read_text())!=definition['manifest']:
                    fail('$.definition','definition_checksum_mismatch','不可变任务清单已改变')
                return definition
        return None
