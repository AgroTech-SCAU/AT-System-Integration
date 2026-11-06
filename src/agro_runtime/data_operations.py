"""Generic ROS clock, TF and joint-stability operations."""
import math
import threading
import time
from collections import deque

OPERATIONS = {
    'wait_stationary': '等待关节稳定',
    'copy_fields': '整理数据字段',
}


def finite(value, name):
    result = float(value)
    if not math.isfinite(result): raise ValueError(name+' 必须为有限数值')
    return result


def stamp_ns(header):
    stamp=header['stamp']
    return int(stamp['sec'])*1000000000+int(stamp['nanosec'])


class DataContext:
    """Continuous TF history is retained across workflow steps in one isolated worker."""
    def __init__(self, domain):
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
        requested_names=set(names)
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
                if requested_names.isdisjoint(msg.name):continue
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
