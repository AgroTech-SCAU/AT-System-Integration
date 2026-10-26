"""Conservative definite-assignment analysis for hierarchical workflow paths."""


def check_dataflow(spec, behaviors):
    states = {state['id']: state for state in spec['states']}
    variables = spec.get('variables', {})
    diagnostics = {}

    def path(identity):
        result = []
        while identity:
            result.insert(0, identity)
            identity = states[identity].get('parent')
        return result

    def leaf(identity):
        while states[identity].get('initial'):
            identity = states[identity]['initial']
        return identity

    def ports(identity, phase):
        state = states[identity]
        reference = state.get(phase)
        behavior = behaviors.get(reference, {})
        if not reference or not behavior:
            return {}, {}, {}
        if reference.startswith('ros:'):
            return behavior.get('inputs', {}), behavior.get('outputs', {}), {}
        document = behavior.get('document', {})
        tree = document.get('trees', {}).get(document.get('main_tree_id'), {})
        inputs = document.get('inputs', {})
        defaults = {**{k:v['default'] for k,v in inputs.items() if 'default' in v}, **behavior.get('parameters', {})}
        return inputs, {k:v['type'] for k,v in tree.get('ports', {}).items() if v['direction']=='OUTPUT'}, defaults

    def phase(identity, name, available, *, produce=True, report=False):
        inputs, outputs, defaults = ports(identity, name)
        bindings = states[identity].get('bindings', {}).get(name, {})
        for port in inputs:
            variable = bindings.get('inputs', {}).get(port, port)
            # Runtime implicit mapping overrides a default whenever that variable exists
            required=states[identity].get(name,'').startswith('ros:') or inputs[port].get('required',False)
            if report and ((variable in variables and variable not in available) or (variable not in variables and port not in defaults and required)):
                diagnostics[(identity,name,port)] = {'state_id':identity,'phase':name,'path':'bindings.inputs.'+port,
                    'message':states[identity].get('label',identity)+' · '+port+' 的输入未由所有可达路径保证产生，请绑定上游输出或设置初值'}
        result = set(available)
        if produce:
            result.update(variable for port in outputs if (variable:=bindings.get('outputs', {}).get(port,port)) in variables)
        return result

    def enter(route, available, report=False):
        for identity in route:
            available = phase(identity, 'entry', available, report=report)
        return available

    start = leaf(spec['initial'])
    initial = {k for k,v in variables.items() if v is not None}
    incoming = {start:enter(path(start), initial)}

    def transfer(current, edge, available, report=False):
        source_path = path(current)
        if edge['source'] not in source_path or states[current].get('outcome'):
            return None
        result = set(available)
        for identity in source_path:
            _, outputs, _ = ports(identity,'do')
            mapping = states[identity].get('bindings',{}).get('do',{}).get('outputs',{})
            result -= {mapping.get(p,p) for p in outputs if mapping.get(p,p) in spec.get('variable_contracts',{})}
        if edge['event']=='completed':
            # Completion may bubble from a descendant, so only keep outputs guaranteed
            # regardless of which eligible ongoing behavior emitted it
            origins=[identity for identity in source_path[source_path.index(edge['source']):] if states[identity].get('do')]
            candidates=[]
            for origin in origins:
                phase(origin,'do',available,produce=False,report=report)
                candidates.append(phase(origin,'do',result))
            if candidates:result=set.intersection(*candidates)
        if edge['source']==edge['target']:
            return current, result
        target = leaf(edge['target']); destination = path(target)
        common = 0
        while common < min(len(source_path),len(destination)) and source_path[common]==destination[common]: common += 1
        for identity in reversed(source_path[common:]):
            result = phase(identity, 'exit', result, report=report)
        result = enter(destination[common:], result, report)
        return target,result

    # Only intersections can shrink an existing reachable configuration, so this converges
    changed = True
    while changed:
        changed = False
        for current, available in list(incoming.items()):
            for edge in spec['transitions']:
                value = transfer(current,edge,available)
                if value is None: continue
                target, produced = value
                updated = produced if target not in incoming else incoming[target] & produced
                if target not in incoming or updated != incoming[target]:
                    incoming[target]=updated;changed=True
    enter(path(start),initial,True)
    for current,available in incoming.items():
        for identity in path(current):
            if states[identity].get('do'): phase(identity,'do',available,produce=False,report=True)
        if states[current].get('outcome'):
            final=set(available)
            for identity in reversed(path(current)):final=phase(identity,'exit',final,report=True)
        for edge in spec['transitions']: transfer(current,edge,available,True)
    return list(diagnostics.values())
