"""Reusable spatial/data operations, independent of any robot workspace."""
import math
import threading
import time
from collections import deque
from pathlib import Path

OPERATIONS = {
    'wait_stationary': '等待关节稳定',
    'transform_targets': '变换并关联空间目标',
    'bounded_pose_step': '计算有界位姿步进',
    'copy_fields': '整理数据字段',
}


def finite(value, name):
    result = float(value)
    if not math.isfinite(result): raise ValueError(name+' 必须为有限数值')
    return result


def matrix_quaternion(q):
    import numpy as np
    values=np.array([q[k] for k in ('x','y','z','w')],dtype=float)
    norm=np.linalg.norm(values)
    if not np.isfinite(values).all() or abs(norm-1)>.01:raise ValueError('旋转四元数无效')
    x,y,z,w=values/norm
    return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                     [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                     [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])


def stamp_ns(header):
    stamp=header['stamp']
    return int(stamp['sec'])*1000000000+int(stamp['nanosec'])


class DataContext:
    """Continuous TF history is retained across workflow steps in one isolated worker."""
    def __init__(self, domain):
        # Resolve the numerical dependency before any hardware modules are started
        import numpy
        import rclpy
        from rclpy.executors import MultiThreadedExecutor
        from tf2_ros import Buffer, TransformListener
        from rclpy.duration import Duration
        self.context=rclpy.context.Context();rclpy.init(context=self.context,domain_id=domain)
        self.node=rclpy.create_node('atil_data_operations',context=self.context)
        self.buffer=Buffer(cache_time=Duration(seconds=15),node=self.node)
        self.listener=TransformListener(self.buffer,self.node)
        self.executor=MultiThreadedExecutor(num_threads=2,context=self.context);self.executor.add_node(self.node)
        self.thread=threading.Thread(target=self.executor.spin,daemon=True);self.thread.start()
        self.lock=threading.Lock();self.joints={};self.subscriptions={};self.info={}

    def close(self):
        import rclpy
        self.executor.shutdown();self.thread.join(timeout=2);self.node.destroy_node();rclpy.shutdown(context=self.context)

    def watch_joints(self, topic):
        if topic in self.subscriptions:return
        from sensor_msgs.msg import JointState
        from rclpy.qos import qos_profile_sensor_data
        self.joints[topic]=deque(maxlen=300)
        def receive(message):
            with self.lock:self.joints[topic].append((time.monotonic(),message))
        self.subscriptions[topic]=self.node.create_subscription(JointState,topic,receive,qos_profile_sensor_data)

    def now(self):return self.node.get_clock().now().nanoseconds

    def transform(self, parent, child, stamp=None):
        from rclpy.time import Time
        from rclpy.duration import Duration
        moment=Time(seconds=int(stamp['sec']),nanoseconds=int(stamp['nanosec'])) if stamp else Time()
        tf=self.buffer.lookup_transform(parent,child,moment,timeout=Duration(seconds=.5))
        from rosidl_runtime_py.convert import message_to_ordereddict
        return dict(message_to_ordereddict(tf))

    def run(self, operation, payload, stop):
        if operation=='copy_fields':return payload
        return getattr(self,operation)(payload,stop)

    def wait_stationary(self,p,stop):
        topic=p.get('topic','/joint_states');self.watch_joints(topic)
        names=p.get('joint_names',[])
        if not names:raise ValueError('稳定判定需要明确关节名称')
        age=finite(p.get('max_age_s',.25),'反馈有效期');duration=finite(p.get('duration_s',.4),'稳定时间')
        speed=finite(p.get('velocity_limit',.01),'速度上限')
        if min(age,duration,speed)<=0:raise ValueError('稳定判定阈值必须大于零')
        deadline=time.monotonic()+finite(p.get('timeout_s',5),'等待时间')
        start=time.monotonic()
        while time.monotonic()<deadline:
            if stop.is_set():raise InterruptedError('数据处理已取消')
            with self.lock:messages=list(self.joints[topic])
            now=time.monotonic();quiet=True;last=None;since=None
            for received,msg in messages:
                stamp=msg.header.stamp.sec*10**9+msg.header.stamp.nanosec
                if received<start:continue
                values={name:(msg.position[i] if i<len(msg.position) else math.nan,msg.velocity[i] if i<len(msg.velocity) else math.nan) for i,name in enumerate(msg.name)}
                valid=all(name in values and all(math.isfinite(v) for v in values[name]) and abs(values[name][1])<=speed for name in names)
                valid=valid and stamp>0 and (last is None or stamp>last[0] and received-last[1]<=age)
                if last and valid:
                    dt=(stamp-last[0])/1e9
                    valid=all(name in last[2] and abs(values[name][0]-last[2][name][0])/dt<=speed for name in names)
                if valid:
                    if since is None:since=received
                else:since=None
                last=(stamp,received,values)
            if last and since is not None and now-since>=duration and now-last[1]<=age and 0<=(self.now()-last[0])/1e9<=age:
                parent=p.get('base_frame','');child=p.get('tcp_frame','')
                result={'after_ns':self.now(),'stationary':True}
                if parent and child:
                    tf=self.transform(parent,child)
                    if not 0<=(self.now()-stamp_ns(tf['header']))/1e9<=age:raise ValueError('工具位姿反馈已过期')
                    result['pose']={'header':tf['header'],'pose':{'position':tf['transform']['translation'],'orientation':tf['transform']['rotation']}}
                return result
            time.sleep(.02)
        raise TimeoutError('未获得连续、新鲜且稳定的关节反馈')

    def transform_targets(self,p,stop):
        import numpy as np
        import yaml
        data=p['observation'];header=data['header'];stamp=stamp_ns(header)
        if not data.get('success',True):raise ValueError(data.get('message','观测失败'))
        if stamp<int(p.get('after_ns',0)):
            attempt=int(p.get('attempt',0))+1
            if p.get('allow_refresh') and attempt<=int(p.get('max_refresh_attempts',5)):
                return {'target':{},'ready':False,'attempt':attempt}
            raise ValueError('观测图像早于本次静止确认，需要重新观测')
        if stamp<=0 or not 0<=(self.now()-stamp)/1e9<=finite(p.get('max_age_s',.5),'观测有效期'):raise ValueError('观测数据已过期')
        calibration=yaml.safe_load(Path(p['calibration_file']).read_text())
        parent=calibration['parent_frame'];camera=calibration['child_frame']
        if camera!=header['frame_id'] or parent!=p['tool_frame'] or calibration.get('stored_transform_convention')!='camera_to_gripper (^gripper T_camera)':
            raise ValueError('标定方向、工具坐标系或观测坐标系不一致')
        matrix=np.asarray(calibration['transform_matrix'],dtype=float)
        if matrix.shape!=(4,4) or not np.isfinite(matrix).all() or not np.allclose(matrix[3],[0,0,0,1],atol=1e-8) or not np.allclose(matrix[:3,:3].T@matrix[:3,:3],np.eye(3),atol=1e-6) or not np.isclose(np.linalg.det(matrix[:3,:3]),1,atol=1e-6):raise ValueError('标定矩阵不是有效刚体变换')
        tf=self.transform(p['base_frame'],parent,header['stamp'])['transform']
        transform=np.eye(4);transform[:3,:3]=matrix_quaternion(tf['rotation']);transform[:3,3]=[tf['translation'][k] for k in ('x','y','z')]
        matrix=transform@matrix
        context=p.get('tracking') or {};previous=context.get('target');label=context.get('label',p.get('label',''))
        candidates=[]
        for target in data.get('targets',[]):
            xyz=np.asarray([target['position'][k] for k in ('x','y','z')]+[1.],dtype=float)
            confidence=finite(target['confidence'],'置信度')
            if not np.isfinite(xyz).all() or xyz[2]<=0 or confidence<p.get('min_confidence',0):continue
            if label and target.get('semantic_label','').lower()!=label.lower():continue
            point=(matrix@xyz)[:3]
            score=float(np.linalg.norm(point-np.asarray(previous))) if previous is not None else -confidence
            candidates.append((score,point.tolist(),target.get('semantic_label','')))
        if not candidates:raise ValueError('没有满足条件的空间目标')
        score,point,label=min(candidates,key=lambda item:item[0])
        if previous is not None and score>p.get('max_target_jump_m',.03):raise ValueError('目标位置跳变，已拒绝切换目标')
        return {'target':{'point':point,'frame_id':p['base_frame'],'stamp':header['stamp'],'label':label},'ready':True,'attempt':0}

    def bounded_pose_step(self,p,stop):
        import numpy as np
        target=p['target'];pose=p['current_pose'];context=dict(p.get('tracking') or {})
        if p.get('base_frame') and p.get('tcp_frame'):
            tf=self.transform(p['base_frame'],p['tcp_frame'])
            pose={'header':tf['header'],'pose':{'position':tf['transform']['translation'],'orientation':tf['transform']['rotation']}}
        if target['frame_id']!=pose['header']['frame_id']:raise ValueError('目标与工具位姿坐标系不同')
        if not 0<=(self.now()-stamp_ns({'stamp':target['stamp']}))/1e9<=p.get('max_target_age_s',1):raise ValueError('目标位姿已过期')
        if not 0<=(self.now()-stamp_ns(pose['header']))/1e9<=p.get('max_pose_age_s',1):raise ValueError('当前工具位姿已过期')
        position=np.array([pose['pose']['position'][k] for k in ('x','y','z')]);point=np.array(target['point'])
        if not np.isfinite(position).all() or not np.isfinite(point).all():raise ValueError('目标包含非有限数值')
        if not context:context={'origin':position.tolist(),'orientation':pose['pose']['orientation'],'travel':0.,'steps':0}
        standoff=finite(p.get('standoff_m',.1),'安全距离');tolerance=finite(p.get('tolerance_m',.005),'误差阈值')
        step=finite(p.get('max_step_m',.01),'单步距离');limit=finite(p.get('max_travel_m',.25),'总距离')
        if not 0<tolerance<standoff or standoff<p.get('min_standoff_m',.05) or min(step,limit)<=0:raise ValueError('距离约束不合法')
        direction=matrix_quaternion(context['orientation'])[:,2]
        delta=point-direction*standoff-position;distance=float(np.linalg.norm(delta));done=distance<=tolerance
        if not done and context['steps']>=p.get('max_steps',30):raise ValueError('已达到最大步数，停止继续步进')
        length=0 if done else min(distance,step)
        if context['travel']+length>limit:raise ValueError('下一步超过累计运动距离上限')
        next_position=position+(delta/distance*length if distance else 0)
        context.update(target=target['point'],label=target['label'],travel=context['travel']+length,steps=context['steps']+(0 if done else 1))
        goal={'header':{'frame_id':target['frame_id'],'stamp':{'sec':0,'nanosec':0}},'pose':{'position':dict(zip(('x','y','z'),map(float,next_position))),'orientation':context['orientation']}}
        return {'goal':goal,'tracking':context,'done':done,'remaining_distance':distance,'steps':context['steps']}
