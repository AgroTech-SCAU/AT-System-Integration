"""Explicit filesystem fields in robot documents, distinct from ROS names and data."""
import copy
from pathlib import Path
import os


def references(documents):
    def field(record, key, owner, packable=False):
        if isinstance(record.get(key),str) and record[key]:
            yield record,key,owner,packable
    def declared(record, owner):
        for path in record.get('path_fields',[]):
            parts=path.split('.');container=record
            try:
                for part in parts[:-1]:container=container[int(part)] if isinstance(container,list) else container[part]
                key=int(parts[-1]) if isinstance(container,list) else parts[-1]
                if isinstance(container[key],str):yield container,key,owner,True
            except (KeyError,IndexError,ValueError,TypeError):continue
    def task(record,owner):
        yield from declared(record,owner)
        if record.get('operation')=='transform_targets' and isinstance(record.get('payload'),dict):
            yield from field(record['payload'],'calibration_file',owner,True)
    for kind,rows in documents.items():
        for record in rows:
            owner=kind+':'+record['id']
            if kind in ('interface_workspace','interface_foundation'):
                yield from field(record,'path',owner)
            elif kind=='execution_environment':
                yield from field(record,'setup',owner)
                yield from field(record,'python',owner)
            elif kind=='subsystem_module':
                yield from declared(record,owner)
                values=record.get('parameter_files',[])
                for i,value in enumerate(values):
                    if isinstance(value,str):yield values,i,owner,True
                if record.get('kind')=='process' and record.get('argv') and str(record['argv'][0]).startswith('/'):
                    yield record['argv'],0,owner,False
                yield from field(record,'python',owner)
            elif kind=='ros_task':yield from task(record,owner)
            elif kind=='tree_definition':
                for frozen in record.get('ros_tasks',[]):yield from task(frozen,owner)


def encode_paths(documents, root):
    result=copy.deepcopy(documents)
    for container,key,_,_ in references(result):
        value=container[key]
        if value.startswith('/') and not value.startswith(('/usr/','/opt/','/bin/','/lib/')):
            container[key]='profile-path:'+os.path.relpath(value,root)
    return result


def relocate(documents, mapping):
    result=copy.deepcopy(documents)
    pairs=sorted(mapping.items(),key=lambda pair:len(pair[0]),reverse=True)
    for container,key,_,_ in references(result):
        value=container[key]
        for before,after in pairs:
            if value==before or value.startswith(before.rstrip('/')+'/'):
                container[key]=after.rstrip('/')+value[len(before.rstrip('/')):]
                break
    for value in result.get('execution_environment',[]):
        original=next((v for v in documents.get('execution_environment',[]) if v['id']==value['id']),{})
        if any(original.get(k)!=value.get(k) for k in ('python','setup')):value['signature']=''
    return result


def dependency_report(documents):
    result={}
    for container,key,owner,packable in references(documents):
        value=container[key]
        if not value.startswith('/'):continue
        item=result.setdefault(value,{'path':value,'exists':Path(value).exists(),'file':Path(value).is_file(),'packable':packable,'used_by':[]})
        item['packable']=item['packable'] and packable
        if owner not in item['used_by']:item['used_by'].append(owner)
    return list(result.values())
