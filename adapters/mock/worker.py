"""模拟运行模块，不承担设备动作或控制网关"""
import asyncio
import signal


async def run():
    stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, stop)
    print('READY', flush=True)
    while not stopped:
        await asyncio.sleep(.02)


def main():
    asyncio.run(run())


if __name__ == '__main__':
    main()
